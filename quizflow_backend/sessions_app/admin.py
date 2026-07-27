from django.contrib import admin

from .models import Participant, ParticipantAnswer, QuizSession


class ParticipantInline(admin.TabularInline):
    model = Participant
    extra = 0
    readonly_fields = ["token", "joined_at"]


@admin.register(QuizSession)
class QuizSessionAdmin(admin.ModelAdmin):
    list_display = ["room_code", "quiz", "organizer", "status", "phase", "created_at"]
    list_filter = ["status", "phase"]
    search_fields = ["room_code", "quiz__title"]
    inlines = [ParticipantInline]


@admin.register(Participant)
class ParticipantAdmin(admin.ModelAdmin):
    list_display = ["nickname", "session", "score", "is_active", "is_organizer_player"]
    list_filter = ["is_active", "is_organizer_player"]


@admin.register(ParticipantAnswer)
class ParticipantAnswerAdmin(admin.ModelAdmin):
    list_display = ["participant", "question", "is_correct", "points_awarded", "time_taken"]
