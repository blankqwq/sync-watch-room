FROM coturn/coturn:4.18.0-r0-alpine

COPY --chmod=755 docker/turn-entrypoint.sh /usr/local/bin/start-turn

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD turnutils_stunclient "$(hostname -i | awk '{print $1}')" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/start-turn"]
