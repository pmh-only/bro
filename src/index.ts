import "dotenv/config";
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type GuildMember,
  type Message,
} from "discord.js";
import { hasBotMention, stripBotMention } from "./commands.js";
import { cardComponents, jobComponents, parseJobButton } from "./components.js";
import { loadConfig } from "./config.js";
import { type Job, JobQueue } from "./jobs.js";
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
    return `${heading}${session}`;
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
  const jobs = new JobQueue();
  const requestControllers = new Set<AbortController>();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

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

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Discord bot ${readyClient.user.tag} connected to OpenCode ${version}`);
  });

  let shuttingDown = false;
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
      let terminalNoticeSent = false;
      let job: Job;
      job = jobs.enqueue({
        project,
        task,
        requestedBy: message.author.id,
        onChange: async (changedJob) => {
          await editJob(statusMessage, changedJob);
          const notice = terminalJobNotice(changedJob);
          if (!terminalNoticeSent && notice) {
            terminalNoticeSent = true;
            await notifyUser(message, notice);
          }
        },
        execute: async (runningJob) => {
          const result = await opencode.runTask({
            directory: project.directory,
            title: `Discord: ${truncate(task.replace(/\s+/g, " "), 80)}`,
            task,
            signal: runningJob.controller.signal,
            onSession: (sessionId, sessionUrl) => {
              runningJob.sessionId = sessionId;
              runningJob.sessionUrl = sessionUrl;
              void editJob(statusMessage, runningJob).catch((error) =>
                console.error(`Unable to publish OpenCode session ${sessionId}`, error),
              );
            },
          });
          return formatResult(result);
        },
      });
      await editJob(statusMessage, job);
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

  client.on(Events.MessageCreate, (message) => {
    void handleMessage(message).catch(async (error) => {
      console.error("Discord message handler failed", error);
      try {
        await reply(message, `Request failed: ${error instanceof Error ? error.message : String(error)}`);
      } catch (replyError) {
        console.error("Unable to report Discord request failure", replyError);
      }
    });
  });

  client.on(Events.InteractionCreate, (interaction) => {
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
      await jobs.cancel(job.id);
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
  });

  client.on(Events.Error, (error) => console.error("Discord client error", error));
  await client.login(config.discordToken);

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const controller of requestControllers) controller.abort(new Error("Bot is shutting down"));
    await jobs.cancelAll();
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
