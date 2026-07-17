import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { JobStore } from "../src/jobs.js";

const temporaryDirectories: string[] = [];
const project = { alias: "example", directory: "/tmp/example" };

function enqueue(store: JobStore, task: string) {
  return store.enqueue({
    project,
    task,
    requestedBy: "user-1",
    channelId: "channel-1",
    messageId: `message-${task}`,
    guildId: "guild-1",
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("persistent project jobs", () => {
  it("selects only one queued job per project and supports cancellation", () => {
    const store = new JobStore(":memory:");
    const first = enqueue(store, "first");
    const second = enqueue(store, "second");

    assert.deepEqual(store.ready().map((job) => job.id), [first.id]);
    first.state = "running";
    first.startedAt = Date.now();
    store.save(first);
    assert.deepEqual(store.ready(), []);

    first.state = "completed";
    first.finishedAt = Date.now();
    store.save(first);
    assert.deepEqual(store.ready().map((job) => job.id), [second.id]);
    assert.equal(store.cancel(second.id)?.state, "cancelled");
    assert.deepEqual(store.active(), []);
    store.close();
  });

  it("restores session and Discord message state after reopening", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bro-jobs-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "jobs.sqlite");
    const firstStore = new JobStore(path);
    const job = enqueue(firstStore, "persisted");
    job.state = "running";
    job.startedAt = 1;
    job.sessionId = "ses_persisted";
    job.sessionUrl = "https://opencode.example/session/ses_persisted";
    job.promptAttempts = 1;
    job.lastPromptAt = Date.now();
    firstStore.save(job);
    const instruction = firstStore.enqueueInstruction(job.id, "also update the docs");
    firstStore.close();

    const secondStore = new JobStore(path);
    secondStore.resume();
    const restored = secondStore.get(job.id);
    assert.equal(restored?.state, "running");
    assert.equal(restored?.sessionId, "ses_persisted");
    assert.equal(restored?.channelId, "channel-1");
    assert.equal(restored?.messageId, "message-persisted");
    assert.equal(restored?.promptAttempts, 1);
    assert.ok((restored?.startedAt ?? 0) > 1, "restart should not count container downtime against the task deadline");
    assert.deepEqual(secondStore.pendingInstructions(job.id).map(({ id, content }) => ({ id, content })), [
      { id: instruction.id, content: "also update the docs" },
    ]);
    secondStore.markInstructionSent(instruction.id);
    assert.deepEqual(secondStore.pendingInstructions(job.id), []);
    secondStore.close();
  });
});
