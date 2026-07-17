import "dotenv/config";
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type GuildMember,
  type Interaction,
  type Message,
} from "discord.js";
import { hasBotMention, stripBotMention } from "./commands.js";
import { cardComponents, jobComponents, parseJobButton } from "./components.js";
import { loadConfig } from "./config.js";
import { loginWithRetry } from "./discord.js";
import { type Job, JobStore } from "./jobs.js";
import { terminalJobNotice } from "./notices.js";
import { OpenCodeService, type TaskResult } from "./opencode.js";
import { ProjectRegistry } from "./projects.js";

const DISCORD_LIMIT = 2_000;

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum - 14).trimEnd()}\n... truncated`;
}

function inline(value: string): string {
  return value.replace(/`/g, "'").replace(/[\r\n]+/g, " ");
}

function duration(job: Job): string | undefined {
  if (!job.startedAt) return undefined;
  const end = job.finishedAt ?? Date.now();
  const seconds = Math.max(1, Math.round((end - job.startedAt) / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatJob(job: Job): string {
  const heading = `Job \`${job.id}\` on **${inline(job.project.alias)}**`;
  const elapsed = duration(job);
  if (job.state === "queued") return `${heading}\nWaiting for the current project job to finish.`;
  if (job.state === "running") {
    const session = job.sessionId ? `\nOpenCode session: \`${job.sessionId}\`` : "";
    const attempts = job.promptAttempts > 1 ? `\nContinuation attempts: ${job.promptAttempts - 1}` : "";
    return `${heading}${session}${attempts}`;
  }
  if (job.state === "cancelling") return `${heading}\nStopping the OpenCode session...`;
  if (job.state === "completed") return truncate(`${heading}${elapsed ? ` in ${elapsed}` : ""}\n${job.result || "OpenCode completed without a text response."}`, DISCORD_LIMIT);
  if (job.state === "cancelled") return `${heading}${elapsed ? ` after ${elapsed}` : ""}.`;
  return truncate(`${heading}${elapsed ? ` after ${elapsed}` : ""}\n${job.error || "Unknown error"}`, DISCORD_LIMIT);
}

function formatResult(result: TaskResult): string {
  const additions = result.diffs.reduce((sum, diff) => sum + diff.additions, 0);
  const deletions = result.diffs.reduce((sum, diff) => sum + diff.deletions, 0);
  const changed = result.diffs.length
    ? `Changes: ${result.diffs.length} file(s), +${additions}/-${deletions}`
    : "Changes: no session diff reported";
  const permissionNote = result.deniedPermissions.length
    ? `\nRejected permissions: ${result.deniedPermissions.map(inline).join(", ")}`
    : "";
  const response = result.response ? `\n\n${truncate(result.response, 1_250)}` : "";
  return `${changed}${permissionNote}${response}`;
}

function roleIds(member: GuildMember | null): Set<string> {
  if (!member) return new Set();
  return new Set(member.roles.cache.keys());
}

async function main(): Promise<void> {
  const config = loadConfig();
  const projects = await ProjectRegistry.load(config.projectsFile);
  const opencode = new OpenCodeService(config);
  const version = await opencode.assertHealthy();
  const jobs = new JobStore(config.jobsDatabase);
  jobs.resume();
  const requestControllers = new Set<AbortController>();

  let client: Client;

  const reply = (message: Message, content: string) =>
    message.reply({ content: truncate(content, DISCORD_LIMIT), allowedMentions: { parse: [], repliedUser: false } });

  const replyCard = (message: Message, title: string, body: string) =>
    message.reply({
      components: cardComponents(title, body),
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [], repliedUser: false },
    });

  const editCard = (message: Message, title: string, body: string) =>
    message.edit({ components: cardComponents(title, body), allowedMentions: { parse: [] } });

  const editJob = (message: Message, job: Job) =>
    message.edit({ components: jobComponents(job, formatJob(job)), allowedMentions: { parse: [] } });

  const publishJob = async (job: Job): Promise<void> => {
    try {
      const channel = await client.channels.fetch(job.channelId);
      if (!channel?.isTextBased()) throw new Error("Discord job channel is not text based");
      const message = await channel.messages.fetch(job.messageId);
      await editJob(message, job);
    } catch (error) {
      console.error(`Unable to update Discord message ${job.messageId} for job ${job.id}`, error);
    }
  };

  const notifyJob = async (job: Job, content: string): Promise<void> => {
    try {
      const channel = await client.channels.fetch(job.channelId);
      if (!channel?.isSendable()) throw new Error("Discord job channel is not sendable");
      await channel.send({
        content: `<@${job.requestedBy}> ${truncate(content, DISCORD_LIMIT - 32)}`,
        allowedMentions: { users: [job.requestedBy] },
      });
    } catch (error) {
      console.error(`Unable to notify Discord user ${job.requestedBy}`, error);
    }
  };

  const notifyUser = async (message: Message, content: string): Promise<void> => {
    try {
      if (!message.channel.isSendable()) throw new Error("Discord channel is not sendable");
      await message.channel.send({
        content: `<@${message.author.id}> ${truncate(content, DISCORD_LIMIT - 32)}`,
        allowedMentions: { users: [message.author.id] },
      });
    } catch (error) {
      console.error(`Unable to notify Discord user ${message.author.id}`, error);
    }
  };

  const authorized = (guildId: string | null, channelId: string, userId: string, roles: Set<string>): boolean => {
    if (config.allowedGuildIds.size && (!guildId || !config.allowedGuildIds.has(guildId))) return false;
    if (config.allowedChannelIds.size && !config.allowedChannelIds.has(channelId)) return false;
    if (config.allowedUserIds.has(userId)) return true;
    return [...roles].some((id) => config.allowedRoleIds.has(id));
  };

  let shuttingDown = false;
  let polling: Promise<void> | undefined;
  let pollTimer: NodeJS.Timeout | undefined;

  const finishJob = async (job: Job, state: "completed" | "failed" | "cancelled", result?: string, error?: string) => {
    job.state = state;
    job.finishedAt = Date.now();
    if (result !== undefined) job.result = result;
    if (error !== undefined) job.error = error;
    jobs.save(job);
    await publishJob(job);
    const notice = terminalJobNotice(job);
    if (notice && !job.notified) {
      await notifyJob(job, notice);
      job.notified = true;
      jobs.save(job);
    }
  };

  const pollJob = async (job: Job): Promise<void> => {
    if (job.state === "cancelling") {
      if (job.sessionId) {
        await opencode.abortTask(job.project.directory, job.sessionId, AbortSignal.timeout(10_000));
      }
      await finishJob(job, "cancelled");
      return;
    }
    if (!job.sessionId || !job.lastPromptAt) return;
    if (job.startedAt && Date.now() - job.startedAt >= config.taskTimeoutMs) {
      await opencode.abortTask(job.project.directory, job.sessionId, AbortSignal.timeout(10_000)).catch(() => undefined);
      await finishJob(job, "failed", undefined, `OpenCode task timed out after ${Math.round(config.taskTimeoutMs / 60_000)} minutes`);
      return;
    }

    await opencode.resolvePendingRequests(
      job.project.directory,
      job.sessionId,
      AbortSignal.timeout(config.jobPollIntervalMs),
    );

    const snapshot = await opencode.taskSnapshot(
      job.project.directory,
      job.sessionId,
      job.lastPromptAt,
      AbortSignal.timeout(config.jobPollIntervalMs),
    );
    if (snapshot.state === "busy") return;
    if (snapshot.successful) {
      const result = formatResult({
        sessionId: job.sessionId,
        webUrl: job.sessionUrl ?? "",
        response: snapshot.response,
        diffs: snapshot.diffs,
        deniedPermissions: [],
      });
      await finishJob(job, "completed", result);
      return;
    }
    if (Date.now() - job.lastPromptAt < config.jobContinueIntervalMs) return;

    job.promptAttempts += 1;
    job.lastPromptAt = Date.now();
    if (snapshot.error) job.error = snapshot.error;
    jobs.save(job);
    await opencode.submitTask(job.project.directory, job.sessionId, job.task, true, AbortSignal.timeout(30_000));
    await publishJob(job);
  };

  const startJob = async (job: Job): Promise<void> => {
    const session = await opencode.ensureTaskSession(
      job.project.directory,
      `Discord: ${truncate(job.task.replace(/\s+/g, " "), 80)}`,
      AbortSignal.timeout(30_000),
    );
    job.state = "running";
    job.startedAt ??= Date.now();
    job.sessionId = session.sessionId;
    job.sessionUrl = session.webUrl;
    job.promptAttempts += 1;
    job.lastPromptAt = Date.now();
    jobs.save(job);
    await publishJob(job);
    await opencode.submitTask(job.project.directory, job.sessionId, job.task, false, AbortSignal.timeout(30_000));
  };

  const runPoll = async (): Promise<void> => {
    for (const job of jobs.active().filter((candidate) => candidate.state !== "queued")) {
      try {
        await pollJob(job);
      } catch (error) {
        console.error(`Unable to poll OpenCode job ${job.id}`, error);
      }
    }
    for (const job of jobs.ready()) {
      try {
        await startJob(job);
      } catch (error) {
        job.error = error instanceof Error ? error.message : String(error);
        jobs.save(job);
        await publishJob(job);
      }
    }
  };

  function pollJobs(): Promise<void> {
    if (shuttingDown) return Promise.resolve();
    if (!polling) polling = runPoll().finally(() => (polling = undefined));
    return polling;
  }

  const handleMessage = async (message: Message): Promise<void> => {
    if (shuttingDown) return;
    if (message.author.bot || !client.user || !hasBotMention(message.content, client.user.id)) return;
    if (!authorized(message.guildId, message.channelId, message.author.id, roleIds(message.member))) {
      await reply(message, "You are not authorized to run OpenCode tasks.");
      return;
    }

    const statusMessage = await replyCard(message, "Understanding request", "OpenCode is interpreting your request.");
    const requestController = new AbortController();
    requestControllers.add(requestController);
    try {
      const request = stripBotMention(message.content, client.user.id);
      const intent = await opencode.interpretRequest(
        request,
        projects.list().map((project) => project.alias),
        requestController.signal,
      );
      if (shuttingDown) {
        await editCard(statusMessage, "Request stopped", "The bot is shutting down; this request was not started.");
        return;
      }

      if (intent.action === "help") {
        await editCard(
          statusMessage,
          "Bro commands",
          [
            "**OpenCode bot**",
            "Mention me with a natural-language request to work in a registered project.",
            "You can also ask me to clone and register an HTTPS or SSH Git repository, optionally followed by a task.",
            "Ask naturally to list projects, check job status, or cancel a job.",
          ].join("\n"),
        );
        return;
      }

      if (intent.action === "projects") {
        const registered = projects.list();
        await editCard(
          statusMessage,
          "Registered projects",
          registered.length
            ? registered.map((project) => `\`${inline(project.alias)}\``).join("\n")
            : "There are no registered projects yet. Ask me to clone and register a Git repository.",
        );
        return;
      }

      if (intent.action === "status") {
        if (intent.jobId) {
          const job = jobs.get(intent.jobId);
          if (job) await editJob(statusMessage, job);
          else await editCard(statusMessage, "Job not found", `Job \`${inline(intent.jobId)}\` was not found.`);
        } else {
          const active = jobs.active();
          await editCard(
            statusMessage,
            "Active jobs",
            active.length
              ? active.map((job) => `\`${job.id}\` ${job.state} on **${inline(job.project.alias)}**`).join("\n")
              : "There are no active jobs.",
          );
        }
        return;
      }

      if (intent.action === "cancel") {
        const job = await jobs.cancel(intent.jobId!);
        if (job) await editJob(statusMessage, job);
        else await editCard(statusMessage, "Job not found", `Active job \`${inline(intent.jobId!)}\` was not found.`);
        return;
      }

      if (intent.action === "unknown") {
        await editCard(
          statusMessage,
          "More information needed",
          intent.message || "I could not determine the project or requested action. Include a project alias or Git repository URL.",
        );
        return;
      }

      let project;
      let task = intent.task;
      if (intent.action === "clone") {
        await editCard(statusMessage, "Cloning repository", `Cloning and registering **${inline(intent.project!)}**...`);
        project = await projects.cloneAndRegister({
          alias: intent.project!,
          repository: intent.repository!,
          projectsRoot: config.projectsRoot,
          timeoutMs: config.cloneTimeoutMs,
          signal: requestController.signal,
        });
        if (shuttingDown || requestController.signal.aborted) {
          await editCard(statusMessage, "Request stopped", "The bot shut down after cloning; no task was queued.");
          return;
        }
        if (!task) {
          await editCard(statusMessage, "Project registered", `Registered **${inline(project.alias)}**. It is ready for OpenCode tasks.`);
          await notifyUser(message, `Project **${inline(project.alias)}** was cloned and registered successfully.`);
          return;
        }
      } else {
        project = projects.resolve(intent.project!);
        if (!project) {
          await editCard(
            statusMessage,
            "Project not found",
            `Project **${inline(intent.project!)}** is not registered. Include its Git repository URL and ask me to clone it.`,
          );
          return;
        }
      }

      if (!task) throw new Error("OpenCode did not identify the project task");
      const job = jobs.enqueue({
        project,
        task,
        requestedBy: message.author.id,
        channelId: message.channelId,
        messageId: statusMessage.id,
        ...(message.guildId ? { guildId: message.guildId } : {}),
      });
      await editJob(statusMessage, job);
      void pollJobs();
    } catch (error) {
      await editCard(
        statusMessage,
        "Request failed",
        truncate(error instanceof Error ? error.message : String(error), DISCORD_LIMIT),
      );
      await notifyUser(message, "The OpenCode request failed before completion. See the updated status message for details.");
    } finally {
      requestControllers.delete(requestController);
    }
  };

  const handleMessageCreate = (message: Message): void => {
    void handleMessage(message).catch(async (error) => {
      console.error("Discord message handler failed", error);
      try {
        await reply(message, `Request failed: ${error instanceof Error ? error.message : String(error)}`);
      } catch (replyError) {
        console.error("Unable to report Discord request failure", replyError);
      }
    });
  };

  const handleInteraction = (interaction: Interaction): void => {
    if (!interaction.isButton()) return;
    const button = parseJobButton(interaction.customId);
    if (!button) return;

    void (async () => {
      const roles = interaction.inCachedGuild() ? roleIds(interaction.member) : new Set<string>();
      if (!authorized(interaction.guildId, interaction.channelId, interaction.user.id, roles)) {
        await interaction.reply({ content: "You are not authorized to control OpenCode jobs.", flags: MessageFlags.Ephemeral });
        return;
      }

      const job = jobs.get(button.jobId);
      if (!job) {
        await interaction.reply({ content: `Job \`${button.jobId}\` was not found.`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (button.action === "refresh") {
        await interaction.update({ components: jobComponents(job, formatJob(job)), allowedMentions: { parse: [] } });
        return;
      }

      await interaction.deferUpdate();
      jobs.cancel(job.id);
      const current = jobs.get(job.id);
      if (current) {
        await interaction.message.edit({ components: jobComponents(current, formatJob(current)), allowedMentions: { parse: [] } });
      }
    })().catch(async (error) => {
      console.error("Discord job interaction failed", error);
      const content = `Job action failed: ${error instanceof Error ? error.message : String(error)}`;
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: truncate(content, DISCORD_LIMIT), flags: MessageFlags.Ephemeral });
        } else {
          await interaction.reply({ content: truncate(content, DISCORD_LIMIT), flags: MessageFlags.Ephemeral });
        }
      } catch (replyError) {
        console.error("Unable to report Discord job interaction failure", replyError);
      }
    });
  };

  const createClient = (): Client => {
    const created = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    });
    created.once(Events.ClientReady, (readyClient) => {
      console.log(`Discord bot ${readyClient.user.tag} connected to OpenCode ${version}`);
    });
    created.on(Events.MessageCreate, handleMessageCreate);
    created.on(Events.InteractionCreate, handleInteraction);
    created.on(Events.Error, (error) => console.error("Discord client error", error));
    return created;
  };

  client = await loginWithRetry(createClient, config.discordToken, {
    onRetry: (error, delayMs) => {
      console.error(`Discord login failed; retrying in ${Math.round(delayMs / 1_000)} seconds`, error);
    },
  });
  void Promise.all(jobs.active().map((job) => publishJob(job))).then(() => pollJobs());
  pollTimer = setInterval(() => void pollJobs(), config.jobPollIntervalMs);
  pollTimer.unref();

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (pollTimer) clearInterval(pollTimer);
    for (const controller of requestControllers) controller.abort(new Error("Bot is shutting down"));
    await polling;
    jobs.close();
    await opencode.close();
    client.destroy();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
