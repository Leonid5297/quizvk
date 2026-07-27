from django.core.cache import cache
from django.db import transaction
from django.shortcuts import get_object_or_404
from rest_framework import filters, generics, permissions, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from .caching import (
    CATALOG_CACHE_TTL,
    CATEGORIES_CACHE_KEY,
    CATEGORIES_CACHE_TTL,
    catalog_cache_key,
    invalidate_catalog,
)
from .models import Answer, Category, Question, Quiz, Topic
from .permissions import IsOwnerOrReadOnlyPublic
from .serializers import CategorySerializer, QuestionSerializer, QuizListSerializer, QuizSerializer

ALLOWED_MEDIA_PREFIXES = ("image/", "video/", "audio/")


class CategoryViewSet(viewsets.ReadOnlyModelViewSet):
    """GET /api/categories/ — список категорий для выпадающего списка.
    Меняется крайне редко, поэтому список целиком лежит в кэше — см.
    quizzes/caching.py (инвалидация — при появлении реально новой категории)."""

    queryset = Category.objects.all()
    serializer_class = CategorySerializer
    permission_classes = [permissions.AllowAny]
    pagination_class = None

    def list(self, request, *args, **kwargs):
        cached = cache.get(CATEGORIES_CACHE_KEY)
        if cached is not None:
            return Response(cached)
        response = super().list(request, *args, **kwargs)
        cache.set(CATEGORIES_CACHE_KEY, response.data, CATEGORIES_CACHE_TTL)
        return response


class QuizViewSet(viewsets.ModelViewSet):
    permission_classes = [permissions.IsAuthenticated, IsOwnerOrReadOnlyPublic]
    filter_backends = [filters.SearchFilter]
    search_fields = ["title", "owner__username", "owner__display_name"]

    def get_serializer_class(self):
        if self.action in ("list", "catalog"):
            return QuizListSerializer
        return QuizSerializer

    def get_queryset(self):
        if self.action == "catalog":
            # Каталог — чужие публичные квизы: без своих же и без уже добавленных
            # себе ранее (иначе можно бесконечно клонировать один и тот же).
            already_cloned = Quiz.objects.filter(
                owner=self.request.user, cloned_from__isnull=False
            ).values_list("cloned_from_id", flat=True)
            return (
                Quiz.objects.filter(is_public=True)
                .exclude(owner=self.request.user)
                .exclude(id__in=already_cloned)
                .select_related("category", "owner")
            )
        # "Мои квизы" — свои + опубликованные всеми (для чтения по id, если понадобится)
        return Quiz.objects.filter(owner=self.request.user).select_related("category", "owner")

    def perform_create(self, serializer):
        serializer.save()
        invalidate_catalog()  # новый квиз мог сразу попасть в каталог (is_public=True)

    def perform_update(self, serializer):
        serializer.save()
        invalidate_catalog()  # title/category/is_public могли измениться

    def perform_destroy(self, instance):
        if instance.owner_id != self.request.user.id:
            raise PermissionDenied("Удалять можно только свои квизы.")
        instance.delete()
        invalidate_catalog()

    @action(detail=False, methods=["get"])
    def catalog(self, request):
        """GET /api/quizzes/catalog/?search=...&category=... — публичные квизы
        других организаторов, с поиском по словам и фильтром по категории.
        Читают часто и одно и то же чаще, чем меняют — короткий TTL кэш на
        комбинацию (search, category), см. quizzes/caching.py."""
        search = request.query_params.get("search", "")
        category = request.query_params.get("category", "")
        page_param = request.query_params.get("page", "1")
        cache_key = catalog_cache_key(request.user.id, search, category, page_param)
        cached = cache.get(cache_key)
        if cached is not None:
            return Response(cached)

        queryset = self.filter_queryset(self.get_queryset())
        if category and category.lower() not in ("все", "all"):
            queryset = queryset.filter(category__name=category)
        page = self.paginate_queryset(queryset)
        serializer = self.get_serializer(page or queryset, many=True)
        response = self.get_paginated_response(serializer.data) if page is not None else Response(serializer.data)
        cache.set(cache_key, response.data, CATALOG_CACHE_TTL)
        return response

    @action(detail=True, methods=["post"])
    def clone(self, request, pk=None):
        """POST /api/quizzes/{id}/clone/ — «Добавить себе» из каталога."""
        source = get_object_or_404(Quiz, pk=pk, is_public=True)
        with transaction.atomic():
            clone = Quiz.objects.create(
                owner=request.user,
                title=source.title,
                category=source.category,
                mode=source.mode,
                results_mode=source.results_mode,
                points_per_question=source.points_per_question,
                speed_bonus_enabled=source.speed_bonus_enabled,
                time_per_question=source.time_per_question,
                is_public=False,
                cloned_from=source,
            )
            for topic in source.topics.all():
                new_topic = Topic.objects.create(quiz=clone, title=topic.title, order=topic.order)
                for question in topic.questions.all():
                    new_question = Question.objects.create(
                        topic=new_topic,
                        text=question.text,
                        type=question.type,
                        media=question.media,
                        media_type=question.media_type,
                        time_limit=question.time_limit,
                        order=question.order,
                    )
                    for answer in question.answers.all():
                        Answer.objects.create(
                            question=new_question, text=answer.text, is_correct=answer.is_correct, order=answer.order
                        )
        invalidate_catalog()
        return Response(QuizSerializer(clone, context={"request": request}).data, status=201)


class QuestionMediaUploadView(APIView):
    """POST /api/questions/{id}/media/ — прикрепление фото/видео/аудио к
    конкретному вопросу (multipart), отдельно от создания самого квиза."""

    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request, pk):
        question = get_object_or_404(Question, pk=pk)
        if question.topic.quiz.owner_id != request.user.id:
            raise PermissionDenied("Редактировать можно только вопросы своих квизов.")

        file_obj = request.FILES.get("file")
        if not file_obj:
            raise ValidationError({"file": "Файл обязателен."})

        content_type = getattr(file_obj, "content_type", "") or ""
        if not content_type.startswith(ALLOWED_MEDIA_PREFIXES):
            raise ValidationError({"file": "Допустимы только изображения, видео или аудио."})

        if question.media:
            question.media.delete(save=False)
        question.media = file_obj
        question.media_type = content_type.split("/")[0]
        question.save(update_fields=["media", "media_type"])
        return Response(QuestionSerializer(question).data, status=201)

    def delete(self, request, pk):
        question = get_object_or_404(Question, pk=pk)
        if question.topic.quiz.owner_id != request.user.id:
            raise PermissionDenied("Редактировать можно только вопросы своих квизов.")
        if question.media:
            question.media.delete(save=False)
        question.media = None
        question.media_type = ""
        question.save(update_fields=["media", "media_type"])
        return Response(status=204)
