from django.contrib import admin

from .models import Answer, Category, Question, Quiz, Topic


class AnswerInline(admin.TabularInline):
    model = Answer
    extra = 0


class QuestionInline(admin.StackedInline):
    model = Question
    extra = 0


class TopicInline(admin.StackedInline):
    model = Topic
    extra = 0


@admin.register(Category)
class CategoryAdmin(admin.ModelAdmin):
    search_fields = ["name"]


@admin.register(Quiz)
class QuizAdmin(admin.ModelAdmin):
    list_display = ["title", "owner", "category", "mode", "status", "is_public", "plays_count"]
    list_filter = ["mode", "status", "is_public", "category"]
    search_fields = ["title", "owner__username"]
    inlines = [TopicInline]


@admin.register(Topic)
class TopicAdmin(admin.ModelAdmin):
    list_display = ["title", "quiz", "order"]
    inlines = [QuestionInline]


@admin.register(Question)
class QuestionAdmin(admin.ModelAdmin):
    list_display = ["text", "topic", "type", "media_type"]
    inlines = [AnswerInline]
