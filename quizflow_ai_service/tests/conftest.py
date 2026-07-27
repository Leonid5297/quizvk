"""
generate_quiz_endpoint теперь явно проверяет, что ANTHROPIC_API_KEY задан,
прежде чем вообще пытаться генерировать (см. app/main.py) — в тестовом
окружении реального ключа нет, так что без этой фикстуры вообще все тесты
эндпоинта падали бы на этой проверке, а не на том, что они на самом деле
проверяют. Тест на сам «ключ не задан» случай (test_main.py) переопределяет
значение обратно на пустое явным patch внутри себя.
"""

from unittest.mock import patch

import pytest


@pytest.fixture(autouse=True)
def fake_api_key():
    with patch("app.main.ANTHROPIC_API_KEY", "sk-ant-fake-for-tests"):
        yield
