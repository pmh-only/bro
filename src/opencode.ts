import {
  createOpencodeClient,
  type FileDiff,
  type Message,
  type OpencodeClient,
  type Part,
  type Session,
  type Todo,
} from "@opencode-ai/sdk";
import {
  Agent,
  fetch as undiciFetch,
  type RequestInfo as UndiciRequestInfo,
  type RequestInit as UndiciRequestInit,
} from "undici";
import type { OpenCodeAttachment } from "./attachments.js";
import type { AppConfig } from "./config.js";
import { intentSchema, type NaturalLanguageIntent, type RoutableJob, validateIntent } from "./intents.js";
import type { JobScope } from "./jobs.js";

export const opencodeDispatcherOptions = {
  headersTimeout: 0,
  bodyTimeout: 0,
} as const;

export interface TaskResult {
  sessionId: string;
  webUrl: string;
  response: string;
  diffs: FileDiff[];
  deniedPermissions: string[];
}

export interface AsyncTaskSession {
  sessionId: string;
  webUrl: string;
}

export interface TaskSnapshot {
  state: "busy" | "idle";
  successful: boolean;
  response: string;
  consumedTokens: number;
  progress?: string;
  error?: string;
  diffs: FileDiff[];
}

const successMarker = "BRO_JOB_SUCCESS";

function brief(value: string, maximum = 400): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 3).trimEnd()}...`;
}

function progressReport(todos: Todo[], parts: Part[]): string | undefined {
  if (todos.length) {
    const active = todos.filter((todo) => todo.status === "in_progress");
    const queued = todos.filter((todo) => todo.status === "pending");
    const completed = todos.filter((todo) => todo.status === "completed").length;
    const group = (label: string, items: Todo[]) => {
      const visible = items.slice(0, 2).map((todo) => `- ${brief(todo.content, 100)}`);
      if (items.length > visible.length) visible.push(`- +${items.length - visible.length} more`);
      return items.length ? [`${label} (${items.length}):`, ...visible] : [];
    };
    const activity = [
      ...group("In progress", active),
      ...group("Queued items", queued),
    ];
    if (!activity.length) activity.push("Finalizing completed steps.");
    return [...activity, `Plan: ${completed}/${todos.length} steps completed`].join("\n");
  }
  const tool = [...parts].reverse().find((part): part is Extract<Part, { type: "tool" }> =>
    part.type === "tool" && (part.state.status === "running" || part.state.status === "pending"));
  if (tool) return `Running ${brief(tool.state.status === "running" ? tool.state.title ?? tool.tool : tool.tool, 300)}`;
  const text = parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.ignored)
    .map((part) => part.text)
    .filter(Boolean)
    .at(-1);
  if (text) return brief(text);
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}

export class OpenCodeService {
  private readonly headers: Record<string, string>;
  private readonly dispatcher = new Agent(opencodeDispatcherOptions);

  constructor(private readonly config: AppConfig) {
    this.headers = config.opencodePassword
      ? { Authorization: `Basic ${Buffer.from(`${config.opencodeUsername}:${config.opencodePassword}`).toString("base64")}` }
      : {};
  }

  async assertHealthy(): Promise<string> {
    const response = await this.request(`${this.config.opencodeUrl}/global/health`, {
      headers: this.headers,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`OpenCode health check failed with HTTP ${response.status}`);
    const health = (await response.json()) as { healthy?: boolean; version?: string };
    if (!health.healthy) throw new Error("OpenCode server reported that it is unhealthy");
    return health.version ?? "unknown";
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  async interpretRequest(
    request: string,
    projectAliases: string[],
    routableJobs: RoutableJob[],
    externalSignal?: AbortSignal,
    attachments: OpenCodeAttachment[] = [],
  ): Promise<NaturalLanguageIntent> {
    const timeout = AbortSignal.timeout(this.config.routingTimeoutMs);
    const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
    const client = createOpencodeClient({
      baseUrl: this.config.opencodeUrl,
      directory: process.cwd(),
      headers: this.headers,
      fetch: (request) => this.request(request),
      throwOnError: true,
    });
    let sessionId: string | undefined;

    try {
      const tools = await client.tool.ids({ signal });
      const disabledTools = Object.fromEntries((tools.data ?? []).map((tool) => [tool, false]));

      const created = await client.session.create({ body: { title: "Temporary Discord request router" }, signal });
      sessionId = created.data?.id;
      if (!sessionId) throw new Error("OpenCode did not create the temporary routing session");

      const promptOptions = {
        path: { id: sessionId },
        body: {
          agent: this.config.opencodeAgent,
          ...this.modelSelection(),
          tools: disabledTools,
          format: { type: "json_schema", schema: intentSchema, retryCount: 2 },
          parts: this.promptParts(this.routingPrompt(request, projectAliases, routableJobs), attachments),
        },
        signal,
      } as unknown as Parameters<typeof client.session.prompt>[0];
      const result = await client.session.prompt(promptOptions);
      const data = result.data as
        | { info: { error?: { data?: unknown }; structured?: unknown }; parts: Part[] }
        | undefined;
      if (data?.info.error) throw new Error(`OpenCode routing failed: ${errorMessage(data.info.error.data)}`);

      let structured = data?.info.structured;
      if (structured === undefined) {
        const text = this.textResponse(data?.parts ?? []);
        if (text) structured = JSON.parse(text) as unknown;
      }
      return validateIntent(structured, routableJobs);
    } catch (error) {
      if (timeout.aborted && !externalSignal?.aborted) {
        throw new Error(`OpenCode request routing timed out after ${Math.round(this.config.routingTimeoutMs / 1_000)} seconds`);
      }
      throw error;
    } finally {
      if (sessionId) {
        try {
          await client.session.delete({ path: { id: sessionId }, signal: AbortSignal.timeout(5_000) });
        } catch (error) {
          console.warn(`Unable to delete temporary OpenCode session ${sessionId}:`, error);
        }
      }
    }
  }

  async ensureTaskSession(
    directory: string,
    title: string,
    signal: AbortSignal,
    reuseExisting = true,
  ): Promise<AsyncTaskSession> {
    const client = this.client(directory);
    const session = await this.projectSession(client, directory, title, signal, reuseExisting);
    return { sessionId: session.id, webUrl: this.sessionUrl(directory, session.id) };
  }

  async submitTask(
    directory: string,
    sessionId: string,
    task: string,
    continuation: boolean,
    signal: AbortSignal,
    scope: JobScope = "project",
    attachments: OpenCodeAttachment[] = [],
  ): Promise<void> {
    const text = continuation
      ? [
          "The persisted Discord job is still incomplete. Continue working on the original task end-to-end.",
          "Continue using the existing OpenCode goal and keep it aligned with the original task.",
          scope === "global"
            ? "Inspect the current environment and session state, finish the requested global work, and verify the result."
            : "Inspect the current repository and session state, finish verification, and commit all intended changes.",
          ...this.executionRules(scope),
          ...this.languageRules(),
          "Before reporting success, close the goal as complete with concise evidence from the verification you performed.",
          `Only when every requested step has succeeded, end your response with ${successMarker}.`,
          "",
          task,
        ].join("\n")
      : this.prompt(task, scope);
    await this.client(directory).session.promptAsync({
      path: { id: sessionId },
      body: {
        agent: this.config.opencodeAgent,
        ...this.modelSelection(),
        tools: { question: false },
        parts: this.promptParts(text, attachments),
      },
      signal,
    } as unknown as Parameters<OpencodeClient["session"]["promptAsync"]>[0]);
  }

  async submitInstruction(
    directory: string,
    sessionId: string,
    instruction: string,
    signal: AbortSignal,
    messageId?: string,
    scope: JobScope = "project",
    attachments: OpenCodeAttachment[] = [],
  ): Promise<void> {
    await this.client(directory).session.promptAsync({
      path: { id: sessionId },
      body: {
        ...(messageId ? { messageID: messageId } : {}),
        agent: this.config.opencodeAgent,
        ...this.modelSelection(),
        tools: { question: false },
        parts: [{
          type: "text",
          text: [
            "Additional instruction from the authorized Discord user for the current job:",
            instruction,
            "Call update_goal_objective so the existing OpenCode goal covers this instruction as well as any unfinished original work.",
            ...this.executionRules(scope),
            ...this.languageRules(),
            `Only after this instruction is fully completed and verified, end your response with ${successMarker}.`,
          ].join("\n\n"),
        }, ...this.fileParts(attachments)],
      },
      signal,
    } as unknown as Parameters<OpencodeClient["session"]["promptAsync"]>[0]);
  }

  async submitConflictResolution(
    directory: string,
    sessionId: string,
    conflictFiles: string[],
    signal: AbortSignal,
  ): Promise<void> {
    await this.submitInstruction(
      directory,
      sessionId,
      [
        "A rebase onto changes from an earlier parallel job has conflicts.",
        `Conflicting files: ${conflictFiles.join(", ") || "inspect git status"}`,
        "Resolve every conflict while preserving both the earlier integrated behavior and this job's requested behavior.",
        "Run relevant tests, stage the resolutions, and continue the existing rebase with GIT_EDITOR=true git rebase --continue.",
        "Resolve every subsequent conflict and recommit as required. Do not merge, abort, skip commits, reset, or push.",
      ].join("\n"),
      signal,
    );
  }

  async taskSnapshot(
    directory: string,
    sessionId: string,
    after: number,
    signal: AbortSignal,
    tokenAfter = 0,
  ): Promise<TaskSnapshot> {
    const client = this.client(directory);
    const [statuses, messages] = await Promise.all([
      client.session.status({ query: { directory }, signal }),
      client.session.messages({ path: { id: sessionId }, query: { directory }, signal }),
    ]);
    const consumedTokens = this.consumedTokens(messages.data ?? [], tokenAfter);
    const status = statuses.data?.[sessionId];
    const assistant = [...(messages.data ?? [])]
      .reverse()
      .find((message) => message.info.role === "assistant" && message.info.time.created >= after);
    const parts = assistant?.parts ?? [];
    const todosUpdated = parts.some((part) =>
      part.type === "tool" && part.tool === "todowrite" && part.state.status === "completed");
    const todos = todosUpdated
      ? await client.session.todo({ path: { id: sessionId }, query: { directory }, signal })
      : undefined;
    const progress = assistant ? progressReport(todos?.data ?? [], parts) : undefined;
    if (status && status.type !== "idle") {
      return { state: "busy", successful: false, response: "", consumedTokens, ...(progress ? { progress } : {}), diffs: [] };
    }
    if (!assistant || assistant.info.role !== "assistant") {
      return { state: "idle", successful: false, response: "", consumedTokens, ...(progress ? { progress } : {}), diffs: [] };
    }
    const response = this.textResponse(assistant.parts);
    const successful = response.includes(successMarker) && !assistant.info.error;
    let diffs: FileDiff[] = [];
    if (successful) {
      const result = await client.session.diff({ path: { id: sessionId }, query: { directory }, signal });
      diffs = result.data ?? [];
    }
    return {
      state: "idle",
      successful,
      response: response.replace(successMarker, "").trim(),
      consumedTokens,
      ...(progress ? { progress } : {}),
      ...(assistant.info.error ? { error: errorMessage(assistant.info.error.data) } : {}),
      diffs,
    };
  }

  async taskTokenCount(directory: string, sessionId: string, after: number, signal: AbortSignal): Promise<number> {
    const messages = await this.client(directory).session.messages({
      path: { id: sessionId },
      query: { directory },
      signal,
    });
    return this.consumedTokens(messages.data ?? [], after);
  }

  async abortTask(directory: string, sessionId: string, signal: AbortSignal): Promise<void> {
    await this.client(directory).session.abort({ path: { id: sessionId }, query: { directory }, signal });
  }

  async resolvePendingRequests(directory: string, sessionId: string, signal: AbortSignal): Promise<void> {
    const [permissions, questions] = await Promise.all([
      this.get<Array<{ id: string; sessionID: string }>>("/permission", directory, signal),
      this.get<Array<{ id: string; sessionID: string }>>("/question", directory, signal),
    ]);
    for (const permission of permissions.filter((request) => request.sessionID === sessionId)) {
      await this.post(
        `/permission/${encodeURIComponent(permission.id)}/reply`,
        directory,
        { reply: this.config.opencodeAutoApprove ? "once" : "reject" },
        signal,
      );
    }
    for (const question of questions.filter((request) => request.sessionID === sessionId)) {
      await this.post(`/question/${encodeURIComponent(question.id)}/reject`, directory, undefined, signal);
    }
  }

  private prompt(task: string, scope: JobScope): string {
    return [
      scope === "global"
        ? "Complete this authorized global Discord request end-to-end using one job without a Git worktree."
        : "Complete this authorized Discord request end-to-end in the current project.",
      ...this.executionRules(scope),
      ...this.languageRules(),
      "Make reasonable implementation decisions without asking interactive questions and run relevant verification.",
      "Use OpenCode goal mode for this job. At the start, call create_goal with a concrete objective based on the request.",
      "Before reporting success, call update_goal with status complete and concise evidence from the verification you performed.",
      ...(scope === "project" ? [
        "After completing and verifying the requested work, commit all intended changes. The coordinator will integrate and push them.",
        "Always include this Git trailer in the commit: Co-authored-by: Bro, the bot <bro@pmh.codes>",
      ] : []),
      `Only when every requested step has succeeded, end your response with ${successMarker}.`,
      "",
      task,
    ].join("\n");
  }

  private executionRules(scope: JobScope): string[] {
    if (scope === "global") {
      return [
        "This job is for environment-wide work and shell actions; it is not associated with a project or source repository.",
        "You are authorized to install any required OS packages, databases, CLIs, runtimes, libraries, and services.",
        "You may create or modify system, service, tool, or environment configuration required to complete the task.",
        "Do not access, modify, or delete any registered project or source repository.",
        "Do not create, switch, merge, or delete Git branches or worktrees, and do not commit, pull, push, force-push, or rebase.",
      ];
    }
    return [
      "You are authorized to install any required OS packages, databases, CLIs, runtimes, libraries, and services.",
      "You may create or modify files outside the current project when required to complete the task, including system, service, tool, or environment configuration.",
      "Do not access, modify, or delete files in any other project or source repository; keep all application code changes scoped to the current project.",
      "Work only on the current worktree branch. Do not create, switch, merge, delete branches or worktrees, or initiate a rebase; only continue an existing rebase when explicitly instructed to resolve conflicts.",
      "Do not pull, push, force-push, or otherwise update remotes; the coordinator performs rebase-only integration.",
    ];
  }

  private languageRules(): string[] {
    return [
      "Always process the request in English, translating non-English input internally before acting on it.",
      "Write all visible analysis, plans, todo items, tool narration, progress updates, prompts, and summaries in English.",
      "Write the final response as a concise English summary of the completed work and verification.",
    ];
  }

  private async projectSession(
    client: OpencodeClient,
    directory: string,
    title: string,
    signal: AbortSignal,
    reuseExisting: boolean,
  ): Promise<Session> {
    if (reuseExisting) {
      const listed = await client.session.list({ query: { directory }, signal });
      const existing = (listed.data ?? [])
        .filter((session) => session.directory === directory && !session.parentID && session.title.startsWith("Discord:"))
        .sort((left, right) => right.time.updated - left.time.updated)[0];
      if (existing) return existing;
    }

    const created = await client.session.create({ body: { title }, query: { directory }, signal });
    if (!created.data) throw new Error("OpenCode did not return the created session");
    return created.data;
  }

  private modelSelection(): Record<string, unknown> {
    if (!this.config.opencodeModel) return {};
    return {
      model: {
        ...this.config.opencodeModel,
        ...(this.config.opencodeReasoningEffort ? { variant: this.config.opencodeReasoningEffort } : {}),
      },
    };
  }

  private promptParts(text: string, attachments: OpenCodeAttachment[]): Array<Record<string, string>> {
    return [{ type: "text", text }, ...this.fileParts(attachments)];
  }

  private fileParts(attachments: OpenCodeAttachment[]): Array<Record<string, string>> {
    return attachments.map((attachment) => ({
      type: "file",
      mime: attachment.mime,
      url: attachment.url,
      ...(attachment.filename ? { filename: attachment.filename } : {}),
    }));
  }

  private client(directory: string): OpencodeClient {
    return createOpencodeClient({
      baseUrl: this.config.opencodeUrl,
      directory,
      headers: this.headers,
      fetch: (request) => this.request(request),
      throwOnError: true,
    });
  }

  private routingPrompt(request: string, projectAliases: string[], routableJobs: RoutableJob[]): string {
    return [
      "Interpret the authorized Discord user's natural-language request. Do not execute it.",
      "Perform the interpretation in English. Translate non-English input faithfully without changing its meaning.",
      "Always write task and message fields in English. Preserve project aliases, repository URLs, and job IDs exactly.",
      "Return exactly one structured intent using these rules:",
      "- run: start independent parallel work in an existing project. Use an exact alias and preserve the requested work in task.",
      "- global: run one environment-wide task or shell action that is not tied to a registered project. Set project to null and preserve the requested work in task. Never use global to modify registered projects.",
      "- instruction: modify exactly one listed parallel job. Set its exact jobId and choose queue, steer, or replace in instructionAction.",
      "- queue: use for non-urgent follow-up work after that job's active and pending instructions succeed.",
      "- steer: interrupt that job, run this next, then preserve its pending instructions.",
      "- replace: use only when the request clearly supersedes that job's active work and pending instructions.",
      "Never target a job merely because it is the only job in a project. Use instruction only when the request clearly continues or changes that exact job.",
      "- clone: clone and register a Git repository. Set repository to a complete HTTPS or SSH URL, project to the requested friendly name, and task to any work requested after cloning or null.",
      "- projects: list registered projects.",
      "- status: show active jobs or one job. Set jobId when supplied.",
      "- cancel: cancel a job and set jobId.",
      "- history: show or hide completed, failed, and cancelled jobs in the Web UI. Set historyVisible to true to show them or false to hide them.",
      "- help: explain capabilities.",
      "- unknown: the request lacks necessary information. Put a concise clarification in message.",
      "Never invent repository URLs, project aliases, job IDs, or implementation tasks.",
      `Registered project aliases: ${JSON.stringify(projectAliases)}`,
      `Parallel jobs eligible for instructions: ${JSON.stringify(routableJobs)}`,
      `User request: ${JSON.stringify(request)}`,
    ].join("\n");
  }

  private async post(
    path: string,
    directory: string,
    body: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const url = new URL(path, `${this.config.opencodeUrl}/`);
    url.searchParams.set("directory", directory);
    const response = await this.request(url, {
      method: "POST",
      headers: { ...this.headers, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
    });
    if (!response.ok) throw new Error(`OpenCode ${path} failed with HTTP ${response.status}`);
  }

  private async get<T>(path: string, directory: string, signal: AbortSignal): Promise<T> {
    const url = new URL(path, `${this.config.opencodeUrl}/`);
    url.searchParams.set("directory", directory);
    const response = await this.request(url, { headers: this.headers, signal });
    if (!response.ok) throw new Error(`OpenCode ${path} failed with HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  private request(input: string | URL | Request, init?: RequestInit): ReturnType<typeof fetch> {
    const nativeRequest = input instanceof Request ? input : undefined;
    const requestInit = nativeRequest
      ? {
          method: nativeRequest.method,
          headers: Object.fromEntries(nativeRequest.headers),
          ...(nativeRequest.body ? { body: nativeRequest.body, duplex: "half" as const } : {}),
          redirect: nativeRequest.redirect,
          signal: nativeRequest.signal,
        }
      : init;
    return undiciFetch((nativeRequest?.url ?? input) as UndiciRequestInfo, {
      ...requestInit,
      dispatcher: this.dispatcher,
    } as UndiciRequestInit) as unknown as ReturnType<typeof fetch>;
  }

  private textResponse(parts: Part[]): string {
    return parts
      .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.ignored)
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n\n");
  }

  private consumedTokens(messages: Array<{ info: Message; parts: Part[] }>, after: number): number {
    return messages.reduce((total, message) => {
      if (message.info.role !== "assistant" || message.info.time.created < after) return total;
      const steps = message.parts.filter((part): part is Extract<Part, { type: "step-finish" }> =>
        part.type === "step-finish");
      const usages = steps.length ? steps.map((step) => step.tokens) : [message.info.tokens];
      return total + usages.reduce((messageTotal, tokens) => messageTotal
        + (tokens?.input ?? 0)
        + (tokens?.output ?? 0)
        + (tokens?.reasoning ?? 0)
        + (tokens?.cache?.read ?? 0)
        + (tokens?.cache?.write ?? 0), 0);
    }, 0);
  }

  private sessionUrl(directory: string, sessionId: string): string {
    const encodedDirectory = Buffer.from(directory).toString("base64url");
    return `${this.config.opencodePublicUrl}/${encodedDirectory}/session/${sessionId}`;
  }
}
