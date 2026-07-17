import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ButtonStyle, ComponentType } from "discord.js";
import { cardComponents, jobComponents, parseJobButton } from "../src/components.js";
import type { Job, JobState } from "../src/jobs.js";

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
    sessionUrl: "https://opencode.example/session/abcd",
    promptAttempts: 1,
    notified: false,
  };
}

describe("Discord Components v2", () => {
  it("renders content in a container", () => {
    const [container] = cardComponents("Working", "Understanding the request");
    const data = container?.toJSON();

    assert.equal(data?.type, ComponentType.Container);
    assert.equal(data?.components[0]?.type, ComponentType.TextDisplay);
    assert.match("content" in data!.components[0]! ? data!.components[0].content : "", /## Working/);
  });

  it("adds job actions appropriate for the current state", () => {
    const running = jobComponents(job("running"), "Job details")[0]!.toJSON();
    const completed = jobComponents(job("completed"), "Job details")[0]!.toJSON();
    const runningButtons = running.components.flatMap((component) =>
      component.type === ComponentType.ActionRow ? component.components : [],
    );
    const completedButtons = completed.components.flatMap((component) =>
      component.type === ComponentType.ActionRow ? component.components : [],
    );

    assert.deepEqual(
      runningButtons.map((button) =>
        button.type === ComponentType.Button ? ("custom_id" in button ? button.custom_id : button.style) : undefined,
      ),
      [ButtonStyle.Link, "job:refresh:abcd1234", "job:cancel:abcd1234"],
    );
    assert.deepEqual(
      completedButtons.map((button) => (button.type === ComponentType.Button ? button.style : undefined)),
      [ButtonStyle.Link],
    );
  });

  it("parses only supported job button identifiers", () => {
    assert.deepEqual(parseJobButton("job:cancel:abcd1234"), { action: "cancel", jobId: "abcd1234" });
    assert.equal(parseJobButton("job:delete:abcd1234"), undefined);
    assert.equal(parseJobButton("job:cancel:not-a-job"), undefined);
  });
});
