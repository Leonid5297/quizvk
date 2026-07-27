FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine

# envsubst — для подстановки адресов бэкендов в env.js при старте контейнера
# (см. docker-entrypoint.sh), без пересборки образа под каждый домен.
RUN apk add --no-cache gettext

COPY --from=build /app/dist /usr/share/nginx/html
COPY env.template.js /usr/share/nginx/html/env.template.js
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
