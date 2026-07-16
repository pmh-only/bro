import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JobQueue, type JobState } from "../src/jobs.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for job state");
}

describe("project job queue", () => {
  it("serializes jobs for one project and publishes queued cancellation", async () => {
    const queue = new JobQueue();
    const firstGate = Promise.withResolvers<void>();
    const firstProject = { alias: "example", directory: "/tmp/example" };
    const states: JobState[] = [];
    let secondExecuted = false;

    const first = queue.enqueue({
      project: firstProject,
      task: "first",
      requestedBy: "1",
      execute: async () => {
        await firstGate.promise;
        return "first complete";
      },
      onChange: async () => undefined,
    });
    await waitFor(() => first.state === "running");

    const second = queue.enqueue({
      project: firstProject,
      task: "second",
      requestedBy: "1",
      execute: async () => {
        secondExecuted = true;
        return "second complete";
      },
      onChange: async (job) => {
        states.push(job.state);
      },
    });

    assert.equal(second.state, "queued");
    await queue.cancel(second.id);
    assert.equal(second.state, "cancelled");
    assert.deepEqual(states, ["cancelled"]);

    firstGate.resolve();
    await waitFor(() => first.state === "completed");
    assert.equal(secondExecuted, false);
    assert.deepEqual(queue.active(), []);
  });

  it("aborts a running job", async () => {
    const queue = new JobQueue();
    const project = { alias: "example", directory: "/tmp/example" };
    const job = queue.enqueue({
      project,
      task: "long task",
      requestedBy: "1",
      execute: async (runningJob) =>
        new Promise<string>((_resolve, reject) => {
          runningJob.controller.signal.addEventListener("abort", () => reject(runningJob.controller.signal.reason), {
            once: true,
          });
        }),
      onChange: async () => undefined,
    });

    await waitFor(() => job.state === "running");
    await queue.cancel(job.id);
    await waitFor(() => job.state === "cancelled");
    assert.deepEqual(queue.active(), []);
  });
});
