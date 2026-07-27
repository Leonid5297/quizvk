"""
Django settings for the QuizVK backend.
Все параметры окружения читаются из .env (см. .env.example) — так что
для локального запуска ничего в этом файле менять не нужно.
"""

import os
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def env_bool(name, default=False):
    return os.environ.get(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


def env_list(name, default=""):
    raw = os.environ.get(name, default)
    return [item.strip() for item in raw.split(",") if item.strip()]


SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "dev-insecure-secret-key-change-me")
DEBUG = env_bool("DJANGO_DEBUG", True)
ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1")

INSTALLED_APPS = [
    "daphne",  # должен идти первым — подменяет runserver на ASGI-версию
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "rest_framework_simplejwt",
    "rest_framework_simplejwt.token_blacklist",
    "corsheaders",
    "django_filters",
    "channels",
    "accounts",
    "quizzes",
    "sessions_app",
    "realtime",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

# ─── База данных ──────────────────────────────────────────────────
# SQLite из коробки — ничего не нужно поднимать, чтобы просто запустить
# проект. Для Postgres задайте DATABASE_URL-подобные переменные в .env
# и раскомментируйте блок ниже (или используйте dj-database-url).
if os.environ.get("POSTGRES_DB"):
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": os.environ["POSTGRES_DB"],
            "USER": os.environ.get("POSTGRES_USER", "postgres"),
            "PASSWORD": os.environ.get("POSTGRES_PASSWORD", ""),
            "HOST": os.environ.get("POSTGRES_HOST", "localhost"),
            "PORT": os.environ.get("POSTGRES_PORT", "5432"),
        }
    }
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": BASE_DIR / "db.sqlite3",
        }
    }

AUTH_USER_MODEL = "accounts.User"

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 8}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "ru"
TIME_ZONE = os.environ.get("DJANGO_TIME_ZONE", "Europe/Moscow")
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

# Обычные DRF-эндпоинты сами строят абсолютный URL медиа из request
# (request.build_absolute_uri). У WebSocket-консьюмера такого request нет —
# realtime/engine.py использует это значение, чтобы медиа-ссылки в событиях
# игры (question.media_url) тоже были абсолютными, а не вида "/media/...",
# которое браузер резолвил бы от адреса фронтенда, а не бэкенда.
BACKEND_BASE_URL = os.environ.get("BACKEND_BASE_URL", "http://localhost:8000")

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# ─── DRF / JWT ─────────────────────────────────────────────────────
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.PageNumberPagination",
    "PAGE_SIZE": 20,
    "DEFAULT_FILTER_BACKENDS": ["django_filters.rest_framework.DjangoFilterBackend"],
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(hours=1),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=14),
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,
    "AUTH_HEADER_TYPES": ("Bearer",),
}

# ─── CORS ──────────────────────────────────────────────────────────
# React-фронтенд обычно крутится на другом порте (5173/3000) — в деве
# просто разрешаем всё; в проде задайте CORS_ALLOWED_ORIGINS в .env.
CORS_ALLOW_ALL_ORIGINS = env_bool("CORS_ALLOW_ALL_ORIGINS", DEBUG)
CORS_ALLOWED_ORIGINS = env_list("CORS_ALLOWED_ORIGINS")

# ─── Channels (WebSocket) ────────────────────────────────────────
# In-memory слой — годится для одного процесса (руками так и запускаем
# в деве). Для нескольких воркеров/машин переключитесь на channels_redis:
#   CHANNEL_LAYERS = {"default": {"BACKEND": "channels_redis.core.RedisChannelLayer",
#                                  "CONFIG": {"hosts": [os.environ.get("REDIS_URL", "redis://localhost:6379/0")]}}}
CHANNEL_LAYERS = {
    "default": {"BACKEND": "channels.layers.InMemoryChannelLayer"},
}

FILE_UPLOAD_MAX_MEMORY_SIZE = 20 * 1024 * 1024  # 20MB — фото/короткие видео/аудио к вопросам

# ─── Кэш ───────────────────────────────────────────────────────────
# Redis, если задан REDIS_URL (тот же инстанс, что и для channels_redis
# в проде) — иначе in-memory кэш процесса самого Django, этого достаточно
# для одного dev-инстанса. Что и где кэшируется — см. quizzes/caching.py
# (список категорий и каталог публичных квизов — редко меняющиеся и/или
# часто читаемые данные из БД).
if os.environ.get("REDIS_URL"):
    CACHES = {
        "default": {
            "BACKEND": "django.core.cache.backends.redis.RedisCache",
            "LOCATION": os.environ["REDIS_URL"],
        }
    }
else:
    CACHES = {
        "default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
            "LOCATION": "quizflow-cache",
        }
    }

# ─── Фронтенд ────────────────────────────────────────────────────────
# Куда редиректить браузер после OAuth-логина и куда вести ссылку сброса
# пароля в письме — сам бэкенд эти страницы не рендерит, ими занимается
# React-приложение.
FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:5173").rstrip("/")
FRONTEND_OAUTH_CALLBACK_URL = f"{FRONTEND_URL}/oauth-callback"
FRONTEND_PASSWORD_RESET_URL = f"{FRONTEND_URL}/reset-password"

# ─── Google OAuth ──────────────────────────────────────────────────
# Зарегистрировать приложение и получить client_id/secret:
# https://console.cloud.google.com/apis/credentials — тип "Web application",
# authorized redirect URI = GOOGLE_OAUTH_REDIRECT_URI ниже.
GOOGLE_OAUTH_CLIENT_ID = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
GOOGLE_OAUTH_CLIENT_SECRET = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "")
GOOGLE_OAUTH_REDIRECT_URI = os.environ.get(
    "GOOGLE_OAUTH_REDIRECT_URI", "http://localhost:8000/api/auth/oauth/google/callback/"
)

# ─── VK ID OAuth ───────────────────────────────────────────────────
# Зарегистрировать приложение: https://id.vk.com/business/go/docs/vkid/latest/vk-id/connection/create-application
# redirect URI должен быть указан в настройках приложения и совпадать с
# VK_OAUTH_REDIRECT_URI ниже. VK ID (в отличие от Google) требует PKCE —
# см. accounts/oauth.py.
VK_OAUTH_CLIENT_ID = os.environ.get("VK_OAUTH_CLIENT_ID", "")
VK_OAUTH_REDIRECT_URI = os.environ.get(
    "VK_OAUTH_REDIRECT_URI", "http://localhost:8000/api/auth/oauth/vk/callback/"
)

# ─── Почта (сброс пароля) ──────────────────────────────────────────
# В деве по умолчанию письма просто печатаются в консоль сервера —
# ссылку для сброса пароля можно скопировать оттуда, не поднимая
# настоящий SMTP. Для прода задайте
# EMAIL_BACKEND=django.core.mail.backends.smtp.EmailBackend и
# EMAIL_HOST/EMAIL_PORT/EMAIL_HOST_USER/EMAIL_HOST_PASSWORD/EMAIL_USE_TLS.
EMAIL_BACKEND = os.environ.get(
    "EMAIL_BACKEND", "django.core.mail.backends.console.EmailBackend"
)
EMAIL_HOST = os.environ.get("EMAIL_HOST", "")
EMAIL_PORT = int(os.environ.get("EMAIL_PORT", "587"))
EMAIL_HOST_USER = os.environ.get("EMAIL_HOST_USER", "")
EMAIL_HOST_PASSWORD = os.environ.get("EMAIL_HOST_PASSWORD", "")
EMAIL_USE_TLS = env_bool("EMAIL_USE_TLS", True)
DEFAULT_FROM_EMAIL = os.environ.get("DEFAULT_FROM_EMAIL", "QuizVK <no-reply@quizvk.local>")

# Токен сброса пароля живёт 1 час (стандартный Django-механизм на основе
# PASSWORD_RESET_TIMEOUT + подписи хэша пароля/last_login — без отдельной
# таблицы токенов в БД).
PASSWORD_RESET_TIMEOUT = int(os.environ.get("PASSWORD_RESET_TIMEOUT", str(60 * 60)))
