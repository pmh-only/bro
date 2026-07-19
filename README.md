<h1><ins>Bro</ins>ad-purpose coding agent</h1>

## What is this?
<img width="667" height="360" alt="image" src="https://github.com/user-attachments/assets/c0124b07-e97e-4b17-a75f-7edea7fb0902" />

A lightweight, fully automated coding agent. Just type what you want, and it's done.

## How to use?
[Deploy it first](#how-to-deploy), then type this in any Discord channel:
```
@bro clone this https://...
@bro create a readme for project helloworld
```
That's it — Bro will automatically generate, review, and test the code, then push the commits.
Job updates use Discord Components v2 status cards. Active jobs include refresh and cancel controls, and running jobs link directly to their OpenCode session and project folder in code-server.
Running cards show a brief progress report from OpenCode's active todo, assistant text, or current tool and update only when that report changes.
While a job is running, use **Add instruction** to queue a multiline prompt from a Discord modal; queued instructions persist across restarts.

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
* Browse project request/response threads at http://localhost:8080. Use the left project navigation to switch threads. The UI is read-only but contains job content, so expose it only through your authentication proxy or private network.
* Open the `code-server` UI at http://localhost:8081.
* Set `CODE_SERVER_PUBLIC_URL` when Discord users access code-server through a different hostname or authentication proxy.
* [IMPORTANT] Log in with your git credentials and make them persistent.
* Configure anything else you need in this environment (e.g., SSH keys, GPG signing enforcement).

### 4. Add the Discord bot to your server
* You know how to do that, right?

### 5. (Optional) Add Docker-in-Docker socket
* I recommend providing dind to bro for better development environment.
* When `/var/run/docker.sock` is mounted, the entrypoint grants the `opencode` user read/write access and uses it as `DOCKER_HOST`. This changes the host socket mode to `0666`, which grants every container process Docker daemon access.

## How it works?
* The core component of this project is OpenCode.
* The Discord bot uses OpenCode for NLP and coding tasks.
* System prompts enforce testing and git operations for each job.
* Jobs may install required OS packages, databases, and services or update system configuration outside the checkout, but must not access other project repositories.
* Every automated commit includes `Co-authored-by: Bro, the bot <bro@pmh.codes>`.
* The TypeScript test suites run on Vitest with `npm test`.
* Provider request timeouts are disabled for the selected OpenCode model, so the bot's task deadline controls long jobs.
* OpenCode API requests use a dedicated dispatcher without Node's five-minute response timeout.
* Jobs and Discord status message IDs are stored in SQLite. A periodic poller restores unfinished work after container restarts and asks OpenCode to continue until it reports verified success.
* Completion cards compare the job's starting Git commit with the final `HEAD`, so committed changes remain visible in file and line statistics.

## Pre-installed MCPs
My favorite combination of MCPs:
* ast-grep
* grep_app
* context7
* playwright

The development image also includes the Docker CLI and `kubectl`.

## Inspired by
* OpenCode
* OhMyOpenAgent (Dori)
