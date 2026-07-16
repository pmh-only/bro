# Discord OpenCode Bot

A Discord bot that uses an existing [OpenCode web server](https://opencode.ai/docs/web/) at `http://localhost:4096` to understand and execute authorized natural-language requests.

```text
@bot on example project, create hello world code in nodejs and push it
```

The bot first creates a temporary OpenCode session with JSON-schema output to interpret the request. The temporary session has all regular tools disabled and is deleted immediately after routing. There are no command-parsing regular expressions.

For work requests, the bot creates another OpenCode session in the selected project. Jobs are serialized per project, and the Discord status message is updated with the result, session diff summary, and a link to the OpenCode web session.

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
- OpenCode external-directory permission requests are always rejected.
- Other OpenCode permission requests are rejected by default so a job cannot silently gain extra access. Set `OPENCODE_AUTO_APPROVE=true` to approve those requests once. Explicit OpenCode `deny` rules remain denied.
- User tasks are only sent to directories in the project registry. New entries can only be created by the controlled Git clone flow under `PROJECTS_ROOT`.
- Git runs without a shell or interactive credential prompts and is terminated when the configured clone timeout expires.
- The bot only tells OpenCode to commit or push when the Discord request explicitly asks for it.

Keep the Discord token out of source control, use a dedicated bot, and keep the allowlists narrow. Review the project-specific `opencode.json` permissions before enabling automatic approval.

## Validation

Run the compiler and test suite with:

```bash
npm run check
```
