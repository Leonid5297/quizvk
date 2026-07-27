from rest_framework.routers import DefaultRouter

from django.urls import path

from .views import CategoryViewSet, QuestionMediaUploadView, QuizViewSet

router = DefaultRouter()
router.register("quizzes", QuizViewSet, basename="quiz")
router.register("categories", CategoryViewSet, basename="category")

urlpatterns = router.urls + [
    path("questions/<int:pk>/media/", QuestionMediaUploadView.as_view(), name="question-media"),
]
