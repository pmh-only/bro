import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { JobStore } from "../src/jobs.js";
import { closeThreadServer, startThreadServer } from "../src/web.js";

describe("project thread web server", () => {
  it("renders escaped request and response threads grouped by project", async () => {
    const store = new JobStore(":memory:");
    const first = store.enqueue({
      project: { alias: "website", directory: "/tmp/website" },
      task: "add <script>alert(1)</script>",
      requestedBy: "1",
      channelId: "channel",
      messageId: "message-1",
    });
    first.state = "completed";
    first.result = "Changes: 2 files\n\nImplemented safely.";
    first.finishedAt = Date.now();
    store.save(first);
    store.enqueue({
      project: { alias: "api", directory: "/tmp/api" },
      task: "add health endpoint",
      requestedBy: "1",
      channelId: "channel",
      messageId: "message-2",
    });
    const server = await startThreadServer(store, 0, "127.0.0.1");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Thread server did not bind a port");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const defaultPage = await (await fetch(baseUrl)).text();
    assert.match(defaultPage, /Project threads/);
    assert.match(defaultPage, /<nav aria-label="Projects">/);
    assert.match(defaultPage, /href="\/\?project=api" class="active" aria-current="page"/);
    assert.match(defaultPage, /href="\/\?project=website"/);
    assert.match(defaultPage, /add health endpoint/);
    assert.doesNotMatch(defaultPage, /Implemented safely/);

    const websitePage = await (await fetch(`${baseUrl}/?project=website`)).text();
    assert.match(websitePage, /href="\/\?project=website" class="active" aria-current="page"/);
    assert.match(websitePage, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(websitePage, /<script>alert/);
    assert.doesNotMatch(websitePage, /add health endpoint/);
    assert.match(websitePage, /Implemented safely/);

    const threads = await (await fetch(`${baseUrl}/api/projects`)).json() as Array<{
      project: string;
      jobs: Array<{ request: string; response: string }>;
    }>;
    assert.deepEqual(threads.map((thread) => thread.project), ["api", "website"]);
    assert.equal(threads[1]?.jobs[0]?.request, "add <script>alert(1)</script>");
    assert.equal(await (await fetch(`${baseUrl}/healthz`)).text(), "ok\n");

    await closeThreadServer(server);
    store.close();
  });
});
