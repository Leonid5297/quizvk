from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.shortcuts import get_object_or_404
from rest_framework import generics, permissions, status
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from quizzes.models import Quiz

from .models import Participant, QuizSession
from .serializers import (
    JoinSessionSerializer,
    LeaderboardEntrySerializer,
    ParticipantSerializer,
    QuizSessionSerializer,
)


def broadcast_to_room(room_code, event, payload):
    """Разослать событие в комнату из обычного (синхронного) DRF-view —
    join идёт через REST, а не WebSocket, но уже подключённые по WS
    клиенты (лобби) должны увидеть нового участника сразу же."""
    layer = get_channel_layer()
    if layer is None:
        return
    async_to_sync(layer.group_send)(
        f"room_{room_code}", {"type": "room.event", "event": event, "payload": payload}
    )


class CreateSessionView(APIView):
    """POST /api/quizzes/{quiz_id}/sessions/ — организатор запускает комнату
    для своего квиза и получает код для участников."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, quiz_id):
        quiz = get_object_or_404(Quiz, pk=quiz_id)
        if quiz.owner_id != request.user.id:
            raise PermissionDenied("Запускать можно только свои квизы.")
        if quiz.questions_count == 0:
            raise ValidationError("В квизе нет вопросов.")

        session = QuizSession.objects.create(quiz=quiz, organizer=request.user)
        if session.organizer_playing:
            Participant.objects.create(
                session=session,
                user=request.user,
                nickname=request.user.name,
                is_organizer_player=True,
            )
        return Response(QuizSessionSerializer(session).data, status=201)


class SessionDetailView(generics.RetrieveAPIView):
    """GET /api/sessions/{room_code}/ — состояние лобби/игры (для
    переподключения; в реальном времени это дублирует WebSocket)."""

    serializer_class = QuizSessionSerializer
    permission_classes = [permissions.AllowAny]
    lookup_field = "room_code"
    lookup_url_kwarg = "room_code"
    queryset = QuizSession.objects.all().select_related("quiz").prefetch_related("participants")


class JoinSessionView(APIView):
    """POST /api/sessions/{room_code}/join/ — вход по коду и нику, без
    авторизации. Возвращает participant token для WebSocket-подключения."""

    permission_classes = [permissions.AllowAny]

    def post(self, request, room_code):
        session = get_object_or_404(QuizSession, room_code=room_code.upper())
        if session.status == QuizSession.Status.FINISHED:
            raise ValidationError("Квиз уже завершён.")

        serializer = JoinSessionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        nickname = serializer.validated_data["nickname"].strip()

        if Participant.objects.filter(session=session, nickname__iexact=nickname, is_active=True).exists():
            raise ValidationError({"nickname": "Это имя уже занято в этой комнате."})

        user = request.user if request.user.is_authenticated else None
        participant = Participant.objects.create(session=session, user=user, nickname=nickname)

        broadcast_to_room(
            session.room_code,
            "participant_joined",
            {"nickname": participant.nickname, "is_organizer_player": participant.is_organizer_player},
        )

        return Response(
            {
                "session": QuizSessionSerializer(session).data,
                "participant": ParticipantSerializer(participant).data,
            },
            status=201,
        )


class KickParticipantView(APIView):
    """POST /api/sessions/{room_code}/kick/  body: {"nickname": "..."}
    Организатор может выгнать участника и до старта, и во время игры —
    то же самое можно сделать событием 'kick' по WebSocket (предпочтительно,
    т.к. обновление приходит живым клиентам мгновенно)."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, room_code):
        session = get_object_or_404(QuizSession, room_code=room_code.upper())
        if session.organizer_id != request.user.id:
            raise PermissionDenied("Управлять комнатой может только организатор.")

        nickname = request.data.get("nickname")
        if not nickname:
            raise ValidationError({"nickname": "Обязательное поле."})

        participant = get_object_or_404(Participant, session=session, nickname__iexact=nickname, is_active=True)
        if participant.is_organizer_player:
            raise ValidationError("Нельзя выгнать самого себя.")
        participant.is_active = False
        participant.save(update_fields=["is_active"])

        broadcast_to_room(session.room_code, "participant_kicked", {"nickname": participant.nickname})
        return Response(status=204)


class ToggleOrganizerPlayingView(APIView):
    """POST /api/sessions/{room_code}/toggle-play/  body: {"playing": true|false}
    Организатор включает/выключает собственное участие в своём же квизе,
    пока комната ещё в лобби — своя строка Participant то появляется,
    то деактивируется, и это сразу видно остальным по WebSocket."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, room_code):
        session = get_object_or_404(QuizSession, room_code=room_code.upper())
        if session.organizer_id != request.user.id:
            raise PermissionDenied("Управлять комнатой может только организатор.")
        if session.status != QuizSession.Status.LOBBY:
            raise ValidationError("Переключать участие можно только до начала игры.")

        playing = bool(request.data.get("playing"))
        participant, _ = Participant.objects.get_or_create(
            session=session,
            is_organizer_player=True,
            defaults={"user": request.user, "nickname": request.user.name},
        )
        participant.is_active = playing
        participant.save(update_fields=["is_active"])

        session.organizer_playing = playing
        session.save(update_fields=["organizer_playing"])

        broadcast_to_room(
            session.room_code,
            "participant_joined" if playing else "participant_kicked",
            {"nickname": participant.nickname, "is_organizer_player": True},
        )
        return Response(QuizSessionSerializer(session).data)


class LeaderboardView(APIView):
    """GET /api/sessions/{room_code}/leaderboard/ — финальная таблица."""

    permission_classes = [permissions.AllowAny]

    def get(self, request, room_code):
        session = get_object_or_404(QuizSession, room_code=room_code.upper())
        participants = session.participants.filter(is_active=True).order_by("-score", "joined_at")
        return Response(
            {
                "session": QuizSessionSerializer(session).data,
                "leaderboard": LeaderboardEntrySerializer(participants, many=True).data,
            }
        )
