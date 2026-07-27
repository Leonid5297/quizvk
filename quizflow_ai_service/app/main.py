import logging

import anthropic
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .claude_client import QuizGenerationError, generate_quiz
from .config import ANTHROPIC_API_KEY, CORS_ALLOW_ALL_ORIGINS, CORS_ALLOWED_ORIGINS, MAX_QUESTIONS_PER_REQUEST
from .schemas import ErrorResponse, GenerateQuizRequest, GenerateQuizResponse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("quizflow_ai_service")

app = FastAPI(
    title="QuizVK AI Quiz Generator",
    description=(
        "Отдельный микросервис: превращает текстовое описание квиза от "
        "организатора в готовую структуру (темы/вопросы/ответы) через Claude API. "
        "Сам квиз никуда не сохраняет — это делает основной Django-бэкенд, "
        "когда фронтенд отправляет ему уже сгенерированный (и, возможно, "
        "отредактированный пользователем) результат."
    ),
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if CORS_ALLOW_ALL_ORIGINS else CORS_ALLOWED_ORIGINS,
    allow_credentials=not CORS_ALLOW_ALL_ORIGINS,  # "*" вместе с credentials браузер не разрешает
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post(
    "/api/generate-quiz",
    response_model=GenerateQuizResponse,
    responses={
        422: {"model": ErrorResponse, "description": "Некорректный запрос (пустое описание, слишком много вопросов и т.п.)"},
        500: {"model": ErrorResponse, "description": "Сервис не настроен (нет ANTHROPIC_API_KEY)"},
        502: {"model": ErrorResponse, "description": "Модель не смогла сгенерировать корректный квиз"},
        503: {"model": ErrorResponse, "description": "Claude API временно недоступен/перегружен"},
    },
)
async def generate_quiz_endpoint(payload: GenerateQuizRequest) -> GenerateQuizResponse:
    if not ANTHROPIC_API_KEY:
        # Пустой ключ роняет SDK ещё до сетевого запроса (TypeError при
        # сборке заголовков, не ловится как anthropic.AuthenticationError
        # ниже — та возникает только когда ключ ЗАДАН, но неверен и
        # реально дошёл до Anthropic API) — проверяем сами и явно.
        raise HTTPException(status_code=500, detail="Сервис генерации не настроен на сервере (нет ANTHROPIC_API_KEY).")
    if payload.num_questions > MAX_QUESTIONS_PER_REQUEST:
        raise HTTPException(
            status_code=422,
            detail=f"Максимум {MAX_QUESTIONS_PER_REQUEST} вопросов за один запрос.",
        )
    try:
        return await generate_quiz(payload)
    except QuizGenerationError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except anthropic.AuthenticationError as exc:
        logger.error("Anthropic API: неверный ключ (%s)", exc)
        raise HTTPException(status_code=500, detail="Сервис генерации не настроен на сервере (ANTHROPIC_API_KEY).") from exc
    except anthropic.RateLimitError as exc:
        logger.warning("Anthropic API: rate limit (%s)", exc)
        raise HTTPException(status_code=503, detail="Сервис генерации сейчас перегружен, попробуйте через минуту.") from exc
    except anthropic.APIConnectionError as exc:
        logger.error("Anthropic API: сеть недоступна (%s)", exc)
        raise HTTPException(status_code=503, detail="Не удалось связаться с Claude API. Попробуйте ещё раз.") from exc
    except anthropic.APIStatusError as exc:
        logger.error("Anthropic API вернул ошибку: %s", exc)
        raise HTTPException(status_code=502, detail="Claude API вернул ошибку при генерации квиза.") from exc
