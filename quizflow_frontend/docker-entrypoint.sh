#!/bin/sh
set -e

envsubst '${QUIZVK_API_BASE} ${QUIZVK_WS_BASE} ${QUIZVK_AI_SERVICE_BASE}' \
  < /usr/share/nginx/html/env.template.js \
  > /usr/share/nginx/html/env.js

exec "$@"
