"""
Обёртка над Anthropic Messages API — использует Structured Outputs:
client.messages.parse(..., output_format=PydanticModel). Ответ модели
ограничивается на уровне токенов (constrained decoding) под JSON Schema,
автоматически собранную из GenerateQuizResponse, а SDK сразу возвращает
провалидированный экземпляр этой модели в response.parsed_output.
"""

import logging

import anthropic
from pydantic import ValidationError

from .config import ANTHROPIC_API_KEY, CLAUDE_MAX_TOKENS, CLAUDE_MODEL, CLAUDE_TIMEOUT_SECONDS
from .schemas import GenerateQuizRequest, GenerateQuizResponse

logger = logging.getLogger("quizflow_ai_service")

_client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY, timeout=CLAUDE_TIMEOUT_SECONDS)

# Структуру ответа (какие поля, какие типы) теперь гарантирует output_format —
# в промпте остаются только СМЫСЛОВЫЕ правила, которые из одной JSON Schema
# не выводятся (например, что при type="text" в answers должна быть ровно
# одна запись с is_correct=true — схема допускает и 0, и 5).
SYSTEM_PROMPT = """\
Ты — генератор викторин для образовательной платформы QuizVK. По описанию \
от организатора ты придумываешь вопросы на русском языке (если явно не \
попросили другой язык). Формат ответа задан схемой — сосредоточься на \
содержании и следующих правилах:

- "single" — ровно 4 варианта ответа, ровно один с is_correct=true, три \
остальных правдоподобные, но однозначно неверные.
- "text" — ровно один объект в answers, is_correct=true, значение — короткое \
слово или число без пояснений и скобок (участник вводит его вручную, сверка \
идёт по точному совпадению текста).
- Вопросов с type="text" — не больше 20% от общего числа: они не поддерживают \
досрочное завершение раунда так же удобно, как "single".
- Вопросы должны опираться на проверяемые факты, а не на личное мнение.
- Если mode="simple" — все вопросы лежат в единственном объекте topics с title="".
- Если mode="topics" — раздели вопросы на 2-4 осмысленные подтемы с непустыми \
title, примерно поровну по числу вопросов.
- Ровно столько вопросов, сколько попросили — не больше и не меньше.
"""


class QuizGenerationError(Exception):
    """Не удалось получить от модели валидный квиз (после повторной попытки)."""


class QuizGenerationRefused(QuizGenerationError):
    """Модель явно отказалась выполнять запрос — повторять его же смысла нет."""


def _build_user_prompt(payload: GenerateQuizRequest) -> str:
    return (
        f"Описание квиза от организатора: {payload.description}\n"
        f"Количество вопросов: {payload.num_questions}\n"
        f"Режим: {payload.mode}"
    )


async def _call_claude(user_prompt: str) -> GenerateQuizResponse:
    response = await _client.messages.parse(
        model=CLAUDE_MODEL,
        max_tokens=CLAUDE_MAX_TOKENS,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_prompt}],
        output_format=GenerateQuizResponse,
    )
    if response.stop_reason == "refusal":
        raise QuizGenerationRefused(
            "Модель отказалась генерировать квиз по этому описанию. Попробуйте переформулировать запрос."
        )
    parsed = response.parsed_output
    if parsed is None:
        # Не должно случаться при stop_reason != "refusal", но на всякий
        # случай — например, ответ обрезан по max_tokens.
        raise QuizGenerationError(
            "Модель вернула неполный ответ (возможно, не хватило max_tokens). Попробуйте меньше вопросов за раз."
        )
    return parsed


async def generate_quiz(payload: GenerateQuizRequest) -> GenerateQuizResponse:
    user_prompt = _build_user_prompt(payload)

    # Structured Outputs гарантирует СТРУКТУРУ (поля/типы), но не бизнес-правила
    # уровня "ровно один правильный ответ у single" — те живут в валидаторах
    # schemas.py и всё ещё могут не выполниться, поэтому ретрай сохраняем.
    extra_attempts = [
        "",
        "\n\nПредыдущий ответ не прошёл проверку бизнес-правил (см. системный "
        "промпт про количество и корректность вариантов ответа) — проверь их ещё раз.",
    ]

    last_error: Exception | None = None
    for attempt, extra in enumerate(extra_attempts):
        try:
            return await _call_claude(user_prompt + extra)
        except QuizGenerationRefused:
            raise  # отказ модели — ретрай тут не поможет, отдаём как есть
        except (ValidationError, QuizGenerationError) as exc:
            last_error = exc
            logger.warning("Попытка %s: модель вернула невалидный квиз (%s)", attempt + 1, exc)
            continue

    raise QuizGenerationError(
        "Не удалось сгенерировать корректный квиз по этому описанию. "
        "Попробуйте переформулировать запрос — короче и конкретнее."
    ) from last_error
