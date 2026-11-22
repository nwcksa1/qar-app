# ============================================================================
#  NWC QAR — container image with a built-in TEST ➜ PRODUCTION gate
#  Stage 1 runs the full test suite. If any check fails, `docker build`
#  fails and no production image is produced.
# ============================================================================

# ---------- Stage 1: test environment ----------
FROM node:20-alpine AS test
WORKDIR /app
COPY package.json server.js test.js ./
COPY lib ./lib
COPY public ./public
RUN node test.js && echo "tests-passed $(date -u +%FT%TZ)" > /tmp/TESTS_PASSED

# ---------- Stage 2: production ----------
FROM node:20-alpine AS production
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 DATA_DIR=/app/data TRUST_PROXY=true
WORKDIR /app
# This COPY makes production depend on the test stage: no pass, no image.
COPY --from=test /tmp/TESTS_PASSED /app/TESTS_PASSED
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "server.js"]
