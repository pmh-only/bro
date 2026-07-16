import "dotenv/config";
import {
  Client,
  Events,
  GatewayIntentBits,
  type GuildMember,
  type Message,
} from "discord.js";
import { hasBotMention, stripBotMention } from "./commands.js";
import { loadConfig } from "./config.js";
import { type Job, JobQueue } from "./jobs.js";
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
  const heading = `${job.state[0]?.toUpperCase()}${job.state.slice(1)} job \`${job.id}\` on **${inline(job.project.alias)}**`;
  const elapsed = duration(job);
  if (job.state === "queued") return `${heading}\nWaiting for the current project job to finish.`;
  if (job.state === "running") return `${heading}${job.sessionId ? `\nOpenCode session: \`${job.sessionId}\`` : ""}`;
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
  return `[Open in OpenCode](${result.webUrl})\n${changed}${permissionNote}${response}`;
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

  const authorized = (message: Message): boolean => {
    if (config.allowedGuildIds.size && (!message.guildId || !config.allowedGuildIds.has(message.guildId))) return false;
    if (config.allowedChannelIds.size && !config.allowedChannelIds.has(message.channelId)) return false;
    if (config.allowedUserIds.has(message.author.id)) return true;
    return [...roleIds(message.member)].some((id) => config.allowedRoleIds.has(id));
  };

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Discord bot ${readyClient.user.tag} connected to OpenCode ${version}`);
  });

  let shuttingDown = false;
  const handleMessage = async (message: Message): Promise<void> => {
    if (shuttingDown) return;
    if (message.author.bot || !client.user || !hasBotMention(message.content, client.user.id)) return;
    if (!authorized(message)) {
      await reply(message, "You are not authorized to run OpenCode tasks.");
      return;
    }

    const statusMessage = await reply(message, "Understanding the request with OpenCode...");
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
        await statusMessage.edit({ content: "The bot is shutting down; this request was not started.", allowedMentions: { parse: [] } });
        return;
      }

      if (intent.action === "help") {
        await statusMessage.edit({
          content: [
            "**OpenCode bot**",
            "Mention me with a natural-language request to work in a registered project.",
            "You can also ask me to clone and register an HTTPS or SSH Git repository, optionally followed by a task.",
            "Ask naturally to list projects, check job status, or cancel a job.",
          ].join("\n"),
          allowedMentions: { parse: [] },
        });
        return;
      }

      if (intent.action === "projects") {
        const registered = projects.list();
        await statusMessage.edit({
          content: registered.length
            ? `**Registered projects**\n${registered.map((project) => `\`${inline(project.alias)}\``).join("\n")}`
            : "There are no registered projects yet. Ask me to clone and register a Git repository.",
          allowedMentions: { parse: [] },
        });
        return;
      }

      if (intent.action === "status") {
        if (intent.jobId) {
          const job = jobs.get(intent.jobId);
          await statusMessage.edit({
            content: job ? formatJob(job) : `Job \`${inline(intent.jobId)}\` was not found.`,
            allowedMentions: { parse: [] },
          });
        } else {
          const active = jobs.active();
          await statusMessage.edit({
            content: active.length
              ? `**Active jobs**\n${active.map((job) => `\`${job.id}\` ${job.state} on **${inline(job.project.alias)}**`).join("\n")}`
              : "There are no active jobs.",
            allowedMentions: { parse: [] },
          });
        }
        return;
      }

      if (intent.action === "cancel") {
        const job = await jobs.cancel(intent.jobId!);
        await statusMessage.edit({
          content: job ? `Cancellation requested for job \`${job.id}\`.` : `Active job \`${inline(intent.jobId!)}\` was not found.`,
          allowedMentions: { parse: [] },
        });
        return;
      }

      if (intent.action === "unknown") {
        await statusMessage.edit({
          content: intent.message || "I could not determine the project or requested action. Include a project alias or Git repository URL.",
          allowedMentions: { parse: [] },
        });
        return;
      }

      let project;
      let task = intent.task;
      if (intent.action === "clone") {
        await statusMessage.edit({
          content: `Cloning and registering **${inline(intent.project!)}**...`,
          allowedMentions: { parse: [] },
        });
        project = await projects.cloneAndRegister({
          alias: intent.project!,
          repository: intent.repository!,
          projectsRoot: config.projectsRoot,
          timeoutMs: config.cloneTimeoutMs,
          signal: requestController.signal,
        });
        if (shuttingDown || requestController.signal.aborted) {
          await statusMessage.edit({ content: "The bot shut down after cloning; no task was queued.", allowedMentions: { parse: [] } });
          return;
        }
        if (!task) {
          await statusMessage.edit({
            content: `Registered **${inline(project.alias)}**. It is ready for OpenCode tasks.`,
            allowedMentions: { parse: [] },
          });
          return;
        }
      } else {
        project = projects.resolve(intent.project!);
        if (!project) {
          await statusMessage.edit({
            content: `Project **${inline(intent.project!)}** is not registered. Include its Git repository URL and ask me to clone it.`,
            allowedMentions: { parse: [] },
          });
          return;
        }
      }

      if (!task) throw new Error("OpenCode did not identify the project task");
      let job: Job;
      job = jobs.enqueue({
        project,
        task,
        requestedBy: message.author.id,
        onChange: async (changedJob) => {
          await statusMessage.edit({ content: formatJob(changedJob), allowedMentions: { parse: [] } });
        },
        execute: async (runningJob) => {
          const result = await opencode.runTask({
            directory: project.directory,
            title: `Discord: ${truncate(task.replace(/\s+/g, " "), 80)}`,
            task,
            signal: runningJob.controller.signal,
            onSession: (sessionId) => {
              runningJob.sessionId = sessionId;
            },
          });
          return formatResult(result);
        },
      });
      await statusMessage.edit({ content: formatJob(job), allowedMentions: { parse: [] } });
    } catch (error) {
      await statusMessage.edit({
        content: truncate(`Request failed: ${error instanceof Error ? error.message : String(error)}`, DISCORD_LIMIT),
        allowedMentions: { parse: [] },
      });
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
