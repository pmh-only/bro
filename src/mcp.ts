import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { InstructionAction, Job } from "./jobs.js";
import type { Project } from "./projects.js";

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
    },
  }, async ({ project, task }) => result(await actions.run(project, task)));

  server.registerTool("global", {
    description: "Queue environment-wide work that is not associated with a registered project.",
    inputSchema: { task: z.string().min(1).describe("Environment or shell task to complete") },
  }, async ({ task }) => result(await actions.global(task)));

  server.registerTool("instruction", {
    description: "Queue, replace, or steer the instruction for a running job.",
    inputSchema: {
      jobId: z.string().min(1),
      instruction: z.string().min(1),
      action: z.enum(["queue", "replace", "steer"]),
    },
  }, async ({ jobId, instruction, action }) => result(await actions.instruction(jobId, instruction, action)));

  server.registerTool("clone", {
    description: "Clone and register a Git repository, optionally queueing a task after registration.",
    inputSchema: {
      project: z.string().min(1).describe("Alias to register"),
      repository: z.string().min(1).describe("HTTPS or SSH Git repository URL"),
      task: z.string().min(1).optional(),
    },
  }, async ({ project, repository, task }) => result(await actions.clone(project, repository, task)));

  server.registerTool("projects", {
    description: "List all registered projects.",
  }, async () => result(await actions.projects()));

  server.registerTool("status", {
    description: "Get one job by ID, or list all active jobs when no ID is supplied.",
    inputSchema: { jobId: z.string().min(1).optional() },
  }, async ({ jobId }) => {
    const status = await actions.status(jobId);
    if (!status) throw new Error(`Job ${jobId} was not found`);
    return result(status);
  });

  server.registerTool("cancel", {
    description: "Cancel an active job.",
    inputSchema: { jobId: z.string().min(1) },
  }, async ({ jobId }) => {
    const job = await actions.cancel(jobId);
    if (!job) throw new Error(`Active job ${jobId} was not found or cannot be cancelled`);
    return result(job);
  });

  server.registerTool("history", {
    description: "Show or hide terminal job history globally or for one job in the Web UI.",
    inputSchema: {
      visible: z.boolean(),
      jobId: z.string().min(1).optional(),
    },
  }, async ({ visible, jobId }) => result(await actions.history(visible, jobId)));

  server.registerTool("help", {
    description: "Describe the actions supported by this MCP server.",
  }, async () => result({
    actions: ["run", "global", "instruction", "clone", "projects", "status", "cancel", "history", "help"],
    instructionActions: ["queue", "replace", "steer"],
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
