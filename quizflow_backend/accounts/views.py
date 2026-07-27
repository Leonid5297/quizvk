import secrets

from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.tokens import default_token_generator
from django.core.cache import cache
from django.core.mail import send_mail
from django.http import Http404, HttpResponseRedirect
from django.utils.encoding import force_bytes, force_str
from django.utils.http import urlsafe_base64_decode, urlsafe_base64_encode
from rest_framework import generics, permissions
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken

from .models import SocialAccount
from .oauth import PROVIDERS, OAuthError, generate_pkce_pair
from .serializers import (
    ChangePasswordSerializer,
    PasswordResetConfirmSerializer,
    PasswordResetRequestSerializer,
    ProfileUpdateSerializer,
    RegisterSerializer,
    UserSerializer,
)

User = get_user_model()


class RegisterView(generics.CreateAPIView):
    """POST /api/auth/register/ — создание аккаунта организатора или участника."""

    permission_classes = [permissions.AllowAny]
    serializer_class = RegisterSerializer

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        refresh = RefreshToken.for_user(user)
        return Response(
            {
                "user": UserSerializer(user).data,
                "access": str(refresh.access_token),
                "refresh": str(refresh),
            },
            status=201,
        )


class MeView(APIView):
    """GET /api/auth/me/ — профиль текущего пользователя.
    PATCH /api/auth/me/ — редактирование отображаемого имени/email."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        return Response(UserSerializer(request.user).data)

    def patch(self, request):
        serializer = ProfileUpdateSerializer(request.user, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(UserSerializer(request.user).data)


class LogoutView(APIView):
    """POST /api/auth/logout/ — добавляет refresh-токен в чёрный список."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        token = request.data.get("refresh")
        if not token:
            return Response({"detail": "Поле 'refresh' обязательно."}, status=400)
        try:
            RefreshToken(token).blacklist()
        except Exception:
            return Response({"detail": "Невалидный или уже отозванный токен."}, status=400)
        return Response(status=205)


class ChangePasswordView(APIView):
    """POST /api/auth/change-password/ — смена пароля залогиненным пользователем."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        serializer = ChangePasswordSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        request.user.set_password(serializer.validated_data["new_password"])
        request.user.save(update_fields=["password"])
        return Response({"detail": "Пароль изменён."})


class PasswordResetRequestView(APIView):
    """POST /api/auth/password-reset/ — {"email_or_username": "..."}.
    Всегда отвечает одинаковым 200-ответом, независимо от того, найден ли
    аккаунт — иначе по ответу можно перебором проверять, какие email/логины
    зарегистрированы."""

    permission_classes = [permissions.AllowAny]

    def post(self, request):
        serializer = PasswordResetRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        identifier = serializer.validated_data["email_or_username"].strip()

        user = (
            User.objects.filter(email__iexact=identifier).first()
            or User.objects.filter(username__iexact=identifier).first()
        )
        # Пользователям, зашедшим только через Google/VK (без пароля),
        # сброс пароля не предлагаем — им нечего сбрасывать, но по тому
        # же принципу не раскрываем это в ответе.
        if user and user.email and user.has_usable_password():
            self._send_reset_email(user)

        return Response(
            {"detail": "Если такой аккаунт существует, на него отправлено письмо со ссылкой для сброса пароля."}
        )

    def _send_reset_email(self, user):
        uid = urlsafe_base64_encode(force_bytes(user.pk))
        token = default_token_generator.make_token(user)
        reset_url = f"{settings.FRONTEND_PASSWORD_RESET_URL}?uid={uid}&token={token}"
        send_mail(
            subject="Восстановление пароля QuizVK",
            message=(
                "Чтобы задать новый пароль, перейдите по ссылке (действует 1 час):\n"
                f"{reset_url}\n\n"
                "Если вы не запрашивали сброс пароля — просто проигнорируйте это письмо."
            ),
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[user.email],
            fail_silently=True,
        )


class PasswordResetConfirmView(APIView):
    """POST /api/auth/password-reset/confirm/ — {"uid", "token", "new_password"}
    из ссылки в письме."""

    permission_classes = [permissions.AllowAny]

    def post(self, request):
        serializer = PasswordResetConfirmSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        try:
            user_pk = force_str(urlsafe_base64_decode(data["uid"]))
            user = User.objects.get(pk=user_pk)
        except (User.DoesNotExist, ValueError, TypeError, OverflowError):
            raise ValidationError({"detail": "Ссылка для сброса пароля недействительна."})

        if not default_token_generator.check_token(user, data["token"]):
            raise ValidationError({"detail": "Ссылка для сброса пароля недействительна или уже использована."})

        user.set_password(data["new_password"])
        user.save(update_fields=["password"])
        return Response({"detail": "Пароль успешно изменён."})


class OAuthStartView(APIView):
    """GET /api/auth/oauth/<provider>/start/ — редирект браузера на страницу
    авторизации провайдера. Открывается прямым переходом (ссылкой/кнопкой
    на фронтенде), а не через fetch — итог этого эндпоинта не JSON,
    а редирект."""

    permission_classes = [permissions.AllowAny]

    def get(self, request, provider):
        provider_cls = PROVIDERS.get(provider)
        if not provider_cls:
            raise Http404("Неизвестный OAuth-провайдер.")
        client = provider_cls()
        if not client.is_configured:
            return Response(
                {"detail": f"OAuth-провайдер «{provider}» не настроен на сервере (нет client_id в .env)."},
                status=503,
            )

        state = secrets.token_urlsafe(24)
        verifier, challenge = generate_pkce_pair()
        # code_verifier живёт в кэше (Redis в проде), а не в сессии/cookie —
        # не завязываемся на same-site cookies между фронтендом на другом
        # порте/домене и этим редиректом.
        cache.set(f"oauth_pkce:{provider}:{state}", verifier, timeout=600)
        return HttpResponseRedirect(client.build_authorize_url(state, challenge))


class OAuthCallbackView(APIView):
    """GET /api/auth/oauth/<provider>/callback/ — редирект от провайдера
    после согласия пользователя. Сам ничего не рендерит — редиректит
    браузер обратно на фронтенд с JWT-парой во fragment-части URL (после
    #, чтобы токены не улетали в access-логи сервера при последующих
    запросах со страницы)."""

    permission_classes = [permissions.AllowAny]

    def get(self, request, provider):
        provider_cls = PROVIDERS.get(provider)
        if not provider_cls:
            raise Http404("Неизвестный OAuth-провайдер.")

        callback_base = settings.FRONTEND_OAUTH_CALLBACK_URL
        error = request.query_params.get("error")
        code = request.query_params.get("code")
        state = request.query_params.get("state")

        if error or not code or not state:
            return HttpResponseRedirect(f"{callback_base}#error=access_denied")

        cache_key = f"oauth_pkce:{provider}:{state}"
        verifier = cache.get(cache_key)
        if not verifier:
            return HttpResponseRedirect(f"{callback_base}#error=expired")
        cache.delete(cache_key)

        client = provider_cls()
        callback_params = {"device_id": request.query_params.get("device_id", ""), "state": state}
        try:
            token_data = client.exchange_code(code, verifier, callback_params=callback_params)
            access_token = token_data.get("access_token")
            if not access_token:
                raise OAuthError("no access_token in provider response")
            user_info = client.fetch_user_info(access_token)
        except OAuthError:
            return HttpResponseRedirect(f"{callback_base}#error=provider_error")

        user = self._get_or_create_user(provider, user_info)
        refresh = RefreshToken.for_user(user)
        return HttpResponseRedirect(f"{callback_base}#access={refresh.access_token}&refresh={refresh}")

    def _get_or_create_user(self, provider, info):
        social = (
            SocialAccount.objects.filter(provider=provider, provider_user_id=info["provider_user_id"])
            .select_related("user")
            .first()
        )
        if social:
            return social.user

        email = (info.get("email") or "").strip()
        # Существующий аккаунт с тем же email — считаем тем же человеком
        # (email от Google/VK приходит уже подтверждённым провайдером) и
        # просто привязываем новую соцсеть к нему, а не заводим дубликат.
        user = User.objects.filter(email__iexact=email).first() if email else None
        if not user:
            base_username = email or f"{provider}_{info['provider_user_id']}"
            username = base_username
            suffix = 1
            while User.objects.filter(username=username).exists():
                suffix += 1
                username = f"{base_username}_{suffix}"
            user = User(username=username, email=email, display_name=info.get("name", ""), role=User.Role.ORGANIZER)
            user.set_unusable_password()
            user.save()

        SocialAccount.objects.create(user=user, provider=provider, provider_user_id=info["provider_user_id"])
        return user
