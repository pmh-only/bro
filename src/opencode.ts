import { createOpencodeClient, type FileDiff, type OpencodeClient, type Part, type Session } from "@opencode-ai/sdk";
import type { AppConfig } from "./config.js";
import { intentSchema, type NaturalLanguageIntent, validateIntent } from "./intents.js";

export interface TaskResult {
  sessionId: string;
  webUrl: string;
  response: string;
  diffs: FileDiff[];
  deniedPermissions: string[];
}

export interface RunTaskOptions {
  directory: string;
  title: string;
  task: string;
  signal: AbortSignal;
  onSession: (sessionId: string, webUrl: string) => void;
}

type RuntimeEvent =
  | { type: "server.connected"; properties: Record<string, unknown> }
  | {
      type: "permission.asked";
      properties: {
        id: string;
        sessionID: string;
        permission: string;
        patterns: string[];
      };
    }
  | {
      type: "permission.updated";
      properties: {
        id: string;
        sessionID: string;
        type: string;
        title: string;
      };
    }
  | {
      type: "question.asked";
      properties: {
        id: string;
        sessionID: string;
        questions: Array<{ question: string }>;
      };
    };

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}

export class OpenCodeService {
  private readonly headers: Record<string, string>;

  constructor(private readonly config: AppConfig) {
    this.headers = config.opencodePassword
      ? { Authorization: `Basic ${Buffer.from(`${config.opencodeUsername}:${config.opencodePassword}`).toString("base64")}` }
      : {};
  }

  async assertHealthy(): Promise<string> {
    const response = await fetch(`${this.config.opencodeUrl}/global/health`, {
      headers: this.headers,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`OpenCode health check failed with HTTP ${response.status}`);
    const health = (await response.json()) as { healthy?: boolean; version?: string };
    if (!health.healthy) throw new Error("OpenCode server reported that it is unhealthy");
    return health.version ?? "unknown";
  }

  async interpretRequest(
    request: string,
    projectAliases: string[],
    externalSignal?: AbortSignal,
  ): Promise<NaturalLanguageIntent> {
    const timeout = AbortSignal.timeout(this.config.routingTimeoutMs);
    const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
    const client = createOpencodeClient({
      baseUrl: this.config.opencodeUrl,
      directory: process.cwd(),
      headers: this.headers,
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
          parts: [{ type: "text", text: this.routingPrompt(request, projectAliases) }],
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
      return validateIntent(structured);
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

  async runTask(options: RunTaskOptions): Promise<TaskResult> {
    const timeout = AbortSignal.timeout(this.config.taskTimeoutMs);
    const signal = AbortSignal.any([options.signal, timeout]);
    const client = createOpencodeClient({
      baseUrl: this.config.opencodeUrl,
      directory: options.directory,
      headers: this.headers,
      throwOnError: true,
    });
    const eventAbort = new AbortController();
    const deniedPermissions: string[] = [];
    let sessionId: string | undefined;
    let eventWatcher: Promise<void> | undefined;

    try {
      const session = await this.projectSession(client, options.directory, options.title, signal);
      sessionId = session.id;
      const webUrl = this.sessionUrl(options.directory, session.id);
      options.onSession(session.id, webUrl);

      const watcherReady = Promise.withResolvers<void>();
      const watcherSignal = AbortSignal.any([eventAbort.signal, signal]);
      eventWatcher = this.watchEvents(
        client,
        session.id,
        options.directory,
        watcherSignal,
        deniedPermissions,
        watcherReady,
      );
      await watcherReady.promise;

      const prompt = client.session.prompt({
        path: { id: session.id },
        body: {
          agent: this.config.opencodeAgent,
          ...this.modelSelection(),
          tools: { question: false },
          parts: [{ type: "text", text: this.prompt(options.task) }],
        },
        signal,
      } as unknown as Parameters<typeof client.session.prompt>[0]);
      const watcherFailure = eventWatcher.then<never>(() => {
        if (signal.aborted) throw signal.reason;
        throw new Error("OpenCode event stream ended while the task was running");
      });
      const result = await Promise.race([prompt, watcherFailure]);

      if (result.data?.info.error) {
        throw new Error(`OpenCode task failed: ${errorMessage(result.data.info.error.data)}`);
      }

      let diffs: FileDiff[] = [];
      try {
        const diffResult = await client.session.diff({ path: { id: session.id }, signal });
        diffs = diffResult.data ?? [];
      } catch (error) {
        console.warn(`Unable to fetch diff for OpenCode session ${session.id}:`, error);
      }

      signal.throwIfAborted();
      return {
        sessionId: session.id,
        webUrl,
        response: this.textResponse(result.data?.parts ?? []),
        diffs,
        deniedPermissions,
      };
    } catch (error) {
      if (sessionId && signal.aborted) {
        try {
          await client.session.abort({
            path: { id: sessionId },
            signal: AbortSignal.timeout(5_000),
          });
        } catch (abortError) {
          console.warn(`Unable to abort OpenCode session ${sessionId}:`, abortError);
        }
      }
      if (timeout.aborted && !options.signal.aborted) {
        throw new Error(`OpenCode task timed out after ${Math.round(this.config.taskTimeoutMs / 60_000)} minutes`);
      }
      throw error;
    } finally {
      eventAbort.abort();
      if (eventWatcher) {
        try {
          await eventWatcher;
        } catch (error) {
          if (!signal.aborted) throw error;
        }
      }
    }
  }

  private prompt(task: string): string {
    return [
      "Complete this authorized Discord request end-to-end in the current project.",
      "Work only inside the current project; do not access external directories.",
      "Make reasonable implementation decisions without asking interactive questions and run relevant verification.",
      "After completing and verifying the requested work, commit all intended changes and push the current branch to its configured remote.",
      "",
      task,
    ].join("\n");
  }

  private async projectSession(
    client: OpencodeClient,
    directory: string,
    title: string,
    signal: AbortSignal,
  ): Promise<Session> {
    const listed = await client.session.list({ query: { directory }, signal });
    const existing = (listed.data ?? [])
      .filter((session) => session.directory === directory && !session.parentID && session.title.startsWith("Discord:"))
      .sort((left, right) => right.time.updated - left.time.updated)[0];
    if (existing) return existing;

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

  private routingPrompt(request: string, projectAliases: string[]): string {
    return [
      "Interpret the authorized Discord user's natural-language request. Do not execute it.",
      "Return exactly one structured intent using these rules:",
      "- run: work in an existing project. Use an exact alias from the supplied project list and preserve the requested work in task.",
      "- clone: clone and register a Git repository. Set repository to a complete HTTPS or SSH URL, project to the requested friendly name, and task to any work requested after cloning or null.",
      "- projects: list registered projects.",
      "- status: show active jobs or one job. Set jobId when supplied.",
      "- cancel: cancel a job and set jobId.",
      "- help: explain capabilities.",
      "- unknown: the request lacks necessary information. Put a concise clarification in message.",
      "Never invent repository URLs, project aliases, job IDs, or implementation tasks.",
      `Registered project aliases: ${JSON.stringify(projectAliases)}`,
      `User request: ${JSON.stringify(request)}`,
    ].join("\n");
  }

  private async watchEvents(
    client: OpencodeClient,
    sessionId: string,
    directory: string,
    signal: AbortSignal,
    denied: string[],
    ready: PromiseWithResolvers<void>,
  ): Promise<void> {
    let connected = false;
    try {
      const events = await client.event.subscribe({ signal, sseMaxRetryAttempts: 1 });
      for await (const sdkEvent of events.stream) {
        const event = sdkEvent as unknown as RuntimeEvent;
        if (event.type === "server.connected") {
          connected = true;
          ready.resolve();
          continue;
        }
        if (event.properties?.sessionID !== sessionId) continue;

        if (event.type === "permission.asked") {
          const permission = event.properties;
          const approve = this.config.opencodeAutoApprove;
          if (!approve) denied.push(`${permission.permission}: ${permission.patterns.join(", ")}`);
          await this.post(
            `/permission/${encodeURIComponent(permission.id)}/reply`,
            directory,
            { reply: approve ? "once" : "reject" },
            signal,
          );
        } else if (event.type === "permission.updated") {
          const permission = event.properties;
          const approve = this.config.opencodeAutoApprove;
          if (!approve) denied.push(permission.title);
          await this.post(
            `/permission/${encodeURIComponent(permission.id)}/reply`,
            directory,
            { reply: approve ? "once" : "reject" },
            signal,
          );
        } else if (event.type === "question.asked") {
          denied.push(`Question: ${event.properties.questions.map((question) => question.question).join("; ")}`);
          await this.post(
            `/question/${encodeURIComponent(event.properties.id)}/reject`,
            directory,
            undefined,
            signal,
          );
        }
      }
      if (!connected) {
        const error = signal.aborted
          ? signal.reason instanceof Error
            ? signal.reason
            : new Error("OpenCode event stream was cancelled before connecting")
          : new Error("OpenCode event stream ended before connecting");
        ready.reject(error);
        if (!signal.aborted) throw error;
      } else if (!signal.aborted) {
        throw new Error("OpenCode event stream ended unexpectedly");
      }
    } catch (error) {
      ready.reject(error);
      if (!signal.aborted) console.error(`OpenCode event watcher failed for session ${sessionId}`, error);
      throw error;
    }
  }

  private async post(
    path: string,
    directory: string,
    body: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const url = new URL(path, `${this.config.opencodeUrl}/`);
    url.searchParams.set("directory", directory);
    const response = await fetch(url, {
      method: "POST",
      headers: { ...this.headers, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
    });
    if (!response.ok) throw new Error(`OpenCode ${path} failed with HTTP ${response.status}`);
  }

  private textResponse(parts: Part[]): string {
    return parts
      .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.ignored)
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n\n");
  }

  private sessionUrl(directory: string, sessionId: string): string {
    const encodedDirectory = Buffer.from(directory).toString("base64url");
    return `${this.config.opencodePublicUrl}/${encodedDirectory}/session/${sessionId}`;
  }
}
