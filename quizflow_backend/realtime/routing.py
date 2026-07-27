from django.urls import re_path

from .consumers import GameConsumer

websocket_urlpatterns = [
    re_path(r"^ws/session/(?P<room_code>[A-Za-z0-9]+)/$", GameConsumer.as_asgi()),
]
