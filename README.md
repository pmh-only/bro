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

## How to deploy?

### 1. Run the all-in-one container
Run the following Docker command:
```sh
docker run -itp 8080:8080 -p 4096:4096 \
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
* Open the `code-server` UI at http://localhost:8080
* [IMPORTANT] Log in with your git credentials and make them persistent.
* Configure anything else you need in this environment (e.g., SSH keys, GPG signing enforcement).

### 4. Add the Discord bot to your server
* You know how to do that, right?

### 5. (Optional) Add Docker-in-Docker socket
* I recommend providing dind to bro for better development environment.

## How it works?
* The core component of this project is OpenCode.
* The Discord bot uses OpenCode for NLP and coding tasks.
* System prompts enforce testing and git operations for each job.
* Every automated commit includes `Co-authorized-by: Bro, the bot <bro@pmh.codes>`.

## Pre-installed MCPs
My favorite combination of MCPs:
* ast-grep
* grep_app
* context7
* playwright

## Inspired by
* OpenCode
* OhMyOpenAgent (Dori)
