from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    """
    Расширенный пользователь Django. Аккаунт нужен только для того, чтобы
    создавать квизы (организатор) или видеть свою историю (участник) —
    само подключение к живой игре по коду комнаты авторизации не требует,
    см. sessions_app.Participant.
    """

    class Role(models.TextChoices):
        ORGANIZER = "organizer", "Организатор"
        PLAYER = "player", "Участник"

    role = models.CharField(max_length=16, choices=Role.choices, default=Role.PLAYER)
    display_name = models.CharField(max_length=50, blank=True)

    def __str__(self):
        return self.username

    @property
    def name(self):
        return self.display_name or self.username


class SocialAccount(models.Model):
    """Привязка внешнего OAuth-аккаунта (Google/VK) к пользователю. Один
    пользователь может иметь по одной привязке на каждого провайдера —
    вход через любую из них ведёт на один и тот же локальный аккаунт."""

    class Provider(models.TextChoices):
        GOOGLE = "google", "Google"
        VK = "vk", "VK"

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="social_accounts")
    provider = models.CharField(max_length=16, choices=Provider.choices)
    provider_user_id = models.CharField(max_length=255)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["provider", "provider_user_id"], name="unique_social_identity"),
        ]

    def __str__(self):
        return f"{self.provider}:{self.provider_user_id} → {self.user}"
