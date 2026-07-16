# Discord OpenCode Bot

A Discord bot that uses an existing [OpenCode web server](https://opencode.ai/docs/web/) at `http://localhost:4096` to understand and execute authorized natural-language requests.

```text
@bot on example project, create hello world code in nodejs and push it
```

The bot first creates a temporary OpenCode session with JSON-schema output to interpret the request. The temporary session has all regular tools disabled and is deleted immediately after routing. There are no command-parsing regular expressions.

For work requests, the bot creates another OpenCode session in the selected project. Jobs are serialized per project, and the Discord status message is updated with the result, session diff summary, and a link to the OpenCode web session. When long-running work completes or fails, the bot sends a separate mention so the requesting user receives a Discord notification.

## Requirements

- Node.js 22 or newer
- OpenCode web running locally
- Git installed
- A Discord bot with the **Message Content Intent** enabled
- Git credentials and a remote configured in projects where requests may push

The OpenCode port does not need to be exposed to the internet. The Discord bot makes an outbound Discord connection and talks to OpenCode over localhost.

## Setup

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Enable **Message Content Intent** under **Bot > Privileged Gateway Intents**.
3. Invite the bot with **View Channels**, **Send Messages**, and **Read Message History** permissions.
4. Install dependencies with `npm install`.
5. Create `.env` from `.env.example` and set `DISCORD_TOKEN` plus at least one allowed user or role ID.
6. Set `PROJECTS_ROOT` to the directory where newly requested repositories may be cloned.
7. Optionally initialize `projects.json` from `projects.example.json` with existing project aliases. A missing file starts as an empty registry.
8. Start OpenCode with `opencode web --port 4096`.
9. Start the bot with `npm run dev`, or use `npm run build && npm start` for a compiled process.

To obtain Discord IDs, enable Developer Mode in Discord, then use **Copy ID** on a user, role, guild, or channel.

If the OpenCode server uses basic authentication, start it with `OPENCODE_SERVER_PASSWORD` and set the same value as `OPENCODE_PASSWORD`. `OPENCODE_USERNAME` defaults to `opencode`.

## Project Registry

The bot stores friendly aliases and absolute project directories in `projects.json`:

```json
{
  "example project": "/home/alice/projects/example-project",
  "website": "/home/alice/projects/website"
}
```

Aliases are case-insensitive and repeated spaces are normalized. Existing paths must be absolute, must exist at startup, and cannot be a filesystem root.

An authorized natural-language request can also clone and register a project. New clones are confined to `PROJECTS_ROOT`, and the registry is updated atomically after a successful clone. Only HTTPS and SSH repository URLs are accepted; local paths, `file://` URLs, and HTTPS URLs containing credentials are rejected. For safety, automatic registration rejects repositories containing `opencode.json`, `opencode.jsonc`, or `.opencode`; those can change permissions or execute project plugins and must be reviewed and registered manually.

## Natural-Language Requests

```text
@bot on example project, create a Node.js hello world and push it
@bot clone https://github.com/acme/example.git, register it as example, then add a health endpoint
@bot what projects are registered?
@bot what is the status of job abcd1234?
@bot cancel job abcd1234
@bot what can you do?
```

OpenCode maps each request to a structured `run`, `clone`, `projects`, `status`, `cancel`, `help`, or `unknown` intent. A clone intent can include an immediate task, so cloning, registration, implementation, verification, commit, and push can happen from one Discord message.

## Permissions And Safety

- `DISCORD_ALLOWED_USER_IDS` and `DISCORD_ALLOWED_ROLE_IDS` control who can submit commands. At least one is required.
- `DISCORD_ALLOWED_GUILD_IDS` and `DISCORD_ALLOWED_CHANNEL_IDS` can further restrict where commands are accepted.
- OpenCode permission requests are automatically approved once by default, including external-directory requests. Set `OPENCODE_AUTO_APPROVE=false` to reject permission prompts. Explicit OpenCode `deny` rules remain denied.
- User tasks are only sent to directories in the project registry. New entries can only be created by the controlled Git clone flow under `PROJECTS_ROOT`.
- Git runs without a shell or interactive credential prompts and is terminated when the configured clone timeout expires.
- The bot only tells OpenCode to commit or push when the Discord request explicitly asks for it.

Keep the Discord token out of source control, use a dedicated bot, and keep the allowlists narrow. Review the project-specific `opencode.json` permissions before enabling automatic approval.

## Docker

The included image runs three services in one container:

- `opencode web --hostname=0.0.0.0 --port=4096`
- `code-server --bind-addr=0.0.0.0:8080 /home/opencode/workspace`
- The compiled Discord bot, started after OpenCode and code-server become healthy

All three services run as the `opencode` user (UID/GID `1001`), which has passwordless `sudo` access for development tasks. The default working directory and clone root are `/home/opencode/workspace`.

The development environment also includes:

- Node.js 24 development environment with npm, npx, Corepack, pnpm, Python 3, `make`, GCC/G++, and `pkg-config`
- code-server 4.128.0
- Docker CLI 29.6.1; no Docker daemon runs in this container
- Playwright MCP with headless Chromium
- `grep_app` through `https://mcp.grep.app`
- `ast-grep` CLI and the local `ast_grep` MCP server
- Local Context7 MCP; `CONTEXT7_API_KEY` is optional but increases limits

Build the image:

```bash
docker build -t discord-opencode-bot .
```

Configure `.env.docker` using `.env.docker.example`, then run:

```bash
docker run --rm \
  --name discord-opencode-bot \
  --env-file .env.docker \
  --publish 4096:4096 \
  --publish 8080:8080 \
  --volume bro-home:/home/opencode \
  discord-opencode-bot
```

Provide an OpenCode provider API key in `.env.docker`, or configure a provider through OpenCode. The persisted home volume also retains code-server settings and extensions, `/home/opencode/.ssh`, and Git configuration.

The Docker client can connect to a separately managed daemon through `DOCKER_HOST` or a mounted Unix socket. The container does not start `dockerd`. When mounting a Unix socket, grant UID/GID `1001` access through the socket permissions or an additional container group.

OpenCode and code-server bind `0.0.0.0` and both ports are published on all host interfaces for the authentication proxy. code-server has no built-in authentication. Use firewall or network policy rules to ensure clients cannot bypass the proxy and connect to ports `4096` or `8080` directly.

Persistent paths:

- `/home/opencode/data/projects.json` stores the project registry.
- `/home/opencode/workspace` stores cloned repositories.
- `/home/opencode/.config/opencode` stores OpenCode settings and MCP configuration.
- `/home/opencode/.local/share/opencode` and `/home/opencode/.local/state/opencode` store OpenCode state.
- `/home/opencode/.config/code-server` and `/home/opencode/.local/share/code-server` store code-server settings and extensions.
- `/home/opencode/.docker` stores Docker client configuration.
- `/home/opencode` is persisted as one user-home volume.

The image seeds `/home/opencode/.config/opencode/opencode.json` from `docker/opencode.json` only when the persistent home volume has no OpenCode configuration. Existing settings are preserved across container restarts and image upgrades. Playwright browsers remain under `/opt/ms-playwright` in the image so a persisted home from another CPU architecture cannot shadow them.

Upgrading from the previous root-based volume layout requires a one-time copy of `/data/projects.json` to `/home/opencode/data/projects.json` and the project and OpenCode volumes into `bro-home`. Replace `/workspace/projects` paths in the migrated registry with `/home/opencode/workspace`. Keep the old volumes until the migrated container has been verified.

### Multi-Architecture Publishing

`.github/workflows/docker-image.yml` publishes `ghcr.io/pmh-only/bro` on pushes to `main`, version tags matching `v*`, and manual workflow runs.

The workflow does not emulate either architecture:

- `linux/amd64` builds on the native `ubuntu-24.04` runner.
- `linux/arm64` builds on the native `ubuntu-24.04-arm` runner.
- A final job downloads both immutable digests and merges them into one multi-platform OCI manifest.

Published tags include the branch or semantic version, the commit SHA, and `latest` for the default branch. Per-architecture GitHub Actions caches are kept separate.

```bash
docker pull ghcr.io/pmh-only/bro:latest
```

## Validation

Run the compiler and test suite with:

```bash
npm run check
```
