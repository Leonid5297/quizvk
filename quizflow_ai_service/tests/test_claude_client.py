"""
Реального ANTHROPIC_API_KEY в тестовом окружении нет и не должно быть —
поэтому вызов Anthropic-клиента (client.messages.parse) мокается, а
проверяется вся остальная логика: сборка промпта, обработка отказа модели,
повторная попытка при нарушении бизнес-правил, и то, что они вообще
применяются (Structured Outputs гарантирует только структуру/типы полей,
не смысловые правила вроде "у single ровно один правильный ответ").
"""

from unittest.mock import AsyncMock, patch

import pytest

from app.claude_client import QuizGenerationError, QuizGenerationRefused, generate_quiz
from app.schemas import GenerateQuizRequest, GenerateQuizResponse

VALID_QUIZ = GenerateQuizResponse.model_validate(
    {
        "title": "Столицы мира",
        "category": "География",
        "mode": "simple",
        "topics": [
            {
                "title": "",
                "questions": [
                    {
                        "text": "Столица Австралии?",
                        "type": "single",
                        "answers": [
                            {"text": "Сидней", "is_correct": False},
                            {"text": "Канберра", "is_correct": True},
                            {"text": "Мельбурн", "is_correct": False},
                            {"text": "Перт", "is_correct": False},
                        ],
                    }
                ],
            }
        ],
    }
)


class FakeParsedResponse:
    """Имитирует anthropic.types.parsed_message.ParsedMessage — только то,
    что реально читает наш код: .stop_reason и .parsed_output."""

    def __init__(self, parsed_output=None, stop_reason="end_turn"):
        self.parsed_output = parsed_output
        self.stop_reason = stop_reason


def _mock_parse(*responses):
    """AsyncMock, отдающий на каждый вызов .parse() следующий фейковый
    ответ из списка — так можно смоделировать «сначала модель ошиблась,
    со второй попытки — валидный квиз»."""
    return AsyncMock(side_effect=list(responses))


@pytest.mark.asyncio
async def test_generate_quiz_success_on_first_try():
    request = GenerateQuizRequest(description="квиз про столицы мира", num_questions=1)

    with patch("app.claude_client._client.messages.parse", _mock_parse(FakeParsedResponse(VALID_QUIZ))):
        result = await generate_quiz(request)

    assert result.title == "Столицы мира"
    assert result.category == "География"
    assert len(result.topics[0].questions) == 1
    assert result.topics[0].questions[0].answers[1].is_correct is True


@pytest.mark.asyncio
async def test_generate_quiz_retries_once_on_business_rule_violation():
    """Structured Outputs не поймает "single"-вопрос без единого правильного
    ответа сам — это ловит model_validator в schemas.py уже на нашей стороне,
    и должно уйти в ретрай, а не сразу упасть."""
    request = GenerateQuizRequest(description="квиз про столицы мира", num_questions=1)
    invalid_output = {
        "title": "Тест", "category": "Наука", "mode": "simple",
        "topics": [{"title": "", "questions": [{"text": "Вопрос?", "type": "single",
            "answers": [{"text": "А", "is_correct": False}, {"text": "Б", "is_correct": False}]}]}],
    }
    # parsed_output=None имитирует то, что реально произойдёт у настоящего SDK:
    # TypeAdapter.validate_json() бросает ValidationError ДО того, как .parse()
    # вернётся — но для мока достаточно смоделировать конечный эффект: первая
    # попытка не даёт валидный результат, вторая — даёт.
    mock = AsyncMock(side_effect=[ValidationError_from_dict(invalid_output), FakeParsedResponse(VALID_QUIZ)])
    with patch("app.claude_client._client.messages.parse", mock):
        result = await generate_quiz(request)

    assert mock.call_count == 2
    assert result.title == "Столицы мира"


def ValidationError_from_dict(bad_dict):
    """Хелпер: реальный SDK бросает pydantic.ValidationError прямо из
    client.messages.parse(), когда JSON не проходит валидацию (в т.ч.
    кастомные validator'ы) — воспроизводим это же исключение как side_effect."""
    from pydantic import ValidationError as PydValidationError

    try:
        GenerateQuizResponse.model_validate(bad_dict)
    except PydValidationError as exc:
        return exc
    raise AssertionError("ожидалось, что bad_dict не пройдёт валидацию")


@pytest.mark.asyncio
async def test_generate_quiz_gives_up_after_two_bad_attempts():
    request = GenerateQuizRequest(description="квиз про столицы мира", num_questions=1)
    bad = {"title": "Тест", "category": "Наука", "mode": "simple",
           "topics": [{"title": "", "questions": [{"text": "Вопрос?", "type": "single",
               "answers": [{"text": "А", "is_correct": False}]}]}]}
    err = ValidationError_from_dict(bad)

    with patch("app.claude_client._client.messages.parse", AsyncMock(side_effect=[err, err])):
        with pytest.raises(QuizGenerationError):
            await generate_quiz(request)


@pytest.mark.asyncio
async def test_generate_quiz_refusal_does_not_retry():
    """Явный отказ модели (stop_reason='refusal') — ретраить бессмысленно,
    должны получить QuizGenerationRefused с первой же попытки, без второго
    вызова .parse()."""
    request = GenerateQuizRequest(description="квиз про столицы мира", num_questions=1)
    mock = _mock_parse(FakeParsedResponse(parsed_output=None, stop_reason="refusal"))

    with patch("app.claude_client._client.messages.parse", mock):
        with pytest.raises(QuizGenerationRefused):
            await generate_quiz(request)

    assert mock.call_count == 1  # без повторной попытки


def test_request_schema_rejects_empty_description():
    with pytest.raises(Exception):
        GenerateQuizRequest(description="  ", num_questions=3)


def test_request_schema_rejects_too_many_questions():
    with pytest.raises(Exception):
        GenerateQuizRequest(description="что-нибудь", num_questions=999)
