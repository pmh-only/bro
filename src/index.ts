import "dotenv/config";
import { dirname } from "node:path";
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
import {
  cardComponents,
  instructionChoiceComponents,
  jobComponents,
  jobInstructionModal,
  parseInstructionChoice,
  parseJobButton,
} from "./components.js";
import { loadConfig } from "./config.js";
import { loginWithRetry } from "./discord.js";
import {
  committedChangeStats,
  type ChangeStats,
  discardJobWorktree,
  integrateJobWorktree,
  prepareJobWorktree,
  removeJobWorktree,
} from "./git.js";
import { type Job, type JobInstruction, JobStore } from "./jobs.js";
import { terminalJobNotice } from "./notices.js";
import { OpenCodeService, type TaskResult } from "./opencode.js";
import { ProjectRegistry } from "./projects.js";
import { closeThreadServer, startThreadServer } from "./web.js";

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
  const heading = job.scope === "global"
    ? `Global job \`${job.id}\``
    : `Job \`${job.id}\` on **${inline(job.project.alias)}**`;
  const elapsed = duration(job);
  if (job.state === "queued") {
    return `${heading}\nWaiting for the current ${job.scope === "global" ? "global" : "project"} job to finish.`;
  }
  if (job.state === "running") {
    const session = job.sessionId ? `\nOpenCode session: \`${job.sessionId}\`` : "";
    const attempts = job.promptAttempts > 1 ? `\nContinuation attempts: ${job.promptAttempts - 1}` : "";
    const progress = job.progress ? `\n\n**Progress**\n${truncate(job.progress, 500)}` : "";
    return `${heading}${session}${attempts}${progress}`;
  }
  if (job.state === "cancelling") return `${heading}\nStopping the OpenCode session...`;
  if (job.state === "integrating") return `${heading}\nWaiting for ordered rebase-only integration.`;
  if (job.state === "conflicted") return `${heading}\nResolving rebase conflicts from earlier parallel work.\n${job.error ?? "Inspecting conflicts."}`;
  if (job.state === "completed") return truncate(`${heading}${elapsed ? ` in ${elapsed}` : ""}\n${job.result || "OpenCode completed without a text response."}`, DISCORD_LIMIT);
  if (job.state === "cancelled") return `${heading}${elapsed ? ` after ${elapsed}` : ""}.`;
  return truncate(`${heading}${elapsed ? ` after ${elapsed}` : ""}\n${job.error || "Unknown error"}`, DISCORD_LIMIT);
}

function formatResult(result: TaskResult, committed?: ChangeStats): string {
  const session = {
    files: result.diffs.length,
    additions: result.diffs.reduce((sum, diff) => sum + diff.additions, 0),
    deletions: result.diffs.reduce((sum, diff) => sum + diff.deletions, 0),
  };
  const changes = committed?.files ? committed : session;
  const changed = changes.files
    ? `Changes: ${changes.files} file(s), +${changes.additions}/-${changes.deletions}`
    : "Changes: no file changes reported";
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
  const globalProject = { alias: "Global", directory: dirname(config.jobsDatabase) };
  const requestControllers = new Set<AbortController>();
  const executionDirectory = (job: Job) => job.worktreeDirectory ?? job.project.directory;

  let client: Client;
  let threadServer: Awaited<ReturnType<typeof startThreadServer>> | undefined;

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
    message.edit({ components: jobComponents(job, formatJob(job), config.codeServerPublicUrl), allowedMentions: { parse: [] } });

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
  let pollRequested = false;
  let controlsWaiting = 0;
  let pollTimer: NodeJS.Timeout | undefined;

  const publishFinishedJob = async (job: Job) => {
    await publishJob(job);
    const notice = terminalJobNotice(job);
    if (notice && !job.notified) {
      await notifyJob(job, notice);
      job.notified = true;
      jobs.save(job);
    }
  };

  const finishJob = async (job: Job, state: "completed" | "failed" | "cancelled", result?: string, error?: string) => {
    job.state = state;
    job.finishedAt = Date.now();
    delete job.progress;
    if (result !== undefined) job.result = result;
    if (error !== undefined) job.error = error;
    jobs.save(job);
    await publishFinishedJob(job);
  };

  const dispatchInstruction = async (job: Job, instruction: JobInstruction) => {
    job.lastPromptAt = Date.now();
    job.progress = "Applying the next instruction.";
    jobs.save(job);
    await publishJob(job);
    await opencode.submitInstruction(
      executionDirectory(job),
      job.sessionId!,
      instruction.content,
      AbortSignal.timeout(30_000),
      `msg_bro_${job.id}_${instruction.id}`,
      job.scope,
    );
    jobs.markInstructionSent(instruction.id);
  };

  const integrateJob = async (job: Job): Promise<void> => {
    if (!jobs.canIntegrate(job)) return;
    if (!job.worktreeDirectory || !job.worktreeBranch || !job.targetBranch || !job.baseCommit) {
      throw new Error(`Job ${job.id} is missing worktree integration metadata`);
    }
    const integration = await integrateJobWorktree(
      job.project.directory,
      job.worktreeDirectory,
      job.worktreeBranch,
      job.targetBranch,
      job.baseCommit,
      AbortSignal.timeout(60_000),
      job.integrationBase && job.integrationHead
        ? { onto: job.integrationBase, head: job.integrationHead }
        : undefined,
      (checkpoint) => {
        job.integrationBase = checkpoint.onto;
        job.integrationHead = checkpoint.head;
        jobs.save(job);
      },
    );
    if (integration.state === "conflicted") {
      job.state = "conflicted";
      job.error = `Conflicts: ${integration.conflictFiles?.join(", ") || "rebase continuation required"}`;
      job.progress = "Resolving rebase conflicts from earlier parallel work.";
      job.lastPromptAt = Date.now();
      jobs.save(job);
      await publishJob(job);
      await opencode.submitConflictResolution(
        job.worktreeDirectory,
        job.sessionId!,
        integration.conflictFiles ?? [],
        AbortSignal.timeout(30_000),
      );
      return;
    }

    const committed = await committedChangeStats(
      job.worktreeDirectory,
      integration.onto!,
      AbortSignal.timeout(10_000),
    );
    job.integrationBase = integration.onto!;
    job.integrationHead = integration.head!;
    job.state = "completed";
    job.finishedAt = Date.now();
    job.result = formatResult({
      sessionId: job.sessionId!,
      webUrl: job.sessionUrl ?? "",
      response: job.result ?? "",
      diffs: [],
      deniedPermissions: [],
    }, committed);
    delete job.progress;
    delete job.error;
    jobs.save(job);
    await publishFinishedJob(job);
    try {
      await removeJobWorktree(
        job.project.directory,
        job.worktreeDirectory,
        job.worktreeBranch,
        AbortSignal.timeout(30_000),
      );
    } catch (error) {
      console.warn(`Unable to clean worktree for completed job ${job.id}`, error);
    }
  };

  const pollJob = async (job: Job): Promise<void> => {
    if (job.state === "integrating") {
      await integrateJob(job);
      return;
    }
    if (job.state === "cancelling") {
      if (job.sessionId) {
        await opencode.abortTask(executionDirectory(job), job.sessionId, AbortSignal.timeout(10_000));
      }
      if (job.worktreeDirectory && job.worktreeBranch) {
        await discardJobWorktree(
          job.project.directory,
          job.worktreeDirectory,
          job.worktreeBranch,
          AbortSignal.timeout(30_000),
        );
      }
      await finishJob(job, "cancelled");
      return;
    }
    if (!job.sessionId || !job.lastPromptAt) return;
    if (job.interruptAction) {
      await opencode.abortTask(executionDirectory(job), job.sessionId, AbortSignal.timeout(10_000));
      const instruction = jobs.pendingInstructions(job.id)[0];
      if (instruction) await dispatchInstruction(job, instruction);
      jobs.clearInterruptAction(job.id);
      delete job.interruptAction;
      return;
    }
    if (job.state === "running" && job.startedAt && Date.now() - job.startedAt >= config.taskTimeoutMs) {
      await opencode.abortTask(executionDirectory(job), job.sessionId, AbortSignal.timeout(10_000)).catch(() => undefined);
      if (job.worktreeDirectory && job.worktreeBranch) {
        await discardJobWorktree(
          job.project.directory,
          job.worktreeDirectory,
          job.worktreeBranch,
          AbortSignal.timeout(30_000),
        );
      }
      await finishJob(job, "failed", undefined, `OpenCode task timed out after ${Math.round(config.taskTimeoutMs / 60_000)} minutes`);
      return;
    }

    await opencode.resolvePendingRequests(
      executionDirectory(job),
      job.sessionId,
      AbortSignal.timeout(config.jobPollIntervalMs),
    );

    const snapshot = await opencode.taskSnapshot(
      executionDirectory(job),
      job.sessionId,
      job.lastPromptAt,
      AbortSignal.timeout(config.jobPollIntervalMs),
    );
    if (jobs.get(job.id)?.interruptAction) return;
    if (snapshot.progress && snapshot.progress !== job.progress) {
      job.progress = snapshot.progress;
      jobs.save(job);
      await publishJob(job);
    }
    if (snapshot.state === "busy") return;
    if (job.state === "conflicted") {
      if (snapshot.successful) {
        job.state = "integrating";
        job.progress = "Rechecking resolved rebase conflicts.";
        jobs.save(job);
        await integrateJob(job);
      } else if (Date.now() - job.lastPromptAt >= config.jobContinueIntervalMs) {
        job.lastPromptAt = Date.now();
        jobs.save(job);
        await opencode.submitConflictResolution(
          executionDirectory(job),
          job.sessionId,
          [],
          AbortSignal.timeout(30_000),
        );
      }
      return;
    }
    if (snapshot.successful) {
      const activeInstruction = jobs.activeInstruction(job.id);
      if (activeInstruction) jobs.markInstructionCompleted(activeInstruction.id);
      const instruction = jobs.pendingInstructions(job.id)[0];
      if (instruction) {
        await dispatchInstruction(job, instruction);
        return;
      }
      if (!job.worktreeDirectory) {
        let committed: ChangeStats | undefined;
        if (job.baseCommit) {
          committed = await committedChangeStats(job.project.directory, job.baseCommit, AbortSignal.timeout(10_000))
            .catch(() => undefined);
        }
        await finishJob(job, "completed", formatResult({
          sessionId: job.sessionId,
          webUrl: job.sessionUrl ?? "",
          response: snapshot.response,
          diffs: snapshot.diffs,
          deniedPermissions: [],
        }, committed));
        return;
      }
      const integrating = jobs.beginIntegrationIfIdle(job.id, snapshot.response);
      if (integrating) {
        await publishJob(integrating);
        await integrateJob(integrating);
      }
      return;
    }
    if (Date.now() - job.lastPromptAt < config.jobContinueIntervalMs) return;

    job.promptAttempts += 1;
    job.lastPromptAt = Date.now();
    job.progress = "Continuing unfinished work.";
    if (snapshot.error) job.error = snapshot.error;
    jobs.save(job);
    const currentTask = jobs.activeInstruction(job.id)?.content ?? job.task;
    await opencode.submitTask(executionDirectory(job), job.sessionId, currentTask, true, AbortSignal.timeout(30_000), job.scope);
    await publishJob(job);
  };

  const startJob = async (job: Job): Promise<void> => {
    let directory = job.project.directory;
    if (job.scope === "project") {
      const prepared = await prepareJobWorktree(
        job.project.directory,
        config.worktreesRoot,
        job.id,
        AbortSignal.timeout(30_000),
        job.targetBranch,
      );
      directory = prepared.directory;
      job.worktreeDirectory = prepared.directory;
      job.worktreeBranch = prepared.branch;
      job.targetBranch = prepared.targetBranch;
      job.baseCommit ??= prepared.baseCommit;
      jobs.save(job);
    }
    const session = await opencode.ensureTaskSession(
      directory,
      `Discord: ${truncate(job.task.replace(/\s+/g, " "), 80)}`,
      AbortSignal.timeout(30_000),
      job.scope === "project",
    );
    job.state = "running";
    job.startedAt ??= Date.now();
    job.sessionId = session.sessionId;
    job.sessionUrl = session.webUrl;
    job.promptAttempts += 1;
    job.lastPromptAt = Date.now();
    job.progress = "Starting OpenCode task.";
    jobs.save(job);
    await publishJob(job);
    await opencode.submitTask(directory, job.sessionId, job.task, false, AbortSignal.timeout(30_000), job.scope);
  };

  const runPoll = async (): Promise<void> => {
    for (const job of jobs.active().filter((candidate) => candidate.state !== "queued")) {
      try {
        await pollJob(job);
      } catch (error) {
        console.error(`Unable to poll OpenCode job ${job.id}`, error);
        job.error = error instanceof Error ? error.message : String(error);
        jobs.save(job);
        await publishJob(job);
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
    if (polling) {
      pollRequested = true;
      return polling;
    }
    polling = runPoll().finally(() => {
      polling = undefined;
      if (pollRequested && controlsWaiting === 0) {
        pollRequested = false;
        void pollJobs();
      }
    });
    return polling;
  }

  async function withPollingPaused<T>(action: () => T): Promise<T> {
    controlsWaiting += 1;
    try {
      while (polling) await polling;
      return action();
    } finally {
      controlsWaiting -= 1;
      if (controlsWaiting === 0 && pollRequested) {
        pollRequested = false;
        void pollJobs();
      }
    }
  }

  const handleMessage = async (message: Message): Promise<void> => {
    if (shuttingDown) return;
    if (message.author.bot || !client.user) return;
    const mentioned = hasBotMention(message.content, client.user.id);
    const referencedJob = message.reference?.messageId
      ? jobs.runningByMessage(message.reference.channelId ?? message.channelId, message.reference.messageId)
      : undefined;
    if (!mentioned && !referencedJob) return;
    if (!authorized(message.guildId, message.channelId, message.author.id, roleIds(message.member))) {
      await reply(message, "You are not authorized to run OpenCode tasks.");
      return;
    }

    if (referencedJob) {
      const instruction = mentioned ? stripBotMention(message.content, client.user.id) : message.content.trim();
      if (!instruction) {
        await reply(message, "Reply with the instruction you want OpenCode to apply.");
        return;
      }
      const choice = jobs.createInstructionChoice(referencedJob.id, instruction, message.author.id);
      await message.reply({
        components: instructionChoiceComponents(choice.id, referencedJob.id),
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [], repliedUser: false },
      });
      return;
    }

    const statusMessage = await replyCard(message, "Understanding request", "OpenCode is interpreting your request.");
    const requestController = new AbortController();
    requestControllers.add(requestController);
    try {
      const request = stripBotMention(message.content, client.user.id);
      const routableJobs = jobs.active()
        .filter((job) => job.state === "running" && job.sessionId
          && (message.guildId ? job.guildId === message.guildId : !job.guildId && job.channelId === message.channelId))
        .map((job) => ({ id: job.id, project: job.project.alias, task: job.task }));
      const intent = await opencode.interpretRequest(
        request,
        projects.list().map((project) => project.alias),
        routableJobs,
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
            "Ask for global environment work or shell actions that are not tied to a project.",
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
              ? active.map((job) => job.scope === "global"
                ? `\`${job.id}\` ${job.state} globally`
                : `\`${job.id}\` ${job.state} on **${inline(job.project.alias)}**`).join("\n")
              : "There are no active jobs.",
          );
        }
        return;
      }

      if (intent.action === "cancel") {
        const job = await withPollingPaused(() => jobs.cancel(intent.jobId!));
        if (job) await editJob(statusMessage, job);
        else await editCard(statusMessage, "Job not found", `Active job \`${inline(intent.jobId!)}\` was not found.`);
        if (job) void pollJobs();
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

      if (intent.action === "instruction") {
        const target = jobs.get(intent.jobId!);
        if (!target || target.state !== "running" || !target.sessionId) {
          await editCard(statusMessage, "Instruction unavailable", `Job \`${inline(intent.jobId!)}\` is no longer accepting instructions.`);
          return;
        }
        const choice = jobs.createInstructionChoice(target.id, intent.task!, message.author.id);
        const resolved = await withPollingPaused(() => jobs.resolveInstructionChoice(
          choice.id,
          intent.instructionAction!,
          message.author.id,
        ));
        if (!resolved) {
          await editCard(statusMessage, "Instruction unavailable", `Job \`${target.id}\` changed before the instruction could be scheduled.`);
          return;
        }
        await editCard(
          statusMessage,
          "Instruction scheduled",
          `Router selected **${intent.instructionAction}** for parallel job \`${target.id}\` on **${inline(target.project.alias)}**.`,
        );
        if (intent.instructionAction !== "queue") await publishJob(resolved.job);
        void pollJobs();
        return;
      }

      if (intent.action === "global") {
        if (!intent.task) throw new Error("OpenCode did not identify the global task");
        const job = jobs.enqueue({
          scope: "global",
          project: globalProject,
          task: intent.task,
          requestedBy: message.author.id,
          channelId: message.channelId,
          messageId: statusMessage.id,
          ...(message.guildId ? { guildId: message.guildId } : {}),
        });
        await editJob(statusMessage, job);
        void pollJobs();
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
    if (!interaction.isButton() && !interaction.isModalSubmit()) return;
    const instructionControl = parseInstructionChoice(interaction.customId);
    const control = parseJobButton(interaction.customId);
    if (!control && !instructionControl) return;

    void (async () => {
      const roles = interaction.inCachedGuild() ? roleIds(interaction.member) : new Set<string>();
      if (!interaction.channelId || !authorized(interaction.guildId, interaction.channelId, interaction.user.id, roles)) {
        await interaction.reply({ content: "You are not authorized to control OpenCode jobs.", flags: MessageFlags.Ephemeral });
        return;
      }

      if (instructionControl) {
        if (!interaction.isButton()) return;
        const choice = jobs.getInstructionChoice(instructionControl.choiceId);
        if (!choice || choice.requestedBy !== interaction.user.id) {
          await interaction.reply({ content: "Only the user who submitted this instruction can choose its action.", flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.deferUpdate();
        const resolved = await withPollingPaused(() => jobs.resolveInstructionChoice(
          instructionControl.choiceId,
          instructionControl.action,
          interaction.user.id,
        ));
        if (!resolved) {
          await interaction.editReply({
            components: cardComponents("Instruction unavailable", "This choice was already used or its job is no longer running."),
            allowedMentions: { parse: [] },
          });
          return;
        }
        await interaction.editReply({
          components: cardComponents(
            "Instruction scheduled",
            `**${instructionControl.action[0]!.toUpperCase()}${instructionControl.action.slice(1)}** selected for job \`${resolved.job.id}\`.`,
          ),
          allowedMentions: { parse: [] },
        });
        if (instructionControl.action !== "queue") await publishJob(resolved.job);
        void pollJobs();
        return;
      }

      if (!control) return;
      const job = jobs.get(control.jobId);
      if (!job) {
        await interaction.reply({ content: `Job \`${control.jobId}\` was not found.`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.isModalSubmit()) {
        if (control.action !== "prompt" || job.state !== "running" || !job.sessionId) {
          await interaction.reply({ content: "This job is no longer accepting instructions.", flags: MessageFlags.Ephemeral });
          return;
        }
        const instruction = interaction.fields.getTextInputValue("instruction").trim();
        if (!instruction) {
          await interaction.reply({ content: "Instruction cannot be empty.", flags: MessageFlags.Ephemeral });
          return;
        }
        const choice = jobs.createInstructionChoice(job.id, instruction, interaction.user.id);
        await interaction.reply({
          components: instructionChoiceComponents(choice.id, job.id),
          flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
          allowedMentions: { parse: [] },
        });
        return;
      }

      if (control.action === "refresh") {
        await interaction.update({ components: jobComponents(job, formatJob(job), config.codeServerPublicUrl), allowedMentions: { parse: [] } });
        return;
      }
      if (control.action === "prompt") {
        if (job.state !== "running" || !job.sessionId) {
          await interaction.reply({ content: "This job is not currently accepting instructions.", flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.showModal(jobInstructionModal(job.id));
        return;
      }

      await interaction.deferUpdate();
      const current = await withPollingPaused(() => {
        jobs.cancel(job.id);
        return jobs.get(job.id);
      });
      if (current) {
        await interaction.message.edit({ components: jobComponents(current, formatJob(current), config.codeServerPublicUrl), allowedMentions: { parse: [] } });
      }
      void pollJobs();
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

  threadServer = await startThreadServer(jobs, config.webPort);
  console.log(`Project thread server listening on port ${config.webPort}`);
  try {
    client = await loginWithRetry(createClient, config.discordToken, {
      onRetry: (error, delayMs) => {
        console.error(`Discord login failed; retrying in ${Math.round(delayMs / 1_000)} seconds`, error);
      },
    });
  } catch (error) {
    await closeThreadServer(threadServer);
    jobs.close();
    await opencode.close();
    throw error;
  }
  const unfinishedPublications = jobs.history().filter((job) =>
    job.state === "cancelled" || ((job.state === "completed" || job.state === "failed") && !job.notified));
  const unfinishedCleanups = jobs.history().filter((job) =>
    job.state === "completed" && job.worktreeDirectory && job.worktreeBranch);
  void Promise.all([
    ...jobs.active().map((job) => publishJob(job)),
    ...unfinishedPublications.map((job) => publishFinishedJob(job)),
    ...unfinishedCleanups.map((job) => removeJobWorktree(
      job.project.directory,
      job.worktreeDirectory!,
      job.worktreeBranch!,
      AbortSignal.timeout(30_000),
    ).catch((error) => console.warn(`Unable to recover worktree cleanup for job ${job.id}`, error))),
  ]).then(() => pollJobs());
  pollTimer = setInterval(() => void pollJobs(), config.jobPollIntervalMs);
  pollTimer.unref();

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (pollTimer) clearInterval(pollTimer);
    for (const controller of requestControllers) controller.abort(new Error("Bot is shutting down"));
    await polling;
    if (threadServer) await closeThreadServer(threadServer);
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
