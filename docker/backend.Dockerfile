FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4174 \
    SERVE_STATIC=false

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 4174
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4174/readyz >/dev/null || exit 1

CMD ["node", "server/index.js"]
