from django.db import transaction
from rest_framework import serializers

from .caching import invalidate_categories
from .models import Answer, Category, Question, Quiz, Topic


class CategorySerializer(serializers.ModelSerializer):
    class Meta:
        model = Category
        fields = ["id", "name"]


class AnswerSerializer(serializers.ModelSerializer):
    id = serializers.IntegerField(required=False)

    class Meta:
        model = Answer
        fields = ["id", "text", "is_correct", "order"]


class QuestionSerializer(serializers.ModelSerializer):
    id = serializers.IntegerField(required=False)
    answers = AnswerSerializer(many=True)
    media = serializers.FileField(read_only=True)

    class Meta:
        model = Question
        fields = ["id", "text", "type", "media", "media_type", "time_limit", "order", "answers"]

    def validate(self, attrs):
        answers = attrs.get("answers", [])
        qtype = attrs.get("type", Question.Type.SINGLE)
        if qtype == Question.Type.TEXT:
            if len(answers) != 1:
                raise serializers.ValidationError(
                    "У вопроса с типом 'text' должен быть ровно один принимаемый ответ."
                )
        else:
            if len(answers) < 2:
                raise serializers.ValidationError("Нужно минимум 2 варианта ответа.")
            if not any(a.get("is_correct") for a in answers):
                raise serializers.ValidationError("Отметьте хотя бы один правильный вариант.")
        return attrs


class TopicSerializer(serializers.ModelSerializer):
    id = serializers.IntegerField(required=False)
    questions = QuestionSerializer(many=True)

    class Meta:
        model = Topic
        fields = ["id", "title", "order", "questions"]

    def validate_questions(self, value):
        if not value:
            raise serializers.ValidationError("В теме должен быть хотя бы один вопрос.")
        return value


class QuizSerializer(serializers.ModelSerializer):
    """Основной сериализатор — принимает и отдаёт квиз целиком, вместе с
    вложенными темами/вопросами/ответами, как их собирает CreatorPage."""

    topics = TopicSerializer(many=True)
    category = serializers.CharField(allow_blank=False)
    owner = serializers.StringRelatedField(read_only=True)
    questions_count = serializers.ReadOnlyField()

    class Meta:
        model = Quiz
        fields = [
            "id", "title", "category", "mode", "results_mode", "status",
            "points_per_question", "speed_bonus_enabled", "time_per_question",
            "is_public", "plays_count", "questions_count",
            "owner", "created_at", "updated_at", "topics",
        ]
        read_only_fields = ["id", "owner", "plays_count", "created_at", "updated_at"]

    def validate_topics(self, value):
        if not value:
            raise serializers.ValidationError("В квизе должна быть хотя бы одна тема с вопросами.")
        return value

    def _resolve_category(self, name):
        category, created = Category.objects.get_or_create(name=name.strip())
        if created:
            invalidate_categories()
        return category

    @transaction.atomic
    def create(self, validated_data):
        topics_data = validated_data.pop("topics")
        category_name = validated_data.pop("category")
        quiz = Quiz.objects.create(
            owner=self.context["request"].user,
            category=self._resolve_category(category_name),
            **validated_data,
        )
        self._save_topics(quiz, topics_data)
        return quiz

    @transaction.atomic
    def update(self, instance, validated_data):
        topics_data = validated_data.pop("topics", None)
        category_name = validated_data.pop("category", None)
        if category_name:
            instance.category = self._resolve_category(category_name)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()
        if topics_data is not None:
            self._sync_topics(instance, topics_data)
        return instance

    def _save_topics(self, quiz, topics_data):
        for t_order, topic_data in enumerate(topics_data):
            questions_data = topic_data.pop("questions")
            topic_data.pop("id", None)
            topic = Topic.objects.create(quiz=quiz, order=t_order, title=topic_data.get("title", ""))
            for q_order, question_data in enumerate(questions_data):
                answers_data = question_data.pop("answers")
                question_data.pop("media", None)
                question_data.pop("order", None)
                question_data.pop("id", None)
                question = Question.objects.create(topic=topic, order=q_order, **question_data)
                for a_order, answer_data in enumerate(answers_data):
                    answer_data.pop("order", None)
                    answer_data.pop("id", None)
                    Answer.objects.create(question=question, order=a_order, **answer_data)

    # ── редактирование: сверяем по id вместо "удалить всё и пересоздать",
    # иначе у неизменённых вопросов терялось бы уже загруженное медиа —
    # оно живёт на конкретной строке Question, а не привязано к теме.
    def _sync_topics(self, quiz, topics_data):
        existing = {t.id: t for t in quiz.topics.all()}
        seen_ids = set()

        for t_order, topic_data in enumerate(topics_data):
            topic_id = topic_data.get("id")
            questions_data = topic_data.get("questions", [])
            if topic_id and topic_id in existing:
                topic = existing[topic_id]
                topic.title = topic_data.get("title", "")
                topic.order = t_order
                topic.save(update_fields=["title", "order"])
            else:
                topic = Topic.objects.create(quiz=quiz, order=t_order, title=topic_data.get("title", ""))
            seen_ids.add(topic.id)
            self._sync_questions(topic, questions_data)

        for tid, topic in existing.items():
            if tid not in seen_ids:
                topic.delete()

    def _sync_questions(self, topic, questions_data):
        existing = {q.id: q for q in topic.questions.all()}
        seen_ids = set()

        for q_order, question_data in enumerate(questions_data):
            qid = question_data.get("id")
            answers_data = question_data.get("answers", [])
            if qid and qid in existing:
                question = existing[qid]
                question.text = question_data["text"]
                question.type = question_data["type"]
                question.order = q_order
                question.save(update_fields=["text", "type", "order"])
            else:
                question = Question.objects.create(
                    topic=topic, order=q_order, text=question_data["text"], type=question_data["type"]
                )
            seen_ids.add(question.id)
            self._sync_answers(question, answers_data)

        for qid, question in existing.items():
            if qid not in seen_ids:
                if question.media:
                    question.media.delete(save=False)
                question.delete()

    def _sync_answers(self, question, answers_data):
        existing = {a.id: a for a in question.answers.all()}
        seen_ids = set()

        for a_order, answer_data in enumerate(answers_data):
            aid = answer_data.get("id")
            if aid and aid in existing:
                answer = existing[aid]
                answer.text = answer_data["text"]
                answer.is_correct = answer_data["is_correct"]
                answer.order = a_order
                answer.save(update_fields=["text", "is_correct", "order"])
            else:
                answer = Answer.objects.create(
                    question=question, order=a_order,
                    text=answer_data["text"], is_correct=answer_data["is_correct"],
                )
            seen_ids.add(answer.id)

        for aid, answer in existing.items():
            if aid not in seen_ids:
                answer.delete()

    def to_representation(self, instance):
        rep = super().to_representation(instance)
        rep["category"] = instance.category.name if instance.category else ""
        return rep


class QuizListSerializer(serializers.ModelSerializer):
    """Облегчённая версия для списков и каталога — без вложенных вопросов."""

    category = serializers.CharField(source="category.name", default="", read_only=True)
    owner_name = serializers.CharField(source="owner.name", read_only=True)
    questions_count = serializers.ReadOnlyField()

    class Meta:
        model = Quiz
        fields = [
            "id", "title", "category", "mode", "status", "is_public",
            "plays_count", "questions_count", "owner_name", "created_at", "updated_at",
        ]
