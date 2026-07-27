"""
Авторитетный игровой цикл комнаты. Один процесс = один словарь ROOMS,
общий для всех WebSocket-подключений этого процесса (участников и
организатора одной комнаты). Для продакшена с несколькими воркерами
игровой цикл нужно вынести в отдельный процесс/сервис (см. README) —
здесь это осознанное упрощение для учебного/демо-проекта.
"""

import asyncio
import time

from channels.db import database_sync_to_async
from channels.layers import get_channel_layer
from django.conf import settings
from django.db.models import F
from django.utils import timezone

from quizzes.models import Question, Quiz
from sessions_app.models import Participant, ParticipantAnswer, QuizSession

REVEAL_PAUSE = 2.5
STANDINGS_TIME = 20
POLL_INTERVAL = 0.5

ROOMS = {}  # room_code -> RoomEngine


def get_engine(room_code):
    room_code = room_code.upper()
    if room_code not in ROOMS:
        ROOMS[room_code] = RoomEngine(room_code)
    return ROOMS[room_code]


class RoomEngine:
    def __init__(self, room_code):
        self.room_code = room_code
        self.group = f"room_{room_code}"
        self.channel_layer = get_channel_layer()
        self.game_task = None
        self.answered_participant_ids = set()
        self.round_started_at = None
        self.skip_requested = False
        self.connection_count = 0

    # ─── низкоуровневая рассылка ────────────────────────────────────
    async def broadcast(self, event, payload):
        await self.channel_layer.group_send(
            self.group, {"type": "room.event", "event": event, "payload": payload}
        )

    # ─── подключение/отключение ─────────────────────────────────────
    async def on_connect(self):
        self.connection_count += 1

    async def on_disconnect(self):
        self.connection_count = max(0, self.connection_count - 1)
        if self.connection_count == 0 and self.game_task is None:
            ROOMS.pop(self.room_code, None)

    # ─── DB-хелперы (обёрнуты в database_sync_to_async) ─────────────
    @database_sync_to_async
    def _get_session(self):
        return QuizSession.objects.select_related("quiz").get(room_code=self.room_code)

    @database_sync_to_async
    def _active_participants(self, session):
        return list(session.participants.filter(is_active=True))

    @database_sync_to_async
    def _get_participant(self, session, token):
        return session.participants.filter(token=token, is_active=True).first()

    @database_sync_to_async
    def _save_answer(self, participant, question, payload, time_taken):
        answer_id = payload.get("answer_id")
        text_answer = (payload.get("text_answer") or "").strip()

        is_correct = False
        selected = None
        if question.type == Question.Type.TEXT:
            correct_answer = question.answers.filter(is_correct=True).first()
            is_correct = bool(correct_answer) and text_answer.lower() == correct_answer.text.strip().lower()
        elif answer_id is not None:
            selected = question.answers.filter(id=answer_id).first()
            is_correct = bool(selected and selected.is_correct)

        points = 0
        if is_correct:
            quiz = question.topic.quiz
            points = quiz.points_per_question
            if quiz.speed_bonus_enabled and time_taken is not None:
                time_limit = question.effective_time_limit()
                remaining = max(0.0, time_limit - time_taken)
                points += round((remaining / time_limit) * quiz.points_per_question)

        obj, _ = ParticipantAnswer.objects.update_or_create(
            participant=participant,
            question=question,
            defaults={
                "selected_answer": selected,
                "text_answer": text_answer,
                "is_correct": is_correct,
                "points_awarded": points,
                "time_taken": time_taken,
            },
        )
        if points:
            Participant.objects.filter(pk=participant.pk).update(score=participant.score + points)
        return obj

    @database_sync_to_async
    def _kick(self, session, nickname, requester_is_organizer):
        if not requester_is_organizer:
            return None
        participant = session.participants.filter(nickname__iexact=nickname, is_active=True).first()
        if not participant or participant.is_organizer_player:
            return None
        participant.is_active = False
        participant.save(update_fields=["is_active"])
        return participant

    @database_sync_to_async
    def _standings_snapshot(self, session):
        participants = session.participants.filter(is_active=True).order_by("-score", "joined_at")
        return [
            {"nickname": p.nickname, "score": p.score, "is_organizer_player": p.is_organizer_player}
            for p in participants
        ]

    @database_sync_to_async
    def _get_question(self, session, index):
        return session.ordered_questions()[index]

    @database_sync_to_async
    def _question_bundle(self, question):
        """Всё нужное о вопросе — одним синхронным вызовом, чтобы в
        асинхронном игровом цикле не было ни одного «голого» обращения
        к ORM (ленивая подгрузка FK/related из async-кода запрещена Django)."""
        quiz = question.topic.quiz
        answers = list(question.answers.all())
        media_url = None
        if question.media:
            # question.media.url — относительный путь (/media/...); в REST
            # его достраивает до абсолютного request.build_absolute_uri, но
            # здесь, в WS-консьюмере, обычного request нет — строим сами.
            media_url = f"{settings.BACKEND_BASE_URL.rstrip('/')}{question.media.url}"
        return {
            "time_limit": question.time_limit or quiz.time_per_question,
            "results_mode": quiz.results_mode,
            "public": {
                "id": question.id,
                "text": question.text,
                "type": question.type,
                "media_url": media_url,
                "media_type": question.media_type,
                "answers": (
                    [{"id": a.id, "text": a.text} for a in answers]
                    if question.type != Question.Type.TEXT else []
                ),
            },
            "correct_answer_ids": [a.id for a in answers if a.is_correct],
            "correct_text": answers[0].text if question.type == Question.Type.TEXT and answers else None,
        }

    # ─── входящие события от клиентов ───────────────────────────────
    async def handle_answer(self, participant_token, payload):
        session = await self._get_session()
        participant = await self._get_participant(session, participant_token)
        if not participant or session.phase != QuizSession.Phase.QUESTION:
            return
        if participant.id in self.answered_participant_ids:
            return  # уже ответил в этом раунде

        question = await self._get_question(session, session.current_question_index)
        time_taken = None
        if self.round_started_at is not None:
            time_taken = max(0.0, time.monotonic() - self.round_started_at)

        await self._save_answer(participant, question, payload, time_taken)
        self.answered_participant_ids.add(participant.id)

        active = await self._active_participants(session)
        await self.broadcast(
            "answered_count",
            {"answered": len(self.answered_participant_ids), "total": len(active)},
        )

    async def handle_kick(self, requester_token, requester_is_organizer, target_nickname):
        session = await self._get_session()
        participant = await self._kick(session, target_nickname, requester_is_organizer)
        if participant:
            self.answered_participant_ids.discard(participant.id)
            await self.broadcast("participant_kicked", {"nickname": participant.nickname})

    async def handle_skip(self, requester_is_organizer):
        if requester_is_organizer:
            self.skip_requested = True

    async def handle_start(self, requester_is_organizer):
        if not requester_is_organizer or self.game_task is not None:
            return
        self.game_task = asyncio.create_task(self._run_game())

    # ─── игровой цикл ────────────────────────────────────────────────
    async def _run_game(self):
        try:
            session = await self._get_session()
            await self._set_session_fields(session, status=QuizSession.Status.LIVE, started_at=timezone.now())
            await self.broadcast("quiz_started", {})

            questions = await database_sync_to_async(session.ordered_questions)()
            total = len(questions)

            for index, question in enumerate(questions):
                session = await self._get_session()  # свежий phase после возможных kick'ов
                bundle = await self._question_bundle(question)  # единственная точка доступа к ORM на вопрос
                time_limit = bundle["time_limit"]

                await self._set_session_fields(session, phase=QuizSession.Phase.QUESTION, current_question_index=index)

                self.answered_participant_ids = set()
                self.skip_requested = False
                self.round_started_at = time.monotonic()

                question_payload = dict(bundle["public"])
                question_payload["index"] = index
                question_payload["total"] = total
                question_payload["time_limit"] = time_limit
                await self.broadcast("question", question_payload)

                await self._wait_for_round_end(session, time_limit)

                await self._set_session_fields(session, phase=QuizSession.Phase.REVEAL)
                standings = await self._standings_snapshot(session)
                await self.broadcast(
                    "reveal",
                    {
                        "question_id": bundle["public"]["id"],
                        "correct_answer_ids": bundle["correct_answer_ids"],
                        "correct_text": bundle["correct_text"],
                        "standings": standings,
                    },
                )
                self.skip_requested = False
                await self._wait_up_to(REVEAL_PAUSE)

                if bundle["results_mode"] == Quiz.ResultsMode.AFTER_EACH:
                    await self._set_session_fields(session, phase=QuizSession.Phase.STANDINGS)
                    await self.broadcast("standings", {"standings": standings, "index": index, "total": total})
                    self.skip_requested = False
                    await self._wait_up_to(STANDINGS_TIME)

            await self._finish_game(session)
            await self.broadcast_finished(session)
        except Exception as exc:  # не даём исключению тихо похоронить таску
            await self.broadcast("error", {"detail": f"Игра прервана из-за ошибки сервера: {exc}"})
            raise
        finally:
            self.game_task = None

    async def _wait_for_round_end(self, session, time_limit):
        """Ждём либо истечения времени, либо ответов всех активных участников
        (кик посреди вопроса на лету уменьшает нужное количество)."""
        elapsed = 0.0
        while elapsed < time_limit:
            if self.skip_requested:
                return
            active = await self._active_participants(session)
            if active and len(self.answered_participant_ids) >= len(active):
                return
            await asyncio.sleep(POLL_INTERVAL)
            elapsed += POLL_INTERVAL

    async def _wait_up_to(self, seconds):
        elapsed = 0.0
        while elapsed < seconds:
            if self.skip_requested:
                return
            await asyncio.sleep(POLL_INTERVAL)
            elapsed += POLL_INTERVAL

    @database_sync_to_async
    def _set_session_fields(self, session, **fields):
        QuizSession.objects.filter(pk=session.pk).update(**fields)
        for key, value in fields.items():
            setattr(session, key, value)
        return session

    @database_sync_to_async
    def _finish_game(self, session):
        QuizSession.objects.filter(pk=session.pk).update(
            status=QuizSession.Status.FINISHED, phase=QuizSession.Phase.FINISHED, ended_at=timezone.now()
        )
        Quiz.objects.filter(pk=session.quiz_id).update(plays_count=F("plays_count") + 1)

    async def broadcast_finished(self, session):
        standings = await self._standings_snapshot(session)
        await self.broadcast("quiz_finished", {"standings": standings})
