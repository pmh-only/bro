import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

function enqueueGlobal(store: JobStore, task: string) {
  return store.enqueue({
    scope: "global",
    project: { alias: "Global", directory: "/tmp/bro-data" },
    task,
    requestedBy: "user-1",
    channelId: "channel-1",
    messageId: `message-${task}`,
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("persistent project jobs", () => {
  it("selects parallel queued jobs and supports cancellation", () => {
    const store = new JobStore(":memory:");
    const first = enqueue(store, "first");
    const second = enqueue(store, "second");

    assert.deepEqual(store.ready().map((job) => job.id), [first.id, second.id]);
    first.state = "running";
    first.startedAt = Date.now();
    first.worktreeDirectory = "/tmp/worktree-first";
    store.save(first);
    assert.deepEqual(store.ready().map((job) => job.id), [second.id]);
    second.state = "integrating";
    store.save(second);
    assert.equal(store.canIntegrate(second), false);

    first.state = "completed";
    first.finishedAt = Date.now();
    store.save(first);
    assert.equal(store.canIntegrate(second), true);
    assert.equal(store.cancel(second.id)?.state, "cancelling");
    second.state = "cancelled";
    second.finishedAt = Date.now();
    store.save(second);
    assert.deepEqual(store.active(), []);
    store.close();
  });

  it("runs one non-worktree global job at a time", () => {
    const store = new JobStore(":memory:");
    const first = enqueueGlobal(store, "install a service");
    const second = enqueueGlobal(store, "configure a shell tool");

    assert.deepEqual(store.ready().map((job) => job.id), [first.id]);
    first.state = "running";
    first.sessionId = "ses_global";
    first.startedAt = Date.now();
    store.save(first);
    assert.equal(store.get(first.id)?.scope, "global");
    assert.equal(store.get(first.id)?.worktreeDirectory, undefined);
    assert.deepEqual(store.ready(), []);

    first.state = "completed";
    first.finishedAt = Date.now();
    store.save(first);
    assert.deepEqual(store.ready().map((job) => job.id), [second.id]);
    store.close();
  });

  it("restores session and Discord message state after reopening", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bro-jobs-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "jobs.sqlite");
    const firstStore = new JobStore(path);
    const job = enqueue(firstStore, "persisted");
    job.attachments = [{ mime: "image/png", url: "https://cdn.discordapp.com/task.png", filename: "task.png" }];
    job.state = "running";
    job.startedAt = 1;
    job.sessionId = "ses_persisted";
    job.sessionUrl = "https://opencode.example/session/ses_persisted";
    job.baseCommit = "0123456789abcdef";
    job.progress = "Implementing persistence";
    job.consumedTokens = 12_345;
    job.promptAttempts = 1;
    job.lastPromptAt = Date.now();
    firstStore.save(job);
    const instruction = firstStore.enqueueInstruction(job.id, "also update the docs", [
      { mime: "text/plain", url: "https://cdn.discordapp.com/docs.txt", filename: "docs.txt" },
    ]);
    const choice = firstStore.createInstructionChoice(job.id, "then update the examples", "user-1", [
      { mime: "image/jpeg", url: "https://cdn.discordapp.com/example.jpg", filename: "example.jpg" },
    ]);
    firstStore.close();

    const secondStore = new JobStore(path);
    secondStore.resume();
    const restored = secondStore.get(job.id);
    assert.equal(restored?.state, "running");
    assert.equal(restored?.sessionId, "ses_persisted");
    assert.equal(restored?.channelId, "channel-1");
    assert.equal(restored?.messageId, "message-persisted");
    assert.equal(restored?.promptAttempts, 1);
    assert.equal(restored?.baseCommit, "0123456789abcdef");
    assert.equal(restored?.progress, "Implementing persistence");
    assert.equal(restored?.consumedTokens, 12_345);
    assert.deepEqual(restored?.attachments, [
      { mime: "image/png", url: "https://cdn.discordapp.com/task.png", filename: "task.png" },
    ]);
    assert.ok((restored?.startedAt ?? 0) > 1, "restart should not count container downtime against the task deadline");
    assert.deepEqual(secondStore.pendingInstructions(job.id).map(({ id, content }) => ({ id, content })), [
      { id: instruction.id, content: "also update the docs" },
    ]);
    assert.deepEqual(secondStore.pendingInstructions(job.id)[0]?.attachments, [
      { mime: "text/plain", url: "https://cdn.discordapp.com/docs.txt", filename: "docs.txt" },
    ]);
    const resolvedChoice = secondStore.resolveInstructionChoice(choice.id, "queue", "user-1")?.instruction;
    assert.equal(resolvedChoice?.content, "then update the examples");
    assert.deepEqual(resolvedChoice?.attachments, [
      { mime: "image/jpeg", url: "https://cdn.discordapp.com/example.jpg", filename: "example.jpg" },
    ]);
    secondStore.markInstructionSent(instruction.id);
    assert.deepEqual(secondStore.pendingInstructions(job.id).map(({ content }) => content), ["then update the examples"]);
    const steerChoice = secondStore.createInstructionChoice(job.id, "urgent after restart", "user-1");
    assert.ok(secondStore.resolveInstructionChoice(steerChoice.id, "steer", "user-1"));
    secondStore.close();

    const thirdStore = new JobStore(path);
    assert.equal(thirdStore.get(job.id)?.interruptAction, "steer");
    assert.deepEqual(thirdStore.pendingInstructions(job.id).map(({ content }) => content), [
      "urgent after restart",
      "then update the examples",
    ]);
    thirdStore.close();
  });

  it("migrates an existing jobs database to store Git baselines", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bro-jobs-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "jobs.sqlite");
    const legacyStore = new JobStore(path);
    const legacyJob = enqueue(legacyStore, "active migration");
    legacyJob.state = "running";
    legacyJob.sessionId = "ses_migration";
    legacyStore.save(legacyJob);
    const earlierInstruction = legacyStore.enqueueInstruction(legacyJob.id, "already superseded");
    legacyStore.markInstructionSent(earlierInstruction.id);
    const legacyInstruction = legacyStore.enqueueInstruction(legacyJob.id, "still running");
    legacyStore.markInstructionSent(legacyInstruction.id);
    legacyStore.close();
    const oldDatabase = new DatabaseSync(path);
    oldDatabase.exec("ALTER TABLE jobs DROP COLUMN base_commit");
    oldDatabase.exec("ALTER TABLE jobs DROP COLUMN scope");
    oldDatabase.exec("ALTER TABLE jobs DROP COLUMN progress");
    oldDatabase.exec("ALTER TABLE jobs DROP COLUMN interrupt_action");
    oldDatabase.exec("ALTER TABLE jobs DROP COLUMN worktree_directory");
    oldDatabase.exec("ALTER TABLE jobs DROP COLUMN worktree_branch");
    oldDatabase.exec("ALTER TABLE jobs DROP COLUMN target_branch");
    oldDatabase.exec("ALTER TABLE jobs DROP COLUMN project_sequence");
    oldDatabase.exec("ALTER TABLE jobs DROP COLUMN integration_base");
    oldDatabase.exec("ALTER TABLE jobs DROP COLUMN integration_head");
    oldDatabase.exec("ALTER TABLE jobs DROP COLUMN consumed_tokens");
    oldDatabase.exec("ALTER TABLE jobs DROP COLUMN attachments");
    oldDatabase.exec("DROP INDEX job_instructions_pending");
    oldDatabase.exec("ALTER TABLE job_instructions DROP COLUMN sequence");
    oldDatabase.exec("ALTER TABLE job_instructions DROP COLUMN completed_at");
    oldDatabase.exec("ALTER TABLE job_instructions DROP COLUMN attachments");
    oldDatabase.exec("ALTER TABLE instruction_choices DROP COLUMN attachments");
    oldDatabase.close();

    const migrated = new JobStore(path);
    assert.equal(migrated.get(legacyJob.id)?.scope, "project");
    assert.equal(migrated.get(legacyJob.id)?.consumedTokens, undefined);
    assert.deepEqual(migrated.get(legacyJob.id)?.attachments, []);
    assert.equal(migrated.activeInstruction(legacyJob.id)?.content, "still running");
    migrated.markInstructionCompleted(legacyInstruction.id);
    assert.equal(migrated.beginIntegrationIfIdle(legacyJob.id, "migration complete")?.state, "integrating");
    const job = enqueue(migrated, "migrated");
    job.baseCommit = "abcdef";
    job.progress = "Migrated progress";
    migrated.save(job);
    assert.equal(migrated.get(job.id)?.baseCommit, "abcdef");
    assert.equal(migrated.get(job.id)?.progress, "Migrated progress");
    migrated.close();
  });

  it("resolves queue, replace, and steer choices with durable ordering", () => {
    const runningStore = (task: string) => {
      const store = new JobStore(":memory:");
      const job = enqueue(store, task);
      job.state = "running";
      job.sessionId = `ses_${task}`;
      job.startedAt = Date.now();
      job.lastPromptAt = Date.now();
      store.save(job);
      return { store, job };
    };

    const queued = runningStore("queue");
    queued.store.enqueueInstruction(queued.job.id, "first queued");
    const queueChoice = queued.store.createInstructionChoice(queued.job.id, "last queued", "user-1");
    assert.equal(queued.store.resolveInstructionChoice(queueChoice.id, "queue", "other-user"), undefined);
    assert.ok(queued.store.resolveInstructionChoice(queueChoice.id, "queue", "user-1"));
    assert.deepEqual(queued.store.pendingInstructions(queued.job.id).map(({ content }) => content), ["first queued", "last queued"]);
    assert.equal(queued.store.get(queued.job.id)?.interruptAction, undefined);
    assert.equal(queued.store.resolveInstructionChoice(queueChoice.id, "queue", "user-1"), undefined);
    assert.equal(queued.store.beginIntegrationIfIdle(queued.job.id, "too early"), undefined);
    for (const instruction of queued.store.pendingInstructions(queued.job.id)) {
      queued.store.markInstructionSent(instruction.id);
      queued.store.markInstructionCompleted(instruction.id);
    }
    assert.equal(queued.store.beginIntegrationIfIdle(queued.job.id, "done")?.state, "integrating");
    queued.store.close();

    const steered = runningStore("steer");
    const active = steered.store.enqueueInstruction(steered.job.id, "active");
    steered.store.markInstructionSent(active.id);
    steered.store.enqueueInstruction(steered.job.id, "queued one");
    steered.store.enqueueInstruction(steered.job.id, "queued two");
    const steerChoice = steered.store.createInstructionChoice(steered.job.id, "urgent", "user-1");
    assert.ok(steered.store.resolveInstructionChoice(steerChoice.id, "steer", "user-1"));
    assert.equal(steered.store.activeInstruction(steered.job.id), undefined);
    assert.equal(steered.store.get(steered.job.id)?.interruptAction, "steer");
    const afterSteerChoice = steered.store.createInstructionChoice(steered.job.id, "queued after steer", "user-1");
    assert.ok(steered.store.resolveInstructionChoice(afterSteerChoice.id, "queue", "user-1"));
    assert.deepEqual(steered.store.pendingInstructions(steered.job.id).map(({ content }) => content), [
      "urgent",
      "queued one",
      "queued two",
      "queued after steer",
    ]);
    steered.store.close();

    const replaced = runningStore("replace");
    const replacedActive = replaced.store.enqueueInstruction(replaced.job.id, "active");
    replaced.store.markInstructionSent(replacedActive.id);
    replaced.store.enqueueInstruction(replaced.job.id, "discard me");
    const replaceChoice = replaced.store.createInstructionChoice(replaced.job.id, "replacement", "user-1");
    assert.ok(replaced.store.resolveInstructionChoice(replaceChoice.id, "replace", "user-1"));
    assert.equal(replaced.store.activeInstruction(replaced.job.id), undefined);
    assert.equal(replaced.store.get(replaced.job.id)?.interruptAction, "replace");
    assert.deepEqual(replaced.store.pendingInstructions(replaced.job.id).map(({ content }) => content), ["replacement"]);
    replaced.store.close();
  });

  it("finds running jobs by project and Discord reply target", () => {
    const store = new JobStore(":memory:");
    const job = enqueue(store, "reply target");
    job.state = "running";
    job.sessionId = "ses_reply";
    store.save(job);

    assert.equal(store.runningForProject(project.directory)?.id, job.id);
    assert.equal(store.runningByMessage(job.channelId, job.messageId)?.id, job.id);
    assert.equal(store.runningByMessage("other-channel", job.messageId), undefined);
    store.close();
  });
});
