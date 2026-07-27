"""
Кэш для двух видов данных из QuizViewSet/CategoryViewSet:

1. Категории — меняются почти никогда (создаются раз при вводе новой темы
   и живут вечно), поэтому кэшируем весь список надолго и просто сбрасываем
   ключ, когда где-то создаётся действительно новая категория.

2. Каталог — читают часто (публичная страница, доступна всем организаторам),
   а меняется не так уж редко (публикация/правка/клонирование чужих квизов).
   Результат зависит от того, кто спрашивает (свои квизы и то, что уже
   когда-то клонировал именно этот пользователь, исключаются из выдачи) —
   поэтому в ключе кэша всегда участвует id пользователя, а не только
   search+category+page. Инвалидация — версионированием: у каждой
   комбинации в ключе зашита версия каталога, и чтобы разом инвалидировать
   вообще все закэшированные комбинации, достаточно увеличить счётчик
   версии на единицу — старые ключи просто перестают запрашиваться и сами
   вытесняются по TTL.

Бэкенд кэша настраивается в settings.py (Redis в проде, если задан
REDIS_URL, либо in-memory кэш процесса для локальной разработки — см.
раздел CACHES там же).
"""

from django.core.cache import cache

CATEGORIES_CACHE_KEY = "quizflow:categories:v1"
CATEGORIES_CACHE_TTL = 60 * 60  # час — список категорий почти статичен

CATALOG_CACHE_TTL = 60  # минута — достаточно, чтобы заметно снизить нагрузку от частых открытий каталога
CATALOG_VERSION_KEY = "quizflow:catalog:version"


def invalidate_categories():
    cache.delete(CATEGORIES_CACHE_KEY)


def _catalog_version():
    version = cache.get(CATALOG_VERSION_KEY)
    if version is None:
        version = 1
        cache.set(CATALOG_VERSION_KEY, version, None)  # без TTL — живёт, пока явно не инвалидируем
    return version


def catalog_cache_key(user_id, search, category, page):
    version = _catalog_version()
    return (
        f"quizflow:catalog:v{version}:u{user_id}:"
        f"{(search or '').strip().lower()}:{(category or '').strip().lower()}:{page or '1'}"
    )


def invalidate_catalog():
    try:
        cache.incr(CATALOG_VERSION_KEY)
    except ValueError:
        # ключа ещё не было в кэше (например, только что перезапустили Redis) —
        # заводим версию заново, эффект тот же — старые ключи "отваливаются"
        cache.set(CATALOG_VERSION_KEY, 2, None)
