from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.contrib.auth.tokens import default_token_generator
from django.core import mail
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode
from rest_framework.test import APIClient

from .models import SocialAccount

User = get_user_model()


class PasswordResetTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(
            username="reset_user", email="reset@example.com", password="OldPass123!"
        )

    def test_reset_request_sends_email_for_existing_user(self):
        response = self.client.post(
            "/api/auth/password-reset/", {"email_or_username": "reset@example.com"}, format="json"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("reset-password", mail.outbox[0].body)

    def test_reset_request_same_response_for_unknown_account(self):
        """Ответ не должен отличаться в зависимости от того, найден ли
        аккаунт — иначе перебором можно узнавать зарегистрированные email."""
        known = self.client.post(
            "/api/auth/password-reset/", {"email_or_username": "reset@example.com"}, format="json"
        )
        unknown = self.client.post(
            "/api/auth/password-reset/", {"email_or_username": "nobody@example.com"}, format="json"
        )
        self.assertEqual(known.status_code, unknown.status_code)
        self.assertEqual(known.json()["detail"], unknown.json()["detail"])
        self.assertEqual(len(mail.outbox), 1)  # только известному пользователю реально ушло письмо

    def test_reset_confirm_with_valid_token(self):
        uid = urlsafe_base64_encode(force_bytes(self.user.pk))
        token = default_token_generator.make_token(self.user)
        response = self.client.post(
            "/api/auth/password-reset/confirm/",
            {"uid": uid, "token": token, "new_password": "BrandNewPass456!"},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password("BrandNewPass456!"))

    def test_reset_confirm_with_invalid_token_rejected(self):
        uid = urlsafe_base64_encode(force_bytes(self.user.pk))
        response = self.client.post(
            "/api/auth/password-reset/confirm/",
            {"uid": uid, "token": "garbage-token", "new_password": "BrandNewPass456!"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password("OldPass123!"))  # не поменялся

    def test_reset_token_cannot_be_reused(self):
        uid = urlsafe_base64_encode(force_bytes(self.user.pk))
        token = default_token_generator.make_token(self.user)
        first = self.client.post(
            "/api/auth/password-reset/confirm/",
            {"uid": uid, "token": token, "new_password": "FirstReset123!"},
            format="json",
        )
        second = self.client.post(
            "/api/auth/password-reset/confirm/",
            {"uid": uid, "token": token, "new_password": "SecondReset456!"},
            format="json",
        )
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 400)

    def test_oauth_only_user_without_password_gets_no_email(self):
        oauth_user = User.objects.create(username="oauth_only", email="oauth@example.com")
        oauth_user.set_unusable_password()
        oauth_user.save()
        response = self.client.post(
            "/api/auth/password-reset/", {"email_or_username": "oauth@example.com"}, format="json"
        )
        self.assertEqual(response.status_code, 200)  # тот же общий ответ
        self.assertEqual(len(mail.outbox), 0)  # но письмо не ушло — нечего сбрасывать


class ChangePasswordTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="change_user", password="OldPass123!")
        self.client.force_authenticate(user=self.user)

    def test_change_password_wrong_old_password_rejected(self):
        response = self.client.post(
            "/api/auth/change-password/",
            {"old_password": "wrong", "new_password": "NewPass456!"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    def test_change_password_success(self):
        response = self.client.post(
            "/api/auth/change-password/",
            {"old_password": "OldPass123!", "new_password": "NewPass456!"},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password("NewPass456!"))

    def test_change_password_requires_auth(self):
        anon_client = APIClient()
        response = anon_client.post(
            "/api/auth/change-password/",
            {"old_password": "OldPass123!", "new_password": "NewPass456!"},
            format="json",
        )
        self.assertEqual(response.status_code, 401)


class ProfileTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="profile_user", password="Pass123!", email="p@example.com")
        self.client.force_authenticate(user=self.user)

    def test_patch_display_name(self):
        response = self.client.patch("/api/auth/me/", {"display_name": "Новое Имя"}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["display_name"], "Новое Имя")
        self.assertEqual(response.json()["name"], "Новое Имя")

    def test_username_is_read_only(self):
        response = self.client.patch("/api/auth/me/", {"username": "hacked_name"}, format="json")
        self.assertEqual(response.status_code, 200)
        self.user.refresh_from_db()
        self.assertEqual(self.user.username, "profile_user")  # не изменился

    def test_linked_providers_reflects_social_accounts(self):
        SocialAccount.objects.create(user=self.user, provider="google", provider_user_id="123")
        response = self.client.get("/api/auth/me/")
        self.assertEqual(response.json()["linked_providers"], ["google"])


@override_settings(GOOGLE_OAUTH_CLIENT_ID="test-client-id", GOOGLE_OAUTH_CLIENT_SECRET="test-secret")
class OAuthStartTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        cache.clear()

    def test_unknown_provider_404(self):
        response = self.client.get("/api/auth/oauth/facebook/start/")
        self.assertEqual(response.status_code, 404)

    def test_unconfigured_provider_returns_503(self):
        # VK не настроен в этом тесте (нет override_settings для него)
        response = self.client.get("/api/auth/oauth/vk/start/")
        self.assertEqual(response.status_code, 503)

    def test_configured_provider_redirects_with_pkce(self):
        response = self.client.get("/api/auth/oauth/google/start/")
        self.assertEqual(response.status_code, 302)
        location = response["Location"]
        self.assertTrue(location.startswith("https://accounts.google.com/o/oauth2/v2/auth?"))
        self.assertIn("code_challenge=", location)
        self.assertIn("code_challenge_method=S256", location)
        self.assertIn("client_id=test-client-id", location)

        # code_verifier должен быть сохранён в кэше под тем же state
        state = location.split("state=")[1].split("&")[0]
        self.assertIsNotNone(cache.get(f"oauth_pkce:google:{state}"))


@override_settings(
    GOOGLE_OAUTH_CLIENT_ID="test-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET="test-secret",
    FRONTEND_URL="http://localhost:5173",
)
class OAuthCallbackTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        cache.clear()

    def _seed_pkce(self, provider="google", state="teststate123"):
        cache.set(f"oauth_pkce:{provider}:{state}", "test-verifier", timeout=600)
        return state

    def test_missing_code_redirects_with_error(self):
        response = self.client.get("/api/auth/oauth/google/callback/?state=abc")
        self.assertEqual(response.status_code, 302)
        self.assertIn("#error=access_denied", response["Location"])

    def test_provider_error_param_redirects_with_error(self):
        response = self.client.get("/api/auth/oauth/google/callback/?error=access_denied&state=abc")
        self.assertIn("#error=access_denied", response["Location"])

    def test_unknown_or_expired_state_redirects_with_error(self):
        response = self.client.get("/api/auth/oauth/google/callback/?code=abc123&state=never-issued")
        self.assertIn("#error=expired", response["Location"])

    @patch("accounts.oauth.GoogleOAuth.fetch_user_info")
    @patch("accounts.oauth.GoogleOAuth.exchange_code")
    def test_successful_login_creates_new_user(self, mock_exchange, mock_userinfo):
        state = self._seed_pkce()
        mock_exchange.return_value = {"access_token": "fake-access-token"}
        mock_userinfo.return_value = {
            "provider_user_id": "google-uid-1",
            "email": "newuser@example.com",
            "name": "New User",
        }

        response = self.client.get(f"/api/auth/oauth/google/callback/?code=authcode&state={state}")

        self.assertEqual(response.status_code, 302)
        location = response["Location"]
        self.assertTrue(location.startswith("http://localhost:5173/oauth-callback#"))
        self.assertIn("access=", location)
        self.assertIn("refresh=", location)

        user = User.objects.get(email="newuser@example.com")
        self.assertEqual(user.display_name, "New User")
        self.assertFalse(user.has_usable_password())
        social = SocialAccount.objects.get(user=user)
        self.assertEqual(social.provider, "google")
        self.assertEqual(social.provider_user_id, "google-uid-1")

        # code_verifier одноразовый — должен быть удалён из кэша после использования
        self.assertIsNone(cache.get(f"oauth_pkce:google:{state}"))

    @patch("accounts.oauth.GoogleOAuth.fetch_user_info")
    @patch("accounts.oauth.GoogleOAuth.exchange_code")
    def test_second_login_reuses_existing_user_not_duplicate(self, mock_exchange, mock_userinfo):
        mock_exchange.return_value = {"access_token": "fake-access-token"}
        mock_userinfo.return_value = {
            "provider_user_id": "google-uid-2",
            "email": "repeat@example.com",
            "name": "Repeat User",
        }

        state1 = self._seed_pkce(state="state-one")
        self.client.get(f"/api/auth/oauth/google/callback/?code=code1&state={state1}")
        state2 = self._seed_pkce(state="state-two")
        self.client.get(f"/api/auth/oauth/google/callback/?code=code2&state={state2}")

        self.assertEqual(User.objects.filter(email="repeat@example.com").count(), 1)
        self.assertEqual(SocialAccount.objects.filter(provider_user_id="google-uid-2").count(), 1)

    @patch("accounts.oauth.GoogleOAuth.fetch_user_info")
    @patch("accounts.oauth.GoogleOAuth.exchange_code")
    def test_existing_email_gets_linked_not_duplicated(self, mock_exchange, mock_userinfo):
        """Если человек уже регистрировался обычным логином/паролем с тем
        же email, вход через Google должен привязаться к тому же аккаунту,
        а не создать второго пользователя с тем же email."""
        existing = User.objects.create_user(
            username="already_here", email="shared@example.com", password="Pass123!"
        )
        mock_exchange.return_value = {"access_token": "fake-access-token"}
        mock_userinfo.return_value = {
            "provider_user_id": "google-uid-3",
            "email": "shared@example.com",
            "name": "Shared Name",
        }

        state = self._seed_pkce(state="state-link")
        response = self.client.get(f"/api/auth/oauth/google/callback/?code=code3&state={state}")

        self.assertEqual(response.status_code, 302)
        self.assertEqual(User.objects.filter(email="shared@example.com").count(), 1)
        social = SocialAccount.objects.get(provider_user_id="google-uid-3")
        self.assertEqual(social.user_id, existing.id)
        # у существующего пользователя пароль не тронут
        existing.refresh_from_db()
        self.assertTrue(existing.check_password("Pass123!"))

    @patch("accounts.oauth.GoogleOAuth.exchange_code")
    def test_provider_http_failure_redirects_gracefully(self, mock_exchange):
        from .oauth import OAuthError

        mock_exchange.side_effect = OAuthError("network broke")
        state = self._seed_pkce()
        response = self.client.get(f"/api/auth/oauth/google/callback/?code=authcode&state={state}")
        self.assertIn("#error=provider_error", response["Location"])
