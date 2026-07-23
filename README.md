<h1><ins>Bro</ins>ad-purpose coding agent</h1>

## What is this?
<img width="667" height="360" alt="image" src="https://github.com/user-attachments/assets/c0124b07-e97e-4b17-a75f-7edea7fb0902" />

A lightweight, fully automated coding agent. Just type what you want, and it's done.

## How to use?
[Deploy it first](#how-to-deploy), then type this in any Discord channel:
```
@bro clone this https://...
@bro create a readme for project helloworld
@bro globally install PostgreSQL and configure it to start automatically
```
That's it — Bro will automatically generate, review, and test the code, then push the commits.
Job updates use Discord Components v2 status cards. Active jobs include refresh and cancel controls, running jobs link directly to their OpenCode session and project folder in code-server, and terminal cards show the job's total consumed tokens.
Running cards show a brief progress report from OpenCode's active todo, assistant text, or current tool and update only when that report changes.
Independent jobs run in parallel in isolated Git worktrees. For a new request that clearly modifies an active job, the router selects that exact parallel job and chooses **Queue**, **Replace**, or **Steer**; replies and **Add instruction** retain explicit controls. Choices and queued instructions persist across restarts.
Global environment work and shell actions run as one tracked job from the bot data directory without creating a Git worktree or accessing registered project repositories.
Discord jobs run in [OpenCode goal mode](https://github.com/prevalentWare/opencode-goal-plugin), which keeps the objective across turns and requires verification evidence before completion.

## How to deploy?

### 1. Run the all-in-one container
Run the following Docker command:
```sh
docker run -it -p 8080:8080 -p 8081:8081 -p 4096:4096 \
  -e DISCORD_TOKEN=... \
  -e DISCORD_ALLOWED_USER_IDS=... \
  -v ./data:/home/opencode \
  ghcr.io/pmh-only/bro
```

### 2. Connect an LLM model provider
* Open the `opencode` web UI at http://localhost:4096
* Add a new model provider via the settings panel.
* Disable all pre-configured models and select the one you want.

### 3. Configure the development environment
Only the home directory is persistent storage.
* Browse project request/response threads at http://localhost:8080. Projects and jobs are ordered by latest activity; use the left project navigation to switch threads. Ask the Discord bot in natural language to hide or show completed job history. The UI is read-only but contains job content, so expose it only through your authentication proxy or private network.
* Open the `code-server` UI at http://localhost:8081.
* Set `CODE_SERVER_PUBLIC_URL` when Discord users access code-server through a different hostname or authentication proxy.
* [IMPORTANT] Log in with your git credentials and make them persistent.
* Configure anything else you need in this environment (e.g., SSH keys, GPG signing enforcement).

### 4. Add the Discord bot to your server
* You know how to do that, right?

### 5. (Optional) Add Docker-in-Docker socket
* I recommend providing dind to bro for better development environment.
* At startup, the entrypoint creates `/tmp/opencode` and sets it to mode `0777`. When `/var/run/docker.sock` is mounted, it also sets the socket to mode `0777` and uses it as `DOCKER_HOST`. These modes grant every container process access to those paths and the Docker daemon.

## How it works?
* The core component of this project is OpenCode.
* The Discord bot uses OpenCode for NLP and coding tasks.
* Non-English requests are translated internally; OpenCode plans, progress, prompts, and final summaries are produced in English.
* System prompts enforce testing and git operations for each job.
* Jobs may install required OS packages, databases, and services or update system configuration outside the checkout, but must not access other project repositories.
* Every automated commit includes `Co-authored-by: Bro, the bot <bro@pmh.codes>`.
* The TypeScript test suites run on Vitest with `npm test`.
* Provider request timeouts are disabled for the selected OpenCode model, so the bot's task deadline controls long jobs.
* OpenCode API requests use a dedicated dispatcher without Node's five-minute response timeout.
* The container installs `@prevalentware/opencode-goal-plugin` for fresh and persisted OpenCode configurations. When using a separately managed OpenCode server, install that plugin in its server config before running jobs.
* Jobs and Discord status message IDs are stored in SQLite. A periodic poller restores unfinished work after container restarts and asks OpenCode to continue until it reports verified success.
* OpenCode commits only inside `bro/job/<job-id>` worktrees. The coordinator serializes integration per project, rebases each later job onto earlier work, rejects merge commits and force pushes, pushes normally, and fast-forwards the canonical branch.
* Rebase conflicts are returned to the later job's OpenCode session; that job must preserve both changes, test, continue the rebase, and recommit before integration proceeds.
* Completion cards report changes introduced by the rebased job rather than unrelated parallel commits.
* [pnpm reduces repeated Node.js dependency installation time and disk use across worktrees](docs/pnpm-worktree-assessment.md), but the coordinator's worktree creation path does not currently install dependencies.

## Pre-installed MCPs
My favorite combination of MCPs:
* ast-grep
* grep_app
* context7
* playwright

The development image also includes compilers, Python, Git, SSH, curl, `vim`, `wget`, `jq`, `ripgrep`, the Docker CLI, and `kubectl`.

## Inspired by
* OpenCode
* OhMyOpenAgent (Dori)
