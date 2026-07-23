import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { Job, JobState } from "../src/jobs.js";
import { terminalJobNotice, terminalJobNotification } from "../src/notices.js";

function job(state: JobState): Job {
  return {
    id: "abcd1234",
    scope: "project",
    project: { alias: "example", directory: "/tmp/example" },
    task: "test",
    attachments: [],
    requestedBy: "1",
    channelId: "channel",
    messageId: "message",
    state,
    createdAt: Date.now(),
    projectSequence: 1,
    promptAttempts: 1,
    notified: false,
  };
}

describe("Discord job notices", () => {
  it("formats completed and failed outcomes", () => {
    assert.match(terminalJobNotice(job("completed")) ?? "", /completed successfully/);
    assert.match(terminalJobNotice(job("failed")) ?? "", /failed/);
  });

  it("replies to the completed status card when notifying the requester", () => {
    assert.deepEqual(terminalJobNotification(job("completed")), {
      content: "<@1> Job `abcd1234` on **example** completed successfully. See the updated status message for details.",
      allowedMentions: { parse: [], users: ["1"], repliedUser: false },
      reply: { messageReference: "message", failIfNotExists: false },
    });
  });

  it("does not notify for non-terminal progress", () => {
    assert.equal(terminalJobNotice(job("running")), undefined);
    assert.equal(terminalJobNotice(job("cancelled")), undefined);
    assert.equal(terminalJobNotification(job("running")), undefined);
  });
});
