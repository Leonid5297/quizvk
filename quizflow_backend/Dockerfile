FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Pillow нужны системные библиотеки для работы с изображениями;
# psycopg[binary] и остальное — чистый Python, доп. библиотек не требуют.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libjpeg62-turbo \
    zlib1g \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN python manage.py collectstatic --noinput

RUN useradd --create-home --uid 1000 appuser \
    && mkdir -p /app/media \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

COPY --chown=appuser:appuser docker-entrypoint.sh /app/docker-entrypoint.sh
ENTRYPOINT ["/bin/sh", "/app/docker-entrypoint.sh"]

# daphne — тот же ASGI-сервер, что и за manage.py runserver в деве: один
# процесс обслуживает и обычные HTTP-запросы, и WebSocket. Для нагрузки
# выше одного dev/small-prod инстанса — несколько реплик этого контейнера
# за общим Redis (CHANNEL_LAYERS на channels_redis, см. README бэкенда).
CMD ["daphne", "-b", "0.0.0.0", "-p", "8000", "config.asgi:application"]
