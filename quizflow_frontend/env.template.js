// Сгенерировано из env.template.js при старте контейнера (envsubst,
// см. docker-entrypoint.sh) — подставляет реальные адреса бэкендов из
// переменных окружения контейнера, без пересборки образа.
//
// По умолчанию (в docker-compose) QUIZVK_API_BASE пустой — запросы идут
// относительным путём на тот же origin, откуда отдана сама страница, а
// nginx этого контейнера реверс-проксирует /api и /ws на backend (см.
// nginx.conf) — значит браузеру не нужен CORS вообще. WS_BASE, если не
// задан явно, вычисляется из текущего адреса страницы — тоже без ручной
// настройки под конкретный домен.
window.__QUIZVK_CONFIG__ = {
  API_BASE: "${QUIZVK_API_BASE}",
  WS_BASE: "${QUIZVK_WS_BASE}" || ((location.protocol === "https:" ? "wss://" : "ws://") + location.host),
  AI_SERVICE_BASE: "${QUIZVK_AI_SERVICE_BASE}",
};
