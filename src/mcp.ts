import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { InstructionAction, Job } from "./jobs.js";
import type { Project } from "./projects.js";

const jobFieldNames = [
  "id", "scope", "project", "task", "attachments", "requestedBy", "channelId", "messageId", "guildId", "state",
  "createdAt", "startedAt", "finishedAt", "sessionId", "sessionUrl", "result", "error", "baseCommit",
  "worktreeDirectory", "worktreeBranch", "targetBranch", "projectSequence", "integrationBase", "integrationHead",
  "progress", "interruptAction", "promptAttempts", "lastPromptAt", "consumedTokens", "notified", "operationalDetails",
  "operationalDetailsNotified", "hidden",
] as const satisfies readonly (keyof Job)[];
type JobField = typeof jobFieldNames[number];
type JobDetail = "minimal" | "summary" | "full";

const detailSchema = z.enum(["minimal", "summary", "full"])
  .describe("Response size; full is the backward-compatible default. Prefer minimal or summary.");
const jobFieldsSchema = z.array(z.enum(jobFieldNames)).min(1).max(jobFieldNames.length)
  .describe("Exact Job fields to return. Overrides detail and avoids unrelated large fields.");

function jobView(job: Job, detail: JobDetail = "full", fields?: JobField[]): unknown {
  if (fields) {
    const source = job as unknown as Record<JobField, unknown>;
    return Object.fromEntries(fields.map((field) => [field, source[field]]));
  }
  if (detail === "minimal") return { id: job.id, state: job.state };
  if (detail === "summary") {
    return {
      id: job.id,
      state: job.state,
      scope: job.scope,
      project: job.project.alias,
      createdAt: job.createdAt,
      ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      ...(job.progress === undefined ? {} : { progress: job.progress }),
      ...(job.consumedTokens === undefined ? {} : { consumedTokens: job.consumedTokens }),
    };
  }
  return job;
}

function page<T>(items: T[], offset: number, limit: number) {
  const selected = items.slice(offset, offset + limit);
  const nextOffset = offset + selected.length;
  return {
    items: selected,
    total: items.length,
    offset,
    limit,
    ...(nextOffset < items.length ? { nextOffset } : {}),
  };
}

export interface McpActions {
  run(project: string, task: string): Promise<Job> | Job;
  global(task: string): Promise<Job> | Job;
  instruction(jobId: string, instruction: string, action: InstructionAction): Promise<Job> | Job;
  clone(project: string, repository: string, task?: string): Promise<{ project: Project; job?: Job }>;
  projects(): Promise<Project[]> | Project[];
  status(jobId?: string): Promise<Job | Job[] | undefined> | Job | Job[] | undefined;
  cancel(jobId: string): Promise<Job | undefined> | Job | undefined;
  history(visible: boolean, jobId?: string): Promise<{ visible: boolean; job?: Job }> | { visible: boolean; job?: Job };
}

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function createMcpServer(actions: McpActions): McpServer {
  const server = new McpServer({ name: "bro", version: "1.0.0" });

  server.registerTool("run", {
    description: "Queue an OpenCode task in an existing registered project.",
    inputSchema: {
      project: z.string().min(1).describe("Registered project alias"),
      task: z.string().min(1).describe("Task for OpenCode to complete"),
      detail: detailSchema.optional(),
    },
  }, async ({ project, task, detail }) => result(jobView(await actions.run(project, task), detail)));

  server.registerTool("global", {
    description: "Queue environment-wide work that is not associated with a registered project.",
    inputSchema: {
      task: z.string().min(1).describe("Environment or shell task to complete"),
      detail: detailSchema.optional(),
    },
  }, async ({ task, detail }) => result(jobView(await actions.global(task), detail)));

  server.registerTool("instruction", {
    description: "Queue, replace, or steer the instruction for a running job.",
    inputSchema: {
      jobId: z.string().min(1),
      instruction: z.string().min(1),
      action: z.enum(["queue", "replace", "steer"]),
      detail: detailSchema.optional(),
    },
  }, async ({ jobId, instruction, action, detail }) => {
    return result(jobView(await actions.instruction(jobId, instruction, action), detail));
  });

  server.registerTool("clone", {
    description: "Clone and register a Git repository, optionally queueing a task after registration.",
    inputSchema: {
      project: z.string().min(1).describe("Alias to register"),
      repository: z.string().min(1).describe("HTTPS or SSH Git repository URL"),
      task: z.string().min(1).optional(),
      detail: detailSchema.optional(),
    },
  }, async ({ project, repository, task, detail }) => {
    const cloned = await actions.clone(project, repository, task);
    if (detail === undefined || detail === "full") return result(cloned);
    return result({
      project: detail === "minimal" ? { alias: cloned.project.alias } : cloned.project,
      ...(cloned.job ? { job: jobView(cloned.job, detail) } : {}),
    });
  });

  server.registerTool("projects", {
    description: "List registered projects. Use fields or pagination to avoid an unbounded full response.",
    inputSchema: {
      fields: z.array(z.enum(["alias", "directory"])).min(1).max(2).optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, async ({ fields, offset, limit }) => {
    const projects = await actions.projects();
    if (!fields && offset === undefined && limit === undefined) return result(projects);
    const selectedFields = fields ?? ["alias", "directory"];
    const projected = projects.map((project) => Object.fromEntries(selectedFields.map((field) => [field, project[field]])));
    return result(page(projected, offset ?? 0, limit ?? 20));
  });

  server.registerTool("status", {
    description: "Get one job or list active jobs. Prefer summary/minimal detail or fields; list controls return a paginated envelope.",
    inputSchema: {
      jobId: z.string().min(1).optional(),
      detail: detailSchema.optional(),
      fields: jobFieldsSchema.optional(),
      offset: z.number().int().min(0).optional().describe("Active-job offset; only valid without jobId"),
      limit: z.number().int().min(1).max(100).optional().describe("Active-job page size; only valid without jobId"),
    },
  }, async ({ jobId, detail, fields, offset, limit }) => {
    if (jobId && (offset !== undefined || limit !== undefined)) throw new Error("Pagination is only valid when listing active jobs");
    const status = await actions.status(jobId);
    if (!status) throw new Error(`Job ${jobId} was not found`);
    if (!Array.isArray(status)) return result(jobView(status, detail, fields));
    if (detail === undefined && fields === undefined && offset === undefined && limit === undefined) return result(status);
    return result(page(status.map((job) => jobView(job, detail ?? "summary", fields)), offset ?? 0, limit ?? 20));
  });

  server.registerTool("job_output", {
    description: "Read one potentially large job text field in bounded chunks without fetching the full job.",
    inputSchema: {
      jobId: z.string().min(1),
      field: z.enum(["task", "progress", "result", "error", "operationalDetails"]),
      offset: z.number().int().min(0).optional().describe("Character offset; defaults to 0"),
      maxChars: z.number().int().min(1).max(20_000).optional().describe("Maximum characters; defaults to 4000"),
    },
  }, async ({ jobId, field, offset = 0, maxChars = 4_000 }) => {
    const status = await actions.status(jobId);
    if (!status || Array.isArray(status)) throw new Error(`Job ${jobId} was not found`);
    const value = status[field];
    const text = typeof value === "string" ? value : "";
    const content = text.slice(offset, offset + maxChars);
    const nextOffset = offset + content.length;
    return result({
      jobId,
      field,
      content,
      totalChars: text.length,
      offset,
      ...(nextOffset < text.length ? { nextOffset } : {}),
    });
  });

  server.registerTool("cancel", {
    description: "Cancel an active job.",
    inputSchema: { jobId: z.string().min(1), detail: detailSchema.optional() },
  }, async ({ jobId, detail }) => {
    const job = await actions.cancel(jobId);
    if (!job) throw new Error(`Active job ${jobId} was not found or cannot be cancelled`);
    return result(jobView(job, detail));
  });

  server.registerTool("history", {
    description: "Show or hide terminal job history globally or for one job in the Web UI.",
    inputSchema: {
      visible: z.boolean(),
      jobId: z.string().min(1).optional(),
      detail: detailSchema.optional(),
    },
  }, async ({ visible, jobId, detail }) => {
    const changed = await actions.history(visible, jobId);
    return result({ visible: changed.visible, ...(changed.job ? { job: jobView(changed.job, detail) } : {}) });
  });

  server.registerTool("help", {
    description: "Describe the actions supported by this MCP server.",
  }, async () => result({
    actions: ["run", "global", "instruction", "clone", "projects", "status", "job_output", "cancel", "history", "help"],
    instructionActions: ["queue", "replace", "steer"],
    responseGuidance: "Use detail=minimal for IDs/state, detail=summary for monitoring, fields for exact status data, and job_output for bounded text reads.",
  }));

  return server;
}

export async function startMcpServer(
  actions: McpActions,
  port: number,
  hostname = "0.0.0.0",
): Promise<Server> {
  const httpServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/healthz") {
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end("ok\n");
      return;
    }
    if (url.pathname !== "/mcp") {
      response.statusCode = 404;
      response.end("not found\n");
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      }));
      return;
    }

    const server = createMcpServer(actions);
    const transport = new StreamableHTTPServerTransport();
    response.once("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      // The SDK's transport declarations do not currently account for exactOptionalPropertyTypes.
      await server.connect(transport as unknown as Parameters<McpServer["connect"]>[0]);
      await transport.handleRequest(request, response);
    } catch (error) {
      console.error("Unable to handle MCP request", error);
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        }));
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, hostname, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  return httpServer;
}

export async function closeMcpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
