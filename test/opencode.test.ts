import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { OpenCodeService } from "../src/opencode.js";

describe("OpenCode task lifecycle", () => {
  const eventResponses = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/session") {
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
    if (request.method === "GET" && request.url?.startsWith("/event")) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.flushHeaders();
      response.write(": waiting\n\n");
      eventResponses.add(response);
      response.once("close", () => eventResponses.delete(response));
      return;
    }
    if (request.method === "POST" && request.url?.includes("/abort")) {
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
      OPENCODE_TASK_TIMEOUT_MS: "50",
    });
    const service = new OpenCodeService(config);
    const started = Date.now();

    await assert.rejects(
      service.runTask({
        directory: process.cwd(),
        title: "timeout test",
        task: "never starts",
        signal: new AbortController().signal,
        onSession: () => undefined,
      }),
      /timed out/,
    );
    assert.ok(Date.now() - started < 1_000, "task timeout should not wait for SSE retries");
  });
});
