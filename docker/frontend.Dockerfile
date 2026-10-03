FROM node:20-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
COPY shared ./shared

ARG VITE_WS_URL=
ARG VITE_ICE_SERVERS=
ENV VITE_WS_URL=${VITE_WS_URL} \
    VITE_ICE_SERVERS=${VITE_ICE_SERVERS}
RUN npm run build

FROM nginx:1.27-alpine
ENV BACKEND_HOST=backend \
    BACKEND_PORT=4174

COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
