import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, it } from "vitest";
import type { Job } from "../src/jobs.js";
import { closeMcpServer, startMcpServer, type McpActions } from "../src/mcp.js";

function job(id: string): Job {
  return {
    id,
    scope: "project",
    project: { alias: "demo", directory: "/tmp/demo" },
    task: "test task",
    attachments: [],
    requestedBy: "mcp",
    channelId: "",
    messageId: "",
    state: "queued",
    createdAt: 1,
    projectSequence: 1,
    promptAttempts: 0,
    notified: false,
    operationalDetailsNotified: false,
    hidden: false,
  };
}

describe("MCP server", () => {
  it("exposes and invokes every supported action over Streamable HTTP", async () => {
    const calls: string[] = [];
    const actions: McpActions = {
      run(project, task) {
        calls.push(`run:${project}:${task}`);
        return job("run-job");
      },
      global(task) {
        calls.push(`global:${task}`);
        return { ...job("global-job"), scope: "global" };
      },
      instruction(jobId, instruction, action) {
        calls.push(`instruction:${jobId}:${instruction}:${action}`);
        return { ...job(jobId), state: "running" };
      },
      async clone(project, repository, task) {
        calls.push(`clone:${project}:${repository}:${task}`);
        return { project: { alias: project, directory: "/tmp/cloned" }, job: job("clone-job") };
      },
      projects() {
        calls.push("projects");
        return [{ alias: "demo", directory: "/tmp/demo" }];
      },
      status(jobId) {
        calls.push(`status:${jobId}`);
        return job(jobId ?? "active-job");
      },
      cancel(jobId) {
        calls.push(`cancel:${jobId}`);
        return { ...job(jobId), state: "cancelled" };
      },
      history(visible, jobId) {
        calls.push(`history:${visible}:${jobId}`);
        return { visible, job: job(jobId ?? "history-job") };
      },
    };
    const server = await startMcpServer(actions, 0, "127.0.0.1");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("MCP server did not bind a port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);

    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "cancel", "clone", "global", "help", "history", "instruction", "projects", "run", "status",
    ]);
    await client.callTool({ name: "run", arguments: { project: "demo", task: "build it" } });
    await client.callTool({ name: "global", arguments: { task: "install postgres" } });
    await client.callTool({ name: "instruction", arguments: { jobId: "job-1", instruction: "adjust it", action: "steer" } });
    await client.callTool({ name: "clone", arguments: { project: "new", repository: "https://example.com/new.git", task: "inspect" } });
    await client.callTool({ name: "projects", arguments: {} });
    await client.callTool({ name: "status", arguments: { jobId: "job-1" } });
    await client.callTool({ name: "cancel", arguments: { jobId: "job-1" } });
    await client.callTool({ name: "history", arguments: { visible: false, jobId: "job-1" } });
    const help = await client.callTool({ name: "help", arguments: {} });

    assert.equal(calls.length, 8);
    assert.deepEqual(calls, [
      "run:demo:build it",
      "global:install postgres",
      "instruction:job-1:adjust it:steer",
      "clone:new:https://example.com/new.git:inspect",
      "projects",
      "status:job-1",
      "cancel:job-1",
      "history:false:job-1",
    ]);
    assert.match(JSON.stringify(help.content), /queue/);
    assert.equal(await (await fetch(`${baseUrl}/healthz`)).text(), "ok\n");

    await client.close();
    await closeMcpServer(server);
  });
});
