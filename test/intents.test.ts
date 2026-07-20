import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { validateIntent } from "../src/intents.js";

describe("natural-language intents", () => {
  it("accepts a clone with an immediate task", () => {
    assert.deepEqual(
      validateIntent({
        action: "clone",
        project: "example project",
        repository: "https://github.com/example/project.git",
        task: "create a Node.js hello world and push it",
        jobId: null,
        instructionAction: null,
        message: null,
      }),
      {
        action: "clone",
        project: "example project",
        repository: "https://github.com/example/project.git",
        task: "create a Node.js hello world and push it",
        jobId: null,
        instructionAction: null,
        message: null,
      },
    );
  });

  it("requires action-specific fields", () => {
    assert.throws(
      () =>
        validateIntent({
          action: "run",
          project: "example",
          repository: null,
          task: null,
          jobId: null,
          instructionAction: null,
          message: null,
        }),
      /both the project and task/,
    );
  });

  it("validates a router-selected action and parallel job target", () => {
    const jobs = [{ id: "abcd1234", project: "example", task: "build the API" }];
    assert.deepEqual(validateIntent({
      action: "instruction",
      project: "example",
      repository: null,
      task: "Add request tracing",
      jobId: "abcd1234",
      instructionAction: "steer",
      message: null,
    }, jobs).instructionAction, "steer");
    assert.throws(() => validateIntent({
      action: "instruction",
      project: "example",
      repository: null,
      task: "Add request tracing",
      jobId: "ffffffff",
      instructionAction: "queue",
      message: null,
    }, jobs), /unavailable instruction target/);
    assert.throws(() => validateIntent({
      action: "instruction",
      project: "example",
      repository: null,
      task: "Add request tracing",
      jobId: "abcd1234",
      instructionAction: null,
      message: null,
    }, jobs), /did not choose queue, steer, or replace/);
  });
});
