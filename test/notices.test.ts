import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { Job, JobState } from "../src/jobs.js";
import {
  hasPendingJobNotification,
  operationalDetailsNotification,
  terminalJobNotice,
  terminalJobNotification,
} from "../src/notices.js";

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
    operationalDetailsNotified: false,
    hidden: false,
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

  it("formats operational details as a separate completion reply", () => {
    const completed = job("completed");
    completed.operationalDetails = "Expose port `5432` and persist `/var/lib/postgresql`.";

    assert.deepEqual(operationalDetailsNotification(completed), {
      content: "<@1> **Operational details for job `abcd1234`**\nExpose port `5432` and persist `/var/lib/postgresql`.",
      allowedMentions: { parse: [], users: ["1"], repliedUser: false },
      reply: { messageReference: "message", failIfNotExists: false },
    });
    assert.equal(operationalDetailsNotification(job("failed")), undefined);
  });

  it("redacts secrets from operational detail notifications", () => {
    const completed = job("completed");
    completed.operationalDetails = "Authorization: Bearer production-token-value";
    const notification = operationalDetailsNotification(completed);
    assert.match(String(notification?.content), /Authorization: Bearer \[REDACTED SECRET\]/);
    assert.doesNotMatch(String(notification?.content), /production-token-value/);
  });

  it("keeps completed operational details eligible for retry independently", () => {
    const completed = job("completed");
    completed.notified = true;
    completed.operationalDetails = "Expose port 9000.";

    assert.equal(hasPendingJobNotification(completed), true);
    completed.operationalDetailsNotified = true;
    assert.equal(hasPendingJobNotification(completed), false);
    assert.equal(hasPendingJobNotification(job("failed")), true);
    assert.equal(hasPendingJobNotification(job("cancelled")), false);
  });
});
