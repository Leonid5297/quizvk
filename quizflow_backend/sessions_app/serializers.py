from rest_framework import serializers

from .models import Participant, ParticipantAnswer, QuizSession


class ParticipantSerializer(serializers.ModelSerializer):
    """С токеном — отдаётся ТОЛЬКО самому участнику в ответе на join,
    это его приватный ключ для WebSocket. Никогда не рассылать другим."""

    class Meta:
        model = Participant
        fields = ["id", "token", "nickname", "is_organizer_player", "score", "joined_at"]
        read_only_fields = fields


class PublicParticipantSerializer(serializers.ModelSerializer):
    """Без токена — безопасно показывать всем в комнате (список лобби и т.п.)."""

    class Meta:
        model = Participant
        fields = ["id", "nickname", "is_organizer_player", "score", "joined_at"]
        read_only_fields = fields


class QuizSessionSerializer(serializers.ModelSerializer):
    quiz_title = serializers.CharField(source="quiz.title", read_only=True)
    total_questions = serializers.ReadOnlyField()
    participants = serializers.SerializerMethodField()

    class Meta:
        model = QuizSession
        fields = [
            "id", "room_code", "quiz", "quiz_title", "status", "phase",
            "organizer_playing", "current_question_index", "total_questions",
            "created_at", "started_at", "ended_at", "participants",
        ]
        read_only_fields = [
            "id", "room_code", "status", "phase", "current_question_index",
            "created_at", "started_at", "ended_at",
        ]

    def get_participants(self, obj):
        active = obj.participants.filter(is_active=True).order_by("joined_at")
        return PublicParticipantSerializer(active, many=True).data


class JoinSessionSerializer(serializers.Serializer):
    nickname = serializers.CharField(max_length=20, min_length=2)


class LeaderboardEntrySerializer(serializers.ModelSerializer):
    correct_count = serializers.SerializerMethodField()

    class Meta:
        model = Participant
        fields = ["nickname", "score", "is_organizer_player", "correct_count"]

    def get_correct_count(self, obj):
        return obj.answers.filter(is_correct=True).count()
