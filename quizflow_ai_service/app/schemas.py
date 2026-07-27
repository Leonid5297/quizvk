"""
Схемы запроса/ответа. Форма ответа специально повторяет вложенную структуру,
которую принимает POST /api/quizzes/ на основном Django-бэкенде (topics ->
questions -> answers), — фронтенду не нужно ничего преобразовывать, чтобы
подставить сгенерированное в CreatorPage или сразу сохранить как есть.
"""

from typing import List, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class GenerateQuizRequest(BaseModel):
    description: str = Field(
        ...,
        min_length=3,
        max_length=1000,
        description="Описание желаемого квиза в свободной форме: тема, аудитория, сложность, тон",
    )
    num_questions: int = Field(5, ge=1, le=15, description="Сколько вопросов сгенерировать")
    mode: Literal["simple", "topics"] = Field(
        "simple", description="simple — один список вопросов; topics — разбить на несколько тем"
    )

    @field_validator("description")
    @classmethod
    def _strip_description(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Описание не может быть пустым.")
        return value


class GeneratedAnswer(BaseModel):
    text: str = Field(..., min_length=1, max_length=300)
    is_correct: bool


class GeneratedQuestion(BaseModel):
    text: str = Field(..., min_length=1, max_length=500)
    type: Literal["single", "text"]
    answers: List[GeneratedAnswer]

    @model_validator(mode="after")
    def _validate_answers(self):
        # Те же правила, что и в quizzes/serializers.py::QuestionSerializer —
        # чтобы сгенерированный квиз гарантированно прошёл сохранение на
        # основном бэкенде, а не отвалился там с невнятной для пользователя
        # ошибкой валидации.
        if self.type == "text":
            if len(self.answers) != 1:
                raise ValueError("У вопроса с типом 'text' должен быть ровно один принимаемый ответ.")
            if not self.answers[0].is_correct:
                raise ValueError("Единственный ответ у текстового вопроса должен быть отмечен как правильный.")
        else:
            if len(self.answers) < 2:
                raise ValueError("У вопроса с выбором ответа должно быть минимум 2 варианта.")
            if not any(a.is_correct for a in self.answers):
                raise ValueError("Хотя бы один вариант ответа должен быть правильным.")
        return self


class GeneratedTopic(BaseModel):
    title: str = Field("", max_length=120)
    questions: List[GeneratedQuestion] = Field(..., min_length=1)


class GenerateQuizResponse(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    category: str = Field(..., min_length=1, max_length=100)
    mode: Literal["simple", "topics"]
    topics: List[GeneratedTopic] = Field(..., min_length=1)


class ErrorResponse(BaseModel):
    detail: str
