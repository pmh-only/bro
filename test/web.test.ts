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
    await new Promise((resolve) => setTimeout(resolve, 2));
    store.enqueue({
      project: { alias: "api", directory: "/tmp/api" },
      task: "add health endpoint",
      requestedBy: "1",
      channelId: "channel",
      messageId: "message-2",
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const latest = store.enqueue({
      project: { alias: "website", directory: "/tmp/website" },
      task: "polish the homepage",
      requestedBy: "1",
      channelId: "channel",
      messageId: "message-3",
    });
    latest.state = "running";
    latest.progress = "Working on the homepage.";
    store.save(latest);
    store.enqueueInstruction(latest.id, "also update <footer>", [{
      mime: "image/png",
      url: "data:image/png;base64,cXVldWVk",
      filename: "reference.png",
    }]);
    store.enqueueInstruction(latest.id, "then update the mobile layout");
    const completedInstruction = store.enqueueInstruction(latest.id, "already applied");
    store.markInstructionSent(completedInstruction.id);
    store.markInstructionCompleted(completedInstruction.id);
    const server = await startThreadServer(store, 0, "127.0.0.1");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Thread server did not bind a port");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const defaultPage = await (await fetch(baseUrl)).text();
    assert.match(defaultPage, /Project threads/);
    assert.match(defaultPage, /<nav aria-label="Projects">/);
    assert.match(defaultPage, /href="\/\?project=website" class="active" aria-current="page"/);
    assert.match(defaultPage, /href="\/\?project=api"/);
    assert.match(defaultPage, /aria-label="Job summary"/);
    assert.match(defaultPage, /polish the homepage/);
    assert.match(defaultPage, /<span class="latest">Latest<\/span>/);
    assert.match(defaultPage, /<div class="queued-content" aria-label="Queued content">/);
    assert.match(defaultPage, /2 pending/);
    assert.match(defaultPage, /also update &lt;footer&gt;/);
    assert.match(defaultPage, /then update the mobile layout/);
    assert.match(defaultPage, /reference\.png/);
    assert.doesNotMatch(defaultPage, /already applied/);
    assert.doesNotMatch(defaultPage, /cXVldWVk/);
    assert.ok(defaultPage.indexOf("polish the homepage") < defaultPage.indexOf("Implemented safely"));
    assert.doesNotMatch(defaultPage, /add health endpoint/);

    const websitePage = await (await fetch(`${baseUrl}/?project=website`)).text();
    assert.match(websitePage, /href="\/\?project=website" class="active" aria-current="page"/);
    assert.match(websitePage, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(websitePage, /<script>alert/);
    assert.doesNotMatch(websitePage, /add health endpoint/);
    assert.match(websitePage, /Implemented safely/);

    const threads = await (await fetch(`${baseUrl}/api/projects`)).json() as Array<{
      project: string;
      jobs: Array<{
        request: string;
        response: string;
        queuedContent: Array<{
          id: number;
          type: string;
          state: string;
          content: string;
          createdAt: number;
          attachments: Array<{ filename?: string; mime: string }>;
        }>;
      }>;
    }>;
    assert.deepEqual(threads.map((thread) => thread.project), ["website", "api"]);
    assert.deepEqual(threads[0]?.jobs.map((job) => job.request), ["polish the homepage", "add <script>alert(1)</script>"]);
    assert.deepEqual(threads[0]?.jobs[0]?.queuedContent, [
      {
        id: 1,
        type: "instruction",
        state: "queued",
        content: "also update <footer>",
        createdAt: threads[0]?.jobs[0]?.queuedContent[0]?.createdAt,
        attachments: [{ filename: "reference.png", mime: "image/png" }],
      },
      {
        id: 2,
        type: "instruction",
        state: "queued",
        content: "then update the mobile layout",
        createdAt: threads[0]?.jobs[0]?.queuedContent[1]?.createdAt,
        attachments: [],
      },
    ]);
    assert.equal(await (await fetch(`${baseUrl}/healthz`)).text(), "ok\n");

    store.setJobHistoryVisible(false);
    const hiddenPage = await (await fetch(baseUrl)).text();
    assert.match(hiddenPage, /Job history is hidden\. Only active jobs are shown\./);
    assert.match(hiddenPage, /polish the homepage/);
    assert.doesNotMatch(hiddenPage, /Implemented safely/);
    assert.doesNotMatch(hiddenPage, /alert\(1\)/);
    const visibleThreads = await (await fetch(`${baseUrl}/api/projects`)).json() as Array<{
      project: string;
      jobs: Array<{ request: string }>;
    }>;
    assert.deepEqual(visibleThreads.map((thread) => thread.project), ["website", "api"]);
    assert.deepEqual(visibleThreads[0]?.jobs.map((job) => job.request), ["polish the homepage"]);

    store.setJobHistoryVisible(true);
    assert.match(await (await fetch(baseUrl)).text(), /Implemented safely/);

    assert.equal(store.setJobHidden(first.id, true)?.hidden, true);
    const specificallyHiddenPage = await (await fetch(`${baseUrl}/?project=website`)).text();
    assert.match(specificallyHiddenPage, /polish the homepage/);
    assert.doesNotMatch(specificallyHiddenPage, /Implemented safely/);
    assert.doesNotMatch(specificallyHiddenPage, /alert\(1\)/);
    const specificallyVisibleThreads = await (await fetch(`${baseUrl}/api/projects`)).json() as Array<{
      project: string;
      jobs: Array<{ id: string }>;
    }>;
    assert.ok(specificallyVisibleThreads.flatMap((thread) => thread.jobs).every((job) => job.id !== first.id));
    assert.equal(store.get(first.id)?.task, "add <script>alert(1)</script>");

    store.setJobHidden(first.id, false);
    assert.match(await (await fetch(`${baseUrl}/?project=website`)).text(), /Implemented safely/);

    await closeThreadServer(server);
    store.close();
  });
});
