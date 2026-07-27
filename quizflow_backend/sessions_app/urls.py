from django.urls import path

from .views import (
    CreateSessionView,
    JoinSessionView,
    KickParticipantView,
    LeaderboardView,
    SessionDetailView,
    ToggleOrganizerPlayingView,
)

urlpatterns = [
    path("quizzes/<int:quiz_id>/sessions/", CreateSessionView.as_view(), name="session-create"),
    path("sessions/<str:room_code>/", SessionDetailView.as_view(), name="session-detail"),
    path("sessions/<str:room_code>/join/", JoinSessionView.as_view(), name="session-join"),
    path("sessions/<str:room_code>/kick/", KickParticipantView.as_view(), name="session-kick"),
    path("sessions/<str:room_code>/toggle-play/", ToggleOrganizerPlayingView.as_view(), name="session-toggle-play"),
    path("sessions/<str:room_code>/leaderboard/", LeaderboardView.as_view(), name="session-leaderboard"),
]
