import uuid

from django.conf import settings
from django.db import models


def question_media_path(instance, filename):
    return f"question_media/{instance.id or uuid.uuid4()}/{filename}"


class Category(models.Model):
    """Категория квиза. Организатор может ввести свою — see QuizSerializer,
    которая делает get_or_create вместо жёсткого списка."""

    name = models.CharField(max_length=80, unique=True)

    class Meta:
        ordering = ["name"]
        verbose_name_plural = "categories"

    def __str__(self):
        return self.name


class Quiz(models.Model):
    class Mode(models.TextChoices):
        SIMPLE = "simple", "Простой квиз"
        TOPICS = "topics", "Квиз с темами"

    class ResultsMode(models.TextChoices):
        AFTER_EACH = "after_each", "После каждого вопроса"
        AT_END = "at_end", "Только в конце квиза"

    class Status(models.TextChoices):
        DRAFT = "draft", "Черновик"
        PUBLISHED = "published", "Опубликован"

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="quizzes")
    title = models.CharField(max_length=200)
    category = models.ForeignKey(Category, on_delete=models.SET_NULL, null=True, related_name="quizzes")
    mode = models.CharField(max_length=16, choices=Mode.choices, default=Mode.SIMPLE)
    results_mode = models.CharField(max_length=16, choices=ResultsMode.choices, default=ResultsMode.AFTER_EACH)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.DRAFT)

    points_per_question = models.PositiveIntegerField(default=100)
    speed_bonus_enabled = models.BooleanField(default=True)
    time_per_question = models.PositiveSmallIntegerField(default=20)  # секунд

    # Каталог: квиз, добавленный себе из каталога, хранит ссылку на оригинал.
    is_public = models.BooleanField(default=False)
    cloned_from = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True, related_name="clones"
    )
    plays_count = models.PositiveIntegerField(default=0)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]

    def __str__(self):
        return self.title

    @property
    def questions_count(self):
        return Question.objects.filter(topic__quiz=self).count()


class Topic(models.Model):
    """Тема внутри квиза. В простом режиме у квиза ровно одна тема с
    пустым заголовком — фронтенд её просто не подписывает."""

    quiz = models.ForeignKey(Quiz, on_delete=models.CASCADE, related_name="topics")
    title = models.CharField(max_length=200, blank=True)
    order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["order", "id"]

    def __str__(self):
        return self.title or f"Тема #{self.order + 1} ({self.quiz.title})"


class Question(models.Model):
    class Type(models.TextChoices):
        SINGLE = "single", "Одиночный выбор"
        MULTIPLE = "multiple", "Множественный выбор"
        TEXT = "text", "Ввод текстом"

    class MediaType(models.TextChoices):
        NONE = "", "Без медиа"
        IMAGE = "image", "Фото"
        VIDEO = "video", "Видео"
        AUDIO = "audio", "Аудио"

    topic = models.ForeignKey(Topic, on_delete=models.CASCADE, related_name="questions")
    text = models.CharField(max_length=500)
    type = models.CharField(max_length=16, choices=Type.choices, default=Type.SINGLE)
    media = models.FileField(upload_to=question_media_path, blank=True, null=True)
    media_type = models.CharField(max_length=8, choices=MediaType.choices, blank=True, default="")
    time_limit = models.PositiveSmallIntegerField(null=True, blank=True)  # переопределение времени квиза
    order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["order", "id"]

    def __str__(self):
        return self.text[:60]

    def effective_time_limit(self):
        return self.time_limit or self.topic.quiz.time_per_question


class Answer(models.Model):
    """Вариант ответа. Для type=text у вопроса ровно один Answer с
    is_correct=True — это и есть принимаемый текстовый ответ."""

    question = models.ForeignKey(Question, on_delete=models.CASCADE, related_name="answers")
    text = models.CharField(max_length=300)
    is_correct = models.BooleanField(default=False)
    order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["order", "id"]

    def __str__(self):
        return self.text[:60]
