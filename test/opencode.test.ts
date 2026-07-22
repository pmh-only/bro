import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import type { Session } from "@opencode-ai/sdk";
import { loadConfig } from "../src/config.js";
import { opencodeDispatcherOptions, OpenCodeService } from "../src/opencode.js";

describe("OpenCode task lifecycle", () => {
  let sessions: Session[] = [];
  let createRequests = 0;
  let asyncPromptBodies: string[] = [];
  let sessionStatuses: Record<string, { type: "idle" | "busy" }> = {};
  let sessionMessages: unknown[] = [];
  let sessionTodos: unknown[] = [];
  let todoRequests = 0;
  let permissions: unknown[] = [];
  let questions: unknown[] = [];
  let resolvedRequests: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method === "GET" && path === "/global/health") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ healthy: true, version: "test" }));
      return;
    }
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
    if (request.method === "GET" && path === "/session/status") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(sessionStatuses));
      return;
    }
    if (request.method === "GET" && path === "/permission") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(permissions));
      return;
    }
    if (request.method === "GET" && path === "/question") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(questions));
      return;
    }
    if (request.method === "POST" && (path.includes("/permission/") || path.includes("/question/"))) {
      resolvedRequests.push(path);
      response.setHeader("Content-Type", "application/json");
      response.end("true");
      return;
    }
    if (request.method === "POST" && path.endsWith("/prompt_async")) {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (body += chunk));
      request.on("end", () => {
        asyncPromptBodies.push(body);
        response.statusCode = 204;
        response.end();
      });
      return;
    }
    if (request.method === "GET" && path.endsWith("/message")) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(sessionMessages));
      return;
    }
    if (request.method === "GET" && path.endsWith("/todo")) {
      todoRequests += 1;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(sessionTodos));
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

  it("disables Node fetch timeouts for long-running OpenCode responses", () => {
    assert.deepEqual(opencodeDispatcherOptions, { headersTimeout: 0, bodyTimeout: 0 });
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    sessions = [];
    createRequests = 0;
    asyncPromptBodies = [];
    sessionStatuses = {};
    sessionMessages = [];
    sessionTodos = [];
    todoRequests = 0;
    permissions = [];
    questions = [];
    resolvedRequests = [];
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("checks OpenCode health at startup", async () => {
    const config = loadConfig({
      DISCORD_TOKEN: "test",
      DISCORD_ALLOWED_USER_IDS: "1",
      OPENCODE_URL: baseUrl,
    });
    const service = new OpenCodeService(config);

    assert.equal(await service.assertHealthy(), "test");
    await service.close();
  });

  it("submits async work and requires an explicit success marker", async () => {
    const now = Date.now();
    const storedSession = (id: string, title: string, updated: number, parentID?: string): Session => ({
      id,
      projectID: "project",
      directory: process.cwd(),
      ...(parentID ? { parentID } : {}),
      title,
      version: "1",
      time: { created: updated, updated },
    });
    sessions = [
      storedSession("ses_manual", "Manual work", now + 3),
      storedSession("ses_async", "Discord: existing", now + 1),
      storedSession("ses_old", "Discord: old", now),
      storedSession("ses_child", "Discord: child", now + 2, "ses_async"),
    ];
    const service = new OpenCodeService(loadConfig({
      DISCORD_TOKEN: "test",
      DISCORD_ALLOWED_USER_IDS: "1",
      OPENCODE_URL: baseUrl,
    }));
    const session = await service.ensureTaskSession(process.cwd(), "Discord: async", AbortSignal.timeout(1_000));
    assert.equal(session.sessionId, "ses_async");
    assert.equal(createRequests, 0);
    const globalSession = await service.ensureTaskSession(process.cwd(), "Discord: global", AbortSignal.timeout(1_000), false);
    assert.equal(globalSession.sessionId, "ses_test");
    assert.equal(createRequests, 1);
    await service.submitTask(process.cwd(), session.sessionId, "finish it", false, AbortSignal.timeout(1_000));
    assert.match(asyncPromptBodies[0] ?? "", /BRO_JOB_SUCCESS/);
    assert.match(asyncPromptBodies[0] ?? "", /install any required OS packages, databases, CLIs, runtimes, libraries, and services/);
    assert.match(asyncPromptBodies[0] ?? "", /modify files outside the current project/);
    assert.match(asyncPromptBodies[0] ?? "", /Do not access, modify, or delete files in any other project or source repository/);
    assert.match(asyncPromptBodies[0] ?? "", /Always process the request in English/);
    assert.match(asyncPromptBodies[0] ?? "", /final response as a concise English summary/);
    assert.match(asyncPromptBodies[0] ?? "", /Use OpenCode goal mode.*call create_goal/s);
    assert.match(asyncPromptBodies[0] ?? "", /call update_goal with status complete.*evidence/s);
    assert.match(asyncPromptBodies[0] ?? "", /coordinator will integrate and push/i);
    assert.match(asyncPromptBodies[0] ?? "", /Do not pull, push, force-push/);
    assert.doesNotMatch(asyncPromptBodies[0] ?? "", /do not access external directories/i);
    await service.submitInstruction(process.cwd(), session.sessionId, "use the new API", AbortSignal.timeout(1_000), "msg_instruction_1");
    assert.match(asyncPromptBodies[1] ?? "", /Additional instruction.*use the new API.*BRO_JOB_SUCCESS/s);
    assert.doesNotMatch(asyncPromptBodies[1] ?? "", /original task/);
    assert.match(asyncPromptBodies[1] ?? "", /progress updates, prompts, and summaries in English/);
    assert.match(asyncPromptBodies[1] ?? "", /Call update_goal_objective.*this instruction.*unfinished original work/);
    assert.equal((JSON.parse(asyncPromptBodies[1]!) as { messageID?: string }).messageID, "msg_instruction_1");

    sessionStatuses = { ses_async: { type: "busy" } };
    sessionTodos = [
      { id: "todo_1", content: "Inspect existing behavior", status: "completed", priority: "high" },
      { id: "todo_2", content: "Implement the fix", status: "in_progress", priority: "high" },
      { id: "todo_3", content: "Update the running embed", status: "in_progress", priority: "high" },
      { id: "todo_4", content: "Run verification", status: "pending", priority: "high" },
      { id: "todo_5", content: "Commit the changes", status: "pending", priority: "high" },
    ];
    sessionMessages = [{
      info: {
        id: "msg_old", sessionID: "ses_async", role: "assistant", parentID: "user_old", time: { created: now - 1 },
        tokens: { input: 50_000, output: 10_000, reasoning: 5_000, cache: { read: 20_000, write: 2_000 } },
      },
      parts: [{ type: "text", text: "previous job" }],
    }];
    const starting = await service.taskSnapshot(process.cwd(), "ses_async", now, AbortSignal.timeout(1_000), now);
    assert.equal(starting.progress, undefined);
    assert.equal(starting.consumedTokens, 0);
    assert.equal(todoRequests, 0);

    sessionMessages = [{
      info: {
        id: "msg_progress", sessionID: "ses_async", role: "assistant", parentID: "user_1", time: { created: now + 1 },
        tokens: { input: 400, output: 100, reasoning: 50, cache: { read: 200, write: 25 } },
      },
      parts: [{
        type: "step-finish",
        tokens: { input: 600, output: 100, reasoning: 50, cache: { read: 300, write: 25 } },
      }, {
        type: "step-finish",
        tokens: { input: 400, output: 100, reasoning: 50, cache: { read: 200, write: 25 } },
      }],
    }];
    const beforeTodoUpdate = await service.taskSnapshot(process.cwd(), "ses_async", now, AbortSignal.timeout(1_000), now);
    assert.equal(beforeTodoUpdate.progress, undefined);
    assert.equal(beforeTodoUpdate.consumedTokens, 1_850);
    assert.equal(todoRequests, 0);

    sessionMessages = [{
      info: {
        id: "msg_progress", sessionID: "ses_async", role: "assistant", parentID: "user_1", time: { created: now + 1 },
        tokens: { input: 1_000, output: 200, reasoning: 100, cache: { read: 500, write: 50 } },
      },
      parts: [{ type: "tool", tool: "todowrite", state: { status: "completed" } }],
    }];
    const busy = await service.taskSnapshot(process.cwd(), "ses_async", now, AbortSignal.timeout(1_000), now);
    assert.equal(busy.progress, [
      "In progress (2):",
      "- Implement the fix",
      "- Update the running embed",
      "Queued items (2):",
      "- Run verification",
      "- Commit the changes",
      "Plan: 1/5 steps completed",
    ].join("\n"));
    assert.equal(todoRequests, 1);

    sessionStatuses = { ses_async: { type: "idle" } };
    sessionTodos = [];
    sessionMessages = [{
      info: { id: "msg_1", sessionID: "ses_async", role: "assistant", parentID: "user_1", time: { created: now + 1 } },
      parts: [{ type: "text", text: "not finished" }],
    }];
    assert.equal((await service.taskSnapshot(process.cwd(), "ses_async", now, AbortSignal.timeout(1_000), now)).successful, false);

    await service.submitTask(process.cwd(), "ses_async", "finish it", true, AbortSignal.timeout(1_000));
    assert.match(asyncPromptBodies[2] ?? "", /still incomplete/);
    assert.match(asyncPromptBodies[2] ?? "", /install any required OS packages/);
    assert.match(asyncPromptBodies[2] ?? "", /any other project or source repository/);
    assert.match(asyncPromptBodies[2] ?? "", /Always process the request in English/);
    assert.match(asyncPromptBodies[2] ?? "", /Continue using the existing OpenCode goal/);
    assert.match(asyncPromptBodies[2] ?? "", /close the goal as complete.*evidence/s);
    await service.submitTask(process.cwd(), "ses_async", "install a system service", false, AbortSignal.timeout(1_000), "global");
    assert.match(asyncPromptBodies[3] ?? "", /one job without a Git worktree/);
    assert.match(asyncPromptBodies[3] ?? "", /environment-wide work and shell actions/);
    assert.match(asyncPromptBodies[3] ?? "", /Do not access, modify, or delete any registered project/);
    assert.doesNotMatch(asyncPromptBodies[3] ?? "", /commit all intended changes/);
    await service.submitInstruction(process.cwd(), "ses_async", "adjust the service", AbortSignal.timeout(1_000), undefined, "global");
    assert.match(asyncPromptBodies[4] ?? "", /adjust the service.*Do not access, modify, or delete any registered project/s);
    sessionMessages = [{
      info: {
        id: "msg_1", sessionID: "ses_async", role: "assistant", parentID: "user_1", time: { created: now + 1 },
        tokens: { input: 1_000, output: 200, reasoning: 100, cache: { read: 500, write: 50 } },
      },
      parts: [{ type: "text", text: "earlier response" }],
    }, {
      info: {
        id: "msg_2", sessionID: "ses_async", role: "assistant", parentID: "user_2", time: { created: now + 2 },
        tokens: { input: 2_000, output: 400, reasoning: 250, cache: { read: 750, write: 100 } },
      },
      parts: [{ type: "text", text: "all done\nBRO_JOB_SUCCESS" }],
    }];
    const snapshot = await service.taskSnapshot(process.cwd(), "ses_async", now, AbortSignal.timeout(1_000), now);
    assert.equal(snapshot.successful, true);
    assert.equal(snapshot.response, "all done");
    assert.equal(snapshot.consumedTokens, 5_350);
    assert.equal(await service.taskTokenCount(process.cwd(), "ses_async", now, AbortSignal.timeout(1_000)), 5_350);

    permissions = [{ id: "per_1", sessionID: "ses_async" }, { id: "per_other", sessionID: "other" }];
    questions = [{ id: "que_1", sessionID: "ses_async" }];
    await service.resolvePendingRequests(process.cwd(), "ses_async", AbortSignal.timeout(1_000));
    assert.deepEqual(resolvedRequests, ["/permission/per_1/reply", "/question/que_1/reject"]);
    await service.submitConflictResolution(process.cwd(), "ses_async", ["src/api.ts"], AbortSignal.timeout(1_000));
    assert.match(asyncPromptBodies[5] ?? "", /rebase.*conflicts.*src\/api\.ts.*rebase --continue.*Do not merge/s);
    await service.close();
  });
});
