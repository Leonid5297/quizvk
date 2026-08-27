# QuizVK - backend (Django + DRF + Channels)

Бэкенд платформы живых квизов QuizVK: организаторы создают квизы (с темами,
разными типами вопросов и медиа), запускают комнаты по коду, участники
подключаются без регистрации по нику - игра идёт в реальном времени по
WebSocket.

Функциональность: регистрация/логин организатора, создание простого и
многотемного квиза, категории (включая свои), медиа к вопросу (фото/видео/
аудио), каталог чужих квизов с поиском и фильтром по категории, лобби с
кик-участников и опцией «играть вместе», прохождение квиза с общим
таймером, промежуточными результатами и настройкой «показывать очки после
каждого вопроса или только в конце».

## Стек

- **Django 6 + Django REST Framework** - модели, REST API
- **Simple JWT** - авторизация организаторов (access/refresh токены)
- **Django Channels + Daphne** - WebSocket, реальное время игры
- **PostgreSQL** (SQLite - для быстрого локального запуска без настройки, см. `.env`)
- **Redis** - кэш для часто читаемых, редко меняющихся данных (категории, каталог); в dev-режиме без `REDIS_URL` используется in-memory кэш процесса
- **Pillow** - обработка загружаемых изображений

---

## 1. Установка

Требуется Python 3.11+.

```bash
cd quizflow_backend
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate

pip install -r requirements.txt

cp .env.example .env            # значения по умолчанию рабочие для локального запуска
```

Для Postgres - задайте `POSTGRES_DB`/`POSTGRES_USER`/`POSTGRES_PASSWORD`/
`POSTGRES_HOST`/`POSTGRES_PORT` в `.env` (закомментированы по умолчанию -
без них используется SQLite). Для Redis-кэша - `REDIS_URL`.

```bash
python manage.py migrate
python manage.py createsuperuser   # для входа в /admin/, необязательно
```

## 2. Запуск

```bash
python manage.py runserver
```

Благодаря `daphne` первым пунктом в `INSTALLED_APPS`, `runserver`
автоматически поднимает ASGI-сервер - обычные HTTP-запросы и WebSocket
обрабатываются одним и тем же процессом на `http://localhost:8000`.

Проверить, что всё работает:

```bash
curl http://localhost:8000/api/categories/
```

Админка - `http://localhost:8000/admin/`.

### Фронтенд

Фронтенд (React, `quizflow.jsx`) - отдельный проект, настроен на
`http://localhost:8000` / `ws://localhost:8000` через константы
`API_BASE`/`WS_BASE` в начале файла - поменяйте их, если бэкенд крутится
не локально. CORS в деве открыт для всех источников
(`CORS_ALLOW_ALL_ORIGINS=True` в `.env`).

### AI-сервис генерации квизов

Отдельный микросервис (`quizflow_ai_service/`) - генерирует черновик
квиза из текстового описания через Claude API. Никак не зависит от этого
бэкенда напрямую (взаимодействует только через фронтенд). Установка и
запуск - в его собственном README.

---

## 3. Модель данных

```
User (accounts)
 └─ role: organizer | player

Quiz (quizzes)
 ├─ owner → User
 ├─ category → Category            (своя категория - обычный get_or_create по имени)
 ├─ mode: simple | topics
 ├─ results_mode: after_each | at_end
 ├─ points_per_question, speed_bonus_enabled, time_per_question
 ├─ is_public, plays_count, cloned_from → Quiz (для каталога)
 └─ topics → Topic[]
      └─ questions → Question[]
           ├─ type: single | multiple | text
           ├─ media (файл) + media_type: image | video | audio
           └─ answers → Answer[]   (у type=text - один Answer с is_correct=True)

QuizSession (sessions_app)         - комната/запуск квиза
 ├─ quiz, organizer, room_code
 ├─ status: lobby | live | finished
 ├─ phase: lobby | question | reveal | standings | finished
 ├─ organizer_playing
 └─ participants → Participant[]
      ├─ nickname, token (UUID, публичный идентификатор), is_active (False = выгнан)
      └─ answers → ParticipantAnswer[]
```

Простой квиз хранится так же, как квиз с темами - просто с одной темой
без заголовка. Это сознательное решение: не плодить два разных пути
данных ради одного UI-переключателя.

---

## 4. REST API

Базовый префикс - `/api/`. Всё, кроме входа/регистрации/каталога(GET)/
join/leaderboard, требует заголовок `Authorization: Bearer <access>`.

### Аутентификация (`/api/auth/`)

| Метод | Путь | Что делает |
|---|---|---|
| POST | `register/` | Регистрация (`username`, `password`, `role`, `display_name`) → сразу отдаёт `access`/`refresh` |
| POST | `login/` | `username` + `password` → `access`/`refresh` |
| POST | `refresh/` | `refresh` → новый `access` |
| POST | `logout/` | `refresh` → чёрный список токена |
| GET | `me/` | Профиль текущего пользователя |

### Квизы (`/api/`)

| Метод | Путь | Что делает |
|---|---|---|
| GET/POST | `quizzes/` | Список своих квизов / создание квиза целиком (темы→вопросы→ответы одним запросом) |
| GET/PUT/PATCH/DELETE | `quizzes/{id}/` | Квиз (редактирует только владелец) |
| GET | `quizzes/catalog/?search=&category=` | Публичные квизы других организаторов - поиск по словам + фильтр по категории. Результат кэшируется на пользователя (TTL 60с) |
| POST | `quizzes/{id}/clone/` | «Добавить себе» квиз из каталога |
| GET | `categories/` | Список категорий (для выпадающего списка). Кэшируется целиком (TTL 1ч) |
| POST | `questions/{id}/media/` | Прикрепить фото/видео/аудио к вопросу (`multipart/form-data`, поле `file`) |
| DELETE | `questions/{id}/media/` | Убрать медиа с вопроса |

Тело `POST /api/quizzes/` (пример «простого» квиза, `mode: "simple"`):

```json
{
  "title": "Столицы мира",
  "category": "География",
  "mode": "simple",
  "results_mode": "after_each",
  "points_per_question": 100,
  "speed_bonus_enabled": true,
  "time_per_question": 20,
  "is_public": true,
  "topics": [
    {
      "title": "",
      "questions": [
        {
          "text": "Столица Австралии?",
          "type": "single",
          "answers": [
            {"text": "Сидней", "is_correct": false},
            {"text": "Канберра", "is_correct": true}
          ]
        },
        {
          "text": "Столица Франции - впишите словом",
          "type": "text",
          "answers": [{"text": "Париж", "is_correct": true}]
        }
      ]
    }
  ]
}
```

Для квиза «с темами» (`mode: "topics"`) - просто несколько объектов в
`topics`, у каждого свой `title` и свой список `questions`.

Медиа грузится отдельным запросом уже после создания вопроса -
так проще с multipart, чем городить файлы внутри вложенного JSON:

```bash
curl -X POST http://localhost:8000/api/questions/5/media/ \
  -H "Authorization: Bearer <access>" \
  -F "file=@photo.jpg"
```

### Игровые сессии (`/api/`)

| Метод | Путь | Что делает |
|---|---|---|
| POST | `quizzes/{quiz_id}/sessions/` | Организатор запускает комнату → код комнаты |
| GET | `sessions/{code}/` | Состояние лобби/игры + активные участники (без токенов - см. ниже) |
| POST | `sessions/{code}/join/` | Вход по нику, без авторизации → `participant.token` |
| POST | `sessions/{code}/kick/` | `{"nickname": "..."}` - организатор выгоняет участника (до или во время игры) |
| GET | `sessions/{code}/leaderboard/` | Финальная таблица результатов |

`participant.token` возвращается **только** в ответе на `join` - это
приватный ключ участника для подключения к WebSocket, аналог пароля.
Нигде больше (ни в `GET /sessions/{code}/`, ни в рассылках по WS) токены
других участников не показываются - организатор кикает и все смотрят
таблицу результатов по нику, который и так виден всем в комнате.

---

## 5. WebSocket - как идёт сама игра

```
ws://localhost:8000/ws/session/<КОД_КОМНАТЫ>/?token=<JWT access>          - организатор
ws://localhost:8000/ws/session/<КОД_КОМНАТЫ>/?participant=<participant.token> - участник
```

Один и тот же протокол для всех: JSON-сообщения вида
`{"type": "...", "payload": {...}}` от клиента и
`{"event": "...", "payload": {...}}` от сервера.

### От клиента серверу

| type | Кто | Когда |
|---|---|---|
| `start` | организатор | запустить квиз из лобби |
| `answer` | участник (или организатор, если играет) | `{"answer_id": 5}` для выбора, `{"text_answer": "Париж"}` для текстового |
| `skip` | организатор | прервать ожидание - досрочно закончить показ ответа/таблицы и перейти дальше |
| `kick` | организатор | `{"target_nickname": "..."}` - выгнать участника прямо во время игры |

### От сервера клиенту

| event | Когда |
|---|---|
| `participant_joined` | кто-то зашёл по коду |
| `quiz_started` | сразу после `start` |
| `question` | новый вопрос - **без** признака правильности вариантов |
| `answered_count` | `{"answered": N, "total": M}` - обновляется на каждый ответ; когда N==M, вопрос завершается досрочно, не дожидаясь конца времени |
| `reveal` | время вышло или ответили все - правильный(е) вариант(ы)/текст + текущие очки |
| `standings` | (только если `results_mode = after_each`) таблица очков между вопросами, показывается 20 секунд или до `skip` от организатора |
| `participant_kicked` | `{"nickname": "..."}` - кого-то выгнали |
| `quiz_finished` | финальная таблица |
| `error` | что-то пошло не так на сервере - соединение можно переподключать |

Логика авторитетна на сервере: клиент не решает, кто прав, не считает
очки и не измеряет своё время - только шлёт `answer` и слушает события.
Бонус за скорость считается по времени между стартом вопроса и приходом
ответа на сервер.

---

## 6. Архитектурные решения

- **Игровой цикл - в памяти процесса.** `realtime/engine.py` держит
  live-состояние комнаты (текущий вопрос, кто ответил, таймеры) в
  обычном Python-словаре, общем для всех WebSocket-подключений внутри
  одного процесса. Для нескольких воркеров/машин игровой цикл нужно
  вынести в отдельный «движковый» процесс (или шардировать комнаты по
  воркерам консистентным хэшированием) и синхронизировать состояние
  через `channels_redis` - сам протокол сообщений при этом не меняется.
- **CHANNEL_LAYERS = InMemoryChannelLayer** по умолчанию - тоже требует
  одного процесса. Для нескольких воркеров раскомментируйте
  `channels_redis` в `requirements.txt` и блок в `config/settings.py`.
- **Кэш** (`quizzes/caching.py`) - список категорий кэшируется целиком с
  инвалидацией при появлении новой категории; каталог - по пользователю
  (результат зависит от того, кто спрашивает: свои квизы и уже
  клонированные исключаются из выдачи) с версионированной инвалидацией
  при публикации/правке/клонировании квиза.
- **Kick действует мгновенно и в игре.** Порог «все ответили» на каждый
  раунд считается от активных участников в момент старта раунда, но кик
  посреди вопроса уменьшает нужное количество на лету.
- **Очки:** `points_per_question` за правильный ответ, при включённом
  `speed_bonus_enabled` - до ещё `points_per_question` бонусом
  пропорционально тому, сколько времени осталось на момент ответа.

---

## 7. Структура проекта

```
config/            настройки, корневые urls, asgi.py (Channels routing)
accounts/          пользователь, регистрация/логин (JWT)
quizzes/           Category/Quiz/Topic/Question/Answer, каталог, клонирование, медиа, кэш
sessions_app/      QuizSession/Participant/ParticipantAnswer, лобби, join/kick/leaderboard
realtime/          WebSocket consumer + авторитетный игровой цикл (engine.py)
```

## 8. Продакшен - что поменять

1. `DJANGO_DEBUG=False`, задать реальный `DJANGO_SECRET_KEY`,
   `DJANGO_ALLOWED_HOSTS`, `CORS_ALLOWED_ORIGINS`.
2. Postgres - задать `POSTGRES_*` в `.env`.
3. Redis - задать `REDIS_URL` (кэш +, при желании, `channels_redis`
   вместо `InMemoryChannelLayer`, см. комментарий в `config/settings.py`).
4. Раздачу `media/` - через nginx/S3, не через Django.
5. Запуск - `daphne config.asgi:application` за nginx, а не
   `manage.py runserver`.
