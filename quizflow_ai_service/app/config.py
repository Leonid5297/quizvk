"""
Настройки сервиса — читаются из окружения (см. .env.example).
"""

import os

from dotenv import load_dotenv

load_dotenv()


def _env_bool(name, default=False):
    return os.environ.get(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


def _env_list(name, default=""):
    raw = os.environ.get(name, default)
    return [item.strip() for item in raw.split(",") if item.strip()]


ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

# claude-sonnet-5 — золотая середина между качеством и скоростью/ценой для
# такой задачи (структурированная генерация текста, не агентный сценарий).
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-5")
CLAUDE_MAX_TOKENS = int(os.environ.get("CLAUDE_MAX_TOKENS", "4096"))
CLAUDE_TIMEOUT_SECONDS = float(os.environ.get("CLAUDE_TIMEOUT_SECONDS", "60"))

CORS_ALLOW_ALL_ORIGINS = _env_bool("CORS_ALLOW_ALL_ORIGINS", True)
CORS_ALLOWED_ORIGINS = _env_list("CORS_ALLOWED_ORIGINS")

MAX_QUESTIONS_PER_REQUEST = int(os.environ.get("MAX_QUESTIONS_PER_REQUEST", "15"))
