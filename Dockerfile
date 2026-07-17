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
ARG CODE_SERVER_VERSION=4.128.0
ARG CODE_SERVER_SHA256_AMD64=79ba26bf186e5268a22b7c17b30a5f288a16c37791f0b86c27859e8fef103188
ARG CODE_SERVER_SHA256_ARM64=f8f02c2a81d1a433a4d132716a6f0405f690f6d70dd955942e95e87356db8a10
ARG DOCKER_CLI_VERSION=29.6.1
ARG DOCKER_CLI_SHA256_AMD64=b0df4a43a98d7ecb708acbdb5a34a3416e13b6e39bcbbdf296f51f0f3442b29f
ARG DOCKER_CLI_SHA256_ARM64=917a4bb83565bcacb38c430f08daae8b59db3256331ac23f22394f0542509881
ARG OPENCODE_UID=1001
ARG OPENCODE_GID=1001
ARG TARGETARCH

ENV NODE_ENV=production \
    HOME=/home/opencode \
    XDG_CONFIG_HOME=/home/opencode/.config \
    XDG_DATA_HOME=/home/opencode/.local/share \
    XDG_STATE_HOME=/home/opencode/.local/state \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    OPENCODE_PORT=4096 \
    OPENCODE_URL=http://127.0.0.1:4096 \
    CODE_SERVER_PORT=8080 \
    PROJECTS_FILE=/home/opencode/data/projects.json \
    PROJECTS_ROOT=/home/opencode/workspace

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl git openssh-client sudo tini \
    && groupadd --gid "${OPENCODE_GID}" opencode \
    && useradd --create-home --shell /bin/bash --uid "${OPENCODE_UID}" --gid "${OPENCODE_GID}" opencode \
    && rm -rf /var/lib/apt/lists/*

RUN case "${TARGETARCH}" in \
      amd64) code_server_sha256="${CODE_SERVER_SHA256_AMD64}" ;; \
      arm64) code_server_sha256="${CODE_SERVER_SHA256_ARM64}" ;; \
      *) printf 'Unsupported architecture: %s\n' "${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && code_server_archive="/tmp/code-server.tar.gz" \
    && curl --fail --location --silent --show-error \
      "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-${TARGETARCH}.tar.gz" \
      --output "${code_server_archive}" \
    && printf '%s  %s\n' "${code_server_sha256}" "${code_server_archive}" | sha256sum --check --status \
    && tar --extract --gzip --file="${code_server_archive}" --directory=/opt \
    && ln --symbolic "/opt/code-server-${CODE_SERVER_VERSION}-linux-${TARGETARCH}/bin/code-server" /usr/local/bin/code-server \
    && rm "${code_server_archive}"

RUN case "${TARGETARCH}" in \
      amd64) docker_arch="x86_64"; docker_sha256="${DOCKER_CLI_SHA256_AMD64}" ;; \
      arm64) docker_arch="aarch64"; docker_sha256="${DOCKER_CLI_SHA256_ARM64}" ;; \
      *) printf 'Unsupported architecture: %s\n' "${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && docker_archive="/tmp/docker.tgz" \
    && curl --fail --location --silent --show-error \
      "https://download.docker.com/linux/static/stable/${docker_arch}/docker-${DOCKER_CLI_VERSION}.tgz" \
      --output "${docker_archive}" \
    && printf '%s  %s\n' "${docker_sha256}" "${docker_archive}" | sha256sum --check --status \
    && tar --extract --gzip --file="${docker_archive}" --directory=/usr/local/bin --strip-components=1 docker/docker \
    && rm "${docker_archive}"

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
COPY docker/docker-entrypoint.sh docker/docker-healthcheck.sh docker/opencode-provider-timeouts.mjs ./docker/
COPY docker/opencode.json ./docker/opencode.default.json
COPY --chown=root:root --chmod=0440 docker/opencode.sudoers /etc/sudoers.d/opencode
COPY docker/xdg-open /usr/local/bin/xdg-open

RUN chmod +x /app/docker/docker-entrypoint.sh /app/docker/docker-healthcheck.sh /usr/local/bin/xdg-open \
    && visudo --check --file=/etc/sudoers.d/opencode \
    && mkdir -p "$(dirname "${PROJECTS_FILE}")" "${PROJECTS_ROOT}" "${XDG_CONFIG_HOME}/opencode" "${XDG_DATA_HOME}/opencode" "${XDG_STATE_HOME}/opencode" \
    && chown -R opencode:opencode /home/opencode \
    && chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}"

EXPOSE 4096 8080

VOLUME ["/home/opencode"]

USER opencode
WORKDIR /home/opencode/workspace

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
  CMD ["/app/docker/docker-healthcheck.sh"]

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/docker-entrypoint.sh"]
