import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ButtonStyle, ComponentType } from "discord.js";
import {
  cardComponents,
  instructionChoiceComponents,
  jobComponents,
  jobInstructionModal,
  parseInstructionChoice,
  parseJobButton,
} from "../src/components.js";
import type { Job, JobState } from "../src/jobs.js";

function job(state: JobState): Job {
  return {
    id: "abcd1234",
    scope: "project",
    project: { alias: "example", directory: "/tmp/example" },
    task: "test",
    requestedBy: "1",
    channelId: "channel",
    messageId: "message",
    state,
    createdAt: Date.now(),
    projectSequence: 1,
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
    const running = jobComponents(job("running"), "Job details", "https://code.example/base")[0]!.toJSON();
    const completed = jobComponents(job("completed"), "Job details", "https://code.example/base")[0]!.toJSON();
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
      [ButtonStyle.Link, ButtonStyle.Link, "job:refresh:abcd1234", "job:prompt:abcd1234", "job:cancel:abcd1234"],
    );
    assert.deepEqual(
      completedButtons.map((button) => (button.type === ComponentType.Button ? button.style : undefined)),
      [ButtonStyle.Link],
    );
    const codeServerButton = runningButtons[1];
    assert.equal(codeServerButton && "label" in codeServerButton ? codeServerButton.label : undefined, "Open in code-server");
    assert.equal(
      codeServerButton && "url" in codeServerButton ? codeServerButton.url : undefined,
      "https://code.example/base?folder=%2Ftmp%2Fexample",
    );
  });

  it("parses only supported job button identifiers", () => {
    assert.deepEqual(parseJobButton("job:cancel:abcd1234"), { action: "cancel", jobId: "abcd1234" });
    assert.deepEqual(parseJobButton("job:prompt:abcd1234"), { action: "prompt", jobId: "abcd1234" });
    assert.equal(parseJobButton("job:delete:abcd1234"), undefined);
    assert.equal(parseJobButton("job:cancel:not-a-job"), undefined);
  });

  it("builds a multiline instruction modal", () => {
    const modal = jobInstructionModal("abcd1234").toJSON();
    const row = modal.components[0];
    const input = row?.type === ComponentType.ActionRow ? row.components[0] : undefined;

    assert.equal(modal.custom_id, "job:prompt:abcd1234");
    assert.equal(input?.type, ComponentType.TextInput);
    assert.equal(input && "custom_id" in input ? input.custom_id : undefined, "instruction");
  });

  it("prompts for queue, replace, or steer after receiving an instruction", () => {
    const choice = instructionChoiceComponents("1234abcd", "abcd1234")[0]!.toJSON();
    const buttons = choice.components.flatMap((component) =>
      component.type === ComponentType.ActionRow ? component.components : [],
    );

    assert.deepEqual(
      buttons.map((button) => button.type === ComponentType.Button && "custom_id" in button ? button.custom_id : undefined),
      ["instruction:queue:1234abcd", "instruction:replace:1234abcd", "instruction:steer:1234abcd"],
    );
    assert.deepEqual(parseInstructionChoice("instruction:steer:1234abcd"), {
      action: "steer",
      choiceId: "1234abcd",
    });
    assert.equal(parseInstructionChoice("instruction:skip:1234abcd"), undefined);
  });
});
