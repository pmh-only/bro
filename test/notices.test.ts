import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { Job, JobState } from "../src/jobs.js";
import { terminalJobNotice } from "../src/notices.js";

function job(state: JobState): Job {
  return {
    id: "abcd1234",
    project: { alias: "example", directory: "/tmp/example" },
    task: "test",
    requestedBy: "1",
    channelId: "channel",
    messageId: "message",
    state,
    createdAt: Date.now(),
    promptAttempts: 1,
    notified: false,
  };
}

describe("Discord job notices", () => {
  it("formats completed and failed outcomes", () => {
    assert.match(terminalJobNotice(job("completed")) ?? "", /completed successfully/);
    assert.match(terminalJobNotice(job("failed")) ?? "", /failed/);
  });

  it("does not notify for non-terminal progress", () => {
    assert.equal(terminalJobNotice(job("running")), undefined);
    assert.equal(terminalJobNotice(job("cancelled")), undefined);
  });
});
