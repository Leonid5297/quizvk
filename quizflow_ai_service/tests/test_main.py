from unittest.mock import patch

import anthropic
from fastapi.testclient import TestClient

from app.main import app
from app.claude_client import QuizGenerationError
from app.schemas import GenerateQuizResponse, GeneratedTopic, GeneratedQuestion, GeneratedAnswer

client = TestClient(app)


def _sample_response():
    return GenerateQuizResponse(
        title="Столицы мира",
        category="География",
        mode="simple",
        topics=[
            GeneratedTopic(
                title="",
                questions=[
                    GeneratedQuestion(
                        text="Столица Австралии?",
                        type="single",
                        answers=[
                            GeneratedAnswer(text="Сидней", is_correct=False),
                            GeneratedAnswer(text="Канберра", is_correct=True),
                        ],
                    )
                ],
            )
        ],
    )


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_generate_quiz_success():
    with patch("app.main.generate_quiz", return_value=_sample_response()):
        response = client.post(
            "/api/generate-quiz",
            json={"description": "квиз про столицы мира", "num_questions": 1, "mode": "simple"},
        )
    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "Столицы мира"
    assert body["topics"][0]["questions"][0]["answers"][1]["is_correct"] is True


def test_generate_quiz_rejects_empty_description():
    response = client.post("/api/generate-quiz", json={"description": "  ", "num_questions": 3})
    assert response.status_code == 422


def test_generate_quiz_rejects_too_many_questions_before_calling_claude():
    with patch("app.main.generate_quiz") as mocked:
        response = client.post(
            "/api/generate-quiz",
            json={"description": "квиз", "num_questions": 999},
        )
    assert response.status_code == 422
    mocked.assert_not_called()  # проверка лимита должна отсекать запрос раньше вызова Claude


def test_generate_quiz_maps_generation_error_to_502():
    async def _raise(*args, **kwargs):
        raise QuizGenerationError("модель не смогла")

    with patch("app.main.generate_quiz", side_effect=_raise):
        response = client.post(
            "/api/generate-quiz",
            json={"description": "квиз про что-нибудь", "num_questions": 2},
        )
    assert response.status_code == 502
    assert "не смогла" in response.json()["detail"]


def test_generate_quiz_maps_auth_error_to_500():
    import httpx

    async def _raise(*args, **kwargs):
        resp = httpx.Response(status_code=401, request=httpx.Request("POST", "https://api.anthropic.com/v1/messages"))
        raise anthropic.AuthenticationError("invalid key", response=resp, body=None)

    with patch("app.main.generate_quiz", side_effect=_raise):
        response = client.post(
            "/api/generate-quiz",
            json={"description": "квиз про что-нибудь", "num_questions": 2},
        )
    assert response.status_code == 500


def test_generate_quiz_missing_api_key_returns_clean_500_without_calling_generate():
    """Пустой ANTHROPIC_API_KEY должен быть пойман явной проверкой ДО
    вызова generate_quiz — иначе SDK падает необработанным TypeError при
    сборке заголовков (эта ветка ещё даже не успевает дойти до сети, так
    что anthropic.AuthenticationError здесь не возникает в принципе)."""
    with patch("app.main.ANTHROPIC_API_KEY", ""):
        with patch("app.main.generate_quiz") as mocked:
            response = client.post(
                "/api/generate-quiz",
                json={"description": "квиз про что-нибудь", "num_questions": 2},
            )
    assert response.status_code == 500
    assert "ANTHROPIC_API_KEY" in response.json()["detail"]
    mocked.assert_not_called()
