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
    attachments: [{ mime: "text/plain", url: `data:text/plain;base64,${"eA==".repeat(1_000)}`, filename: "large.txt" }],
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
    result: "abcdefghij",
  };
}

function jsonResult(response: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = (response as { content: Array<{ type: string; text?: string }> }).content[0];
  assert(content && content.type === "text");
  if (typeof content.text !== "string") throw new Error("Tool did not return text content");
  return JSON.parse(content.text);
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
        return jobId ? job(jobId) : [job("active-1"), job("active-2")];
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
      "cancel", "clone", "global", "help", "history", "instruction", "job_output", "projects", "run", "status",
    ]);
    const legacyRun = await client.callTool({ name: "run", arguments: { project: "demo", task: "build it" } });
    const minimalRun = await client.callTool({ name: "run", arguments: { project: "demo", task: "build less", detail: "minimal" } });
    await client.callTool({ name: "global", arguments: { task: "install postgres" } });
    await client.callTool({ name: "instruction", arguments: { jobId: "job-1", instruction: "adjust it", action: "steer" } });
    await client.callTool({ name: "clone", arguments: { project: "new", repository: "https://example.com/new.git", task: "inspect" } });
    await client.callTool({ name: "projects", arguments: {} });
    await client.callTool({ name: "status", arguments: { jobId: "job-1" } });
    await client.callTool({ name: "cancel", arguments: { jobId: "job-1" } });
    await client.callTool({ name: "history", arguments: { visible: false, jobId: "job-1" } });
    const projectedProjects = await client.callTool({
      name: "projects",
      arguments: { fields: ["alias"], offset: 0, limit: 1 },
    });
    const activePage = await client.callTool({
      name: "status",
      arguments: { fields: ["id", "state"], offset: 0, limit: 1 },
    });
    const output = await client.callTool({
      name: "job_output",
      arguments: { jobId: "job-1", field: "result", offset: 2, maxChars: 4 },
    });
    const help = await client.callTool({ name: "help", arguments: {} });

    assert.deepEqual(calls, [
      "run:demo:build it",
      "run:demo:build less",
      "global:install postgres",
      "instruction:job-1:adjust it:steer",
      "clone:new:https://example.com/new.git:inspect",
      "projects",
      "status:job-1",
      "cancel:job-1",
      "history:false:job-1",
      "projects",
      "status:undefined",
      "status:job-1",
    ]);
    assert.equal((jsonResult(legacyRun) as Job).attachments[0]?.filename, "large.txt");
    assert.deepEqual(jsonResult(minimalRun), { id: "run-job", state: "queued" });
    assert.deepEqual(jsonResult(projectedProjects), {
      items: [{ alias: "demo" }], total: 1, offset: 0, limit: 1,
    });
    assert.deepEqual(jsonResult(activePage), {
      items: [{ id: "active-1", state: "queued" }], total: 2, offset: 0, limit: 1, nextOffset: 1,
    });
    assert.deepEqual(jsonResult(output), {
      jobId: "job-1", field: "result", content: "cdef", totalChars: 10, offset: 2, nextOffset: 6,
    });
    assert.match(JSON.stringify(help.content), /queue/);
    assert.equal(await (await fetch(`${baseUrl}/healthz`)).text(), "ok\n");

    await client.close();
    await closeMcpServer(server);
  });
});
