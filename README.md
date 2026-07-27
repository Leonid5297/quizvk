# QuizVK  (посмотреть можно по ссылке: https://quizvk.ru) 

Платформа живых квизов: организаторы создают квизы, запускают комнаты по
коду, участники подключаются без регистрации — игра идёт в реальном
времени по WebSocket. Плюс генерация квизов через Claude API, вход через
Google/VK, сброс и смена пароля, профиль.

## Из чего состоит

```
quizflow_backend/       Django + DRF + Channels — REST API, WebSocket-игра,
                         аутентификация (пароль, OAuth), сброс пароля, кэш
quizflow_ai_service/    FastAPI-микросервис — генерация квиза из описания
                         через Claude API
quizflow_frontend/      React (Vite) — весь UI, статика + nginx в проде
docker-compose.yml      Связывает всё выше + Postgres + Redis
docker-compose.https.yml  Опциональная надстройка: HTTPS через Caddy
```

У каждого из трёх проектов есть свой README с деталями (API, переменные
окружения, структура кода) — этот файл про то, как поднять всё вместе.

---

## Быстрый локальный запуск (Docker)

Нужен только Docker с плагином Compose (`docker compose version` должен
что-то печатать).

```bash
cp .env.example .env
docker compose up --build
```

Открыть `http://localhost`. Всё работает сразу — Postgres, Redis,
миграции применяются автоматически при старте бэкенда. Вход через
Google/VK и генерация через ИИ без ключей в `.env` просто покажут
понятную ошибку — остальной сайт при этом работает как обычно.

Остановить: `docker compose down` (без `-v` — данные в volume останутся
до следующего запуска; с `-v` — сотрутся).

---

## Разворачиваем на настоящем сервере

Дальше — по шагам, от пустого сервера до сайта, открывающегося в
браузере по вашему домену с HTTPS.

### 1. Сервер

Нужен любой VPS с Linux (Ubuntu 22.04/24.04 подойдёт) с белым IP-адресом.
Минимально хватит 1 vCPU / 2 ГБ RAM — этого достаточно и для Postgres, и
для Redis, и для трёх контейнеров приложения на небольшой нагрузке.

### 2. Установить Docker на сервере

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# перелогиньтесь (exit и зайдите по ssh заново), чтобы группа применилась
```

Проверка: `docker compose version`.

### 3. Скопировать проект на сервер

Если код лежит в git-репозитории:

```bash
git clone <ваш-репозиторий> quizvk
cd quizvk
```

Если нет — просто скопируйте папку с ноутбука на сервер (из папки с
`docker-compose.yml` на локальной машине):

```bash
rsync -avz --exclude node_modules --exclude venv --exclude __pycache__ \
  ./ user@your-server-ip:~/quizvk/
```

### 4. Домен

Купите домен у любого регистратора и создайте A-запись, указывающую на
IP вашего сервера:

```
your-domain.com.   A   <IP сервера>
```

DNS может применяться от пары минут до нескольких часов — проверить
можно командой `dig your-domain.com` (должен вернуть тот же IP).

Без домена тоже можно — просто открывать сайт по `http://<IP сервера>`
без HTTPS (шаги 6 и 7 ниже тогда пропустите). Но: Google OAuth в
продакшен-режиме требует настоящий домен для redirect URI, так что вход
через Google без домена не заработает (VK и обычный логин/пароль — заработают).

### 5. Настроить `.env`

```bash
cp .env.example .env
nano .env    # или любой другой редактор
```

Обязательно поменяйте:

- `POSTGRES_PASSWORD` — на что-то не `change-me...`
- `DJANGO_SECRET_KEY` — на случайную длинную строку (например:
  `python3 -c "import secrets; print(secrets.token_urlsafe(50))"`)
- `DJANGO_ALLOWED_HOSTS` — впишите ваш домен (или IP, если без домена)
- `BACKEND_BASE_URL` и `FRONTEND_URL` — `https://your-domain.com` (или
  `http://<IP>`, если без HTTPS)

Необязательно, но полезно сразу:

- `ANTHROPIC_API_KEY` — без него кнопка «Сгенерировать с помощью ИИ» не
  будет работать, остальной сайт не пострадает. Ключ — на
  https://console.anthropic.com/
- `GOOGLE_OAUTH_CLIENT_ID`/`SECRET` и `VK_OAUTH_CLIENT_ID` — без них
  кнопки входа через Google/VK покажут ошибку «не настроен», обычная
  регистрация по email/паролю работает без них. Настройка — см. README
  бэкенда, там есть прямые ссылки на консоли обоих провайдеров. Redirect
  URI в настройках самих Google/VK-приложений должен указывать на ваш
  реальный домен: `https://your-domain.com/api/auth/oauth/google/callback/`
  и `.../vk/callback/`.

### 6. Запуск с HTTPS (если есть домен)

В `.env` раскомментируйте и заполните `DOMAIN` и `ACME_EMAIL` (они уже
есть в файле, в самом низу — просто уберите `#` и впишите свои значения).

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --build
```

Дополнительный сервис `caddy` сам получит сертификат Let's Encrypt при
первом запуске (нужно 10–30 секунд) и дальше сам продлевает его —
руками ничего делать не нужно. Откройте `https://your-domain.com`.

Если что-то пошло не так на этом шаге — почти всегда дело в том, что DNS
ещё не применился (см. шаг 4) или порты 80/443 на сервере закрыты
файрволом (см. ниже).

### 6′. Запуск без HTTPS (только по IP или для теста)

```bash
docker compose up -d --build
```

Откройте `http://<IP сервера>`.

### 7. Открыть порты в файрволе

Если на сервере включён `ufw` (или другой файрвол):

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp    # только если используете HTTPS (шаг 6)
sudo ufw allow OpenSSH
sudo ufw enable
```

Порты Postgres (5432), Redis (6379) и внутренних сервисов наружу
специально не открыты — docker-compose держит их только во внутренней
сети между контейнерами, и это правильно: снаружи им быть не за чем.

---

## Дальше — что понадобится время от времени

**Логи:**
```bash
docker compose logs -f backend        # конкретный сервис
docker compose logs -f                # всё сразу
```

**Обновить код после изменений:**
```bash
git pull   # если из git
docker compose up -d --build
```
Миграции применяются автоматически при старте бэкенда — руками
`migrate` запускать не нужно.

**Создать администратора Django** (для `/admin/`):
```bash
docker compose exec backend python manage.py createsuperuser
```

**Резервная копия базы данных:**
```bash
docker compose exec postgres pg_dump -U quizflow quizflow > backup.sql
```

**Восстановление из копии:**
```bash
cat backup.sql | docker compose exec -T postgres psql -U quizflow quizflow
```

**Полная остановка (данные останутся):**
```bash
docker compose down
```

**Посмотреть, что вообще происходит:**
```bash
docker compose ps
```

---

## Если что-то не работает

- **Сайт не открывается вообще** — `docker compose ps`, все сервисы
  должны быть `Up`/`healthy`. Если `frontend` или `backend` в
  перезапуске — смотрите его логи, обычно там прямо написана причина.
- **Открывается, но при регистрации/входе ошибка сети** — проверьте
  `docker compose logs backend`; частая причина — не применилась
  переменная `DJANGO_ALLOWED_HOSTS` (впишите туда домен, которым
  реально пользуетесь).
- **HTTPS не выдаётся** — `docker compose logs caddy`; почти всегда это
  DNS ещё не успел примениться, либо порт 80/443 закрыт файрволом
  (Let's Encrypt проверяет владение доменом именно по 80-му порту).
- **Кнопка «Сгенерировать с помощью ИИ» не работает** — это ожидаемо
  без `ANTHROPIC_API_KEY` в `.env`, сообщение об этом так и должно
  выглядеть; остальной сайт при этом исправен.
