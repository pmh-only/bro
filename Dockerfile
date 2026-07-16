FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ARG OPENCODE_VERSION=1.18.2
ARG PLAYWRIGHT_MCP_VERSION=0.0.78
ARG CONTEXT7_MCP_VERSION=3.2.3
ARG AST_GREP_VERSION=0.44.1
ARG AST_GREP_MCP_VERSION=0.0.2
ARG PNPM_VERSION=11.13.1

ENV NODE_ENV=production \
    OPENCODE_PORT=4096 \
    OPENCODE_URL=http://127.0.0.1:4096 \
    PROJECTS_FILE=/data/projects.json \
    PROJECTS_ROOT=/workspace/projects

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl git openssh-client tini \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global \
      "opencode-ai@${OPENCODE_VERSION}" \
      "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
      "@upstash/context7-mcp@${CONTEXT7_MCP_VERSION}" \
      "@ast-grep/cli@${AST_GREP_VERSION}" \
      "ast-grep-mcp@${AST_GREP_MCP_VERSION}" \
    && node "$(npm root --global)/@playwright/mcp/node_modules/playwright/cli.js" install --with-deps chromium \
    && npm cache clean --force

RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential pkg-config python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "pnpm@${PNPM_VERSION}" \
    && npm cache clean --force

ENV NODE_ENV=development

WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker/docker-entrypoint.sh docker/docker-healthcheck.sh ./docker/
COPY docker/opencode.json /root/.config/opencode/opencode.json
COPY docker/xdg-open /usr/local/bin/xdg-open

RUN chmod +x /app/docker/docker-entrypoint.sh /app/docker/docker-healthcheck.sh /usr/local/bin/xdg-open \
    && mkdir -p /data /workspace/projects /root/.local/share/opencode /root/.local/state/opencode

EXPOSE 4096

VOLUME ["/data", "/workspace/projects", "/root/.local/share/opencode", "/root/.local/state/opencode"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
  CMD ["/app/docker/docker-healthcheck.sh"]

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/docker-entrypoint.sh"]
