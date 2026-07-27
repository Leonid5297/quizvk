#!/bin/sh
set -e

# Ждём, пока Postgres примет соединения — docker-compose само по себе
# гарантирует только порядок ЗАПУСКА контейнеров (depends_on), а не то,
# что Postgres внутри уже готов принимать запросы к моменту, как этот
# контейнер стартует.
if [ -n "$POSTGRES_HOST" ]; then
  echo "Ожидаем Postgres на $POSTGRES_HOST:${POSTGRES_PORT:-5432}..."
  until python - <<PYEOF
import socket, sys, os
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(1)
try:
    s.connect((os.environ["POSTGRES_HOST"], int(os.environ.get("POSTGRES_PORT", "5432"))))
except OSError:
    sys.exit(1)
PYEOF
  do
    sleep 1
  done
  echo "Postgres доступен."
fi

python manage.py migrate --noinput

exec "$@"
