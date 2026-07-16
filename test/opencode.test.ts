import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Session } from "@opencode-ai/sdk";
import { loadConfig } from "../src/config.js";
import { OpenCodeService } from "../src/opencode.js";

describe("OpenCode task lifecycle", () => {
  const eventResponses = new Set<ServerResponse>();
  let sessions: Session[] = [];
  let createRequests = 0;
  let connectEvents = false;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method === "GET" && path === "/session") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(sessions));
      return;
    }
    if (request.method === "POST" && path === "/session") {
      createRequests += 1;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          id: "ses_test",
          projectID: "project",
          directory: process.cwd(),
          title: "test",
          version: "1",
          time: { created: Date.now(), updated: Date.now() },
        }),
      );
      return;
    }
    if (request.method === "GET" && path === "/event") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.flushHeaders();
      response.write(connectEvents ? 'data: {"type":"server.connected","properties":{}}\n\n' : ": waiting\n\n");
      eventResponses.add(response);
      response.once("close", () => eventResponses.delete(response));
      return;
    }
    if (request.method === "POST" && path.endsWith("/message")) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ info: {}, parts: [{ type: "text", text: "continued" }] }));
      return;
    }
    if (request.method === "GET" && path.endsWith("/diff")) {
      response.setHeader("Content-Type", "application/json");
      response.end("[]");
      return;
    }
    if (request.method === "POST" && path.endsWith("/abort")) {
      response.setHeader("Content-Type", "application/json");
      response.end("true");
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  let baseUrl = "";

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    sessions = [];
    createRequests = 0;
    connectEvents = false;
  });

  after(async () => {
    for (const response of eventResponses) response.end();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("does not hang when timing out before the event stream connects", async () => {
    const config = loadConfig({
      DISCORD_TOKEN: "test",
      DISCORD_ALLOWED_USER_IDS: "1",
      OPENCODE_URL: baseUrl,
      OPENCODE_TASK_TIMEOUT_MS: "200",
    });
    const service = new OpenCodeService(config);
    const started = Date.now();
    let sessionUrl = "";

    await assert.rejects(
      service.runTask({
        directory: process.cwd(),
        title: "timeout test",
        task: "never starts",
        signal: new AbortController().signal,
        onSession: (_sessionId, webUrl) => {
          sessionUrl = webUrl;
        },
      }),
      /timed out/,
    );
    assert.ok(Date.now() - started < 1_000, "task timeout should not wait for SSE retries");
    assert.equal(
      sessionUrl,
      `${baseUrl}/${Buffer.from(process.cwd()).toString("base64url")}/session/ses_test`,
    );
    assert.equal(createRequests, 1);
  });

  it("continues the latest project Discord session instead of creating one", async () => {
    const now = Date.now();
    const session = (id: string, title: string, updated: number, parentID?: string): Session => ({
      id,
      projectID: "project",
      directory: process.cwd(),
      ...(parentID ? { parentID } : {}),
      title,
      version: "1",
      time: { created: updated, updated },
    });
    sessions = [
      session("ses_manual", "Manual work", now + 3),
      session("ses_existing", "Discord: previous task", now + 1),
      session("ses_old", "Discord: old task", now),
      session("ses_child", "Discord: child", now + 2, "ses_existing"),
    ];
    connectEvents = true;
    const config = loadConfig({
      DISCORD_TOKEN: "test",
      DISCORD_ALLOWED_USER_IDS: "1",
      OPENCODE_URL: baseUrl,
    });
    const service = new OpenCodeService(config);
    let selectedSession = "";

    const result = await service.runTask({
      directory: process.cwd(),
      title: "Discord: current task",
      task: "continue the work",
      signal: new AbortController().signal,
      onSession: (sessionId) => {
        selectedSession = sessionId;
      },
    });

    assert.equal(createRequests, 0);
    assert.equal(selectedSession, "ses_existing");
    assert.equal(result.sessionId, "ses_existing");
    assert.equal(result.response, "continued");
  });
});
