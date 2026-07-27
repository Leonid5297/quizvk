import json

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import AccessToken

from sessions_app.models import Participant, QuizSession

from . import engine


class GameConsumer(AsyncWebsocketConsumer):
    """
    ws://.../ws/session/<room_code>/?token=<JWT access>          — организатор
    ws://.../ws/session/<room_code>/?participant=<participant token> — участник

    Протокол сообщений (JSON) описан в README проекта.
    """

    async def connect(self):
        self.room_code = self.scope["url_route"]["kwargs"]["room_code"].upper()
        query = dict(pair.split("=") for pair in self.scope["query_string"].decode().split("&") if "=" in pair)

        self.is_organizer = False
        self.participant_token = query.get("participant")

        jwt_token = query.get("token")
        if jwt_token:
            self.is_organizer = await self._check_organizer(jwt_token)

        if not self.is_organizer and not await self._valid_participant():
            await self.close(code=4001)  # неизвестный участник/токен
            return

        self.group_name = f"room_{self.room_code}"
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

        self.engine = engine.get_engine(self.room_code)
        await self.engine.on_connect()

    async def disconnect(self, close_code):
        if hasattr(self, "group_name"):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)
        if hasattr(self, "engine"):
            await self.engine.on_disconnect()

    async def receive(self, text_data=None, bytes_data=None):
        try:
            data = json.loads(text_data or "{}")
        except json.JSONDecodeError:
            return
        msg_type = data.get("type")

        if msg_type == "start":
            await self.engine.handle_start(self.is_organizer)
        elif msg_type == "answer":
            token = await self._current_participant_token()
            await self.engine.handle_answer(token, data.get("payload", {}))
        elif msg_type == "skip":
            await self.engine.handle_skip(self.is_organizer)
        elif msg_type == "kick":
            target = (data.get("payload") or {}).get("target_nickname")
            await self.engine.handle_kick(self.participant_token, self.is_organizer, target)

    # Обработчик group_send({"type": "room.event", ...}) — Channels сам
    # маршрутизирует по имени типа с заменой '.' на '_'.
    async def room_event(self, event):
        await self.send(text_data=json.dumps({"event": event["event"], "payload": event["payload"]}))

    # ─── проверки доступа ────────────────────────────────────────────
    @database_sync_to_async
    def _current_participant_token(self):
        """Для обычного участника токен неизменен (пришёл в query string).
        Для организатора — мог поменяться, если он включил/выключил
        собственное участие уже после подключения по WebSocket (тот же
        коннект держится всё время лобби), поэтому перечитываем на
        каждый ответ, а не доверяем значению на момент connect()."""
        if not self.is_organizer:
            return self.participant_token
        participant = Participant.objects.filter(
            session__room_code=self.room_code, is_organizer_player=True, is_active=True
        ).first()
        return str(participant.token) if participant else None

    @database_sync_to_async
    def _check_organizer(self, jwt_token):
        try:
            access = AccessToken(jwt_token)
        except TokenError:
            return False
        user_id = access.get("user_id")
        session = QuizSession.objects.filter(room_code=self.room_code, organizer_id=user_id).first()
        if not session:
            return False
        # Если организатор играет сам — у него тоже есть своя строка
        # Participant, и её токен нужен, чтобы его собственные ответы
        # засчитывались через тот же handle_answer, что и у всех остальных.
        own_participant = session.participants.filter(is_organizer_player=True, is_active=True).first()
        if own_participant:
            self.participant_token = str(own_participant.token)
        return True

    @database_sync_to_async
    def _valid_participant(self):
        if not self.participant_token:
            return False
        return Participant.objects.filter(
            session__room_code=self.room_code, token=self.participant_token, is_active=True
        ).exists()
