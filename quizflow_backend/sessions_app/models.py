import uuid

from django.conf import settings
from django.db import models

from quizzes.models import Answer, Question, Quiz

from .utils import generate_room_code


class QuizSession(models.Model):
    """Одна «комната» — конкретный запуск квиза организатором.
    Живое состояние (текущая фаза/вопрос/таймер) держит realtime.RoomEngine
    в памяти процесса; здесь хранится персистентный срез на случай
    переподключения и для истории/статистики."""

    class Status(models.TextChoices):
        LOBBY = "lobby", "Лобби"
        LIVE = "live", "Идёт игра"
        FINISHED = "finished", "Завершена"

    class Phase(models.TextChoices):
        LOBBY = "lobby", "Лобби"
        QUESTION = "question", "Вопрос"
        REVEAL = "reveal", "Показ ответа"
        STANDINGS = "standings", "Промежуточные результаты"
        FINISHED = "finished", "Финал"

    quiz = models.ForeignKey(Quiz, on_delete=models.CASCADE, related_name="sessions")
    organizer = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="hosted_sessions")
    room_code = models.CharField(max_length=8, unique=True, editable=False)

    status = models.CharField(max_length=16, choices=Status.choices, default=Status.LOBBY)
    phase = models.CharField(max_length=16, choices=Phase.choices, default=Phase.LOBBY)
    organizer_playing = models.BooleanField(default=True)
    current_question_index = models.PositiveIntegerField(default=0)

    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    ended_at = models.DateTimeField(null=True, blank=True)

    def save(self, *args, **kwargs):
        if not self.room_code:
            code = generate_room_code()
            while QuizSession.objects.filter(room_code=code).exists():
                code = generate_room_code()
            self.room_code = code
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.quiz.title} [{self.room_code}]"

    def ordered_questions(self):
        return list(
            Question.objects.filter(topic__quiz_id=self.quiz_id)
            .select_related("topic", "topic__quiz")
            .prefetch_related("answers")
            .order_by("topic__order", "order")
        )

    @property
    def total_questions(self):
        return Question.objects.filter(topic__quiz_id=self.quiz_id).count()


class Participant(models.Model):
    session = models.ForeignKey(QuizSession, on_delete=models.CASCADE, related_name="participants")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    nickname = models.CharField(max_length=20)
    # Публичный непредсказуемый идентификатор — используется вместо
    # автоинкрементного id при подключении по WebSocket и в ответах API,
    # чтобы участники не могли перебирать/угадывать id друг друга.
    token = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    is_organizer_player = models.BooleanField(default=False)
    score = models.PositiveIntegerField(default=0)
    is_active = models.BooleanField(default=True)  # False — выгнан организатором
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["session", "nickname"],
                condition=models.Q(is_active=True),
                name="unique_active_nickname_per_session",
            )
        ]
        ordering = ["-score", "joined_at"]

    def __str__(self):
        return f"{self.nickname} @ {self.session.room_code}"


class ParticipantAnswer(models.Model):
    participant = models.ForeignKey(Participant, on_delete=models.CASCADE, related_name="answers")
    question = models.ForeignKey(Question, on_delete=models.CASCADE, related_name="+")
    selected_answer = models.ForeignKey(Answer, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    text_answer = models.CharField(max_length=300, blank=True)
    is_correct = models.BooleanField(default=False)
    points_awarded = models.PositiveIntegerField(default=0)
    time_taken = models.FloatField(null=True, blank=True)  # секунд от начала вопроса
    answered_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["participant", "question"], name="one_answer_per_question")
        ]

    def __str__(self):
        return f"{self.participant.nickname} -> Q{self.question_id}"
