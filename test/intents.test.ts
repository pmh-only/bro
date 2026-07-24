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
        historyVisible: null,
        message: null,
      }),
      {
        action: "clone",
        project: "example project",
        repository: "https://github.com/example/project.git",
        task: "create a Node.js hello world and push it",
        jobId: null,
        instructionAction: null,
        historyVisible: null,
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
          historyVisible: null,
          message: null,
        }),
      /both the project and task/,
    );
    assert.throws(
      () => validateIntent({
        action: "global",
        project: null,
        repository: null,
        task: null,
        jobId: null,
        instructionAction: null,
        historyVisible: null,
        message: null,
      }),
      /global task/,
    );
  });

  it("accepts an environment-wide task", () => {
    const intent = validateIntent({
      action: "global",
      project: null,
      repository: null,
      task: "Install the shared system package",
      jobId: null,
      instructionAction: null,
      historyVisible: null,
      message: null,
    });

    assert.equal(intent.action, "global");
    assert.equal(intent.project, null);
    assert.equal(intent.task, "Install the shared system package");
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
      historyVisible: null,
      message: null,
    }, jobs).instructionAction, "steer");
    assert.throws(() => validateIntent({
      action: "instruction",
      project: "example",
      repository: null,
      task: "Add request tracing",
      jobId: "ffffffff",
      instructionAction: "queue",
      historyVisible: null,
      message: null,
    }, jobs), /unavailable instruction target/);
    assert.throws(() => validateIntent({
      action: "instruction",
      project: "example",
      repository: null,
      task: "Add request tracing",
      jobId: "abcd1234",
      instructionAction: null,
      historyVisible: null,
      message: null,
    }, jobs), /did not choose queue, steer, or replace/);
  });

  it("accepts explicit Web UI job history visibility", () => {
    const hidden = validateIntent({
      action: "history",
      project: null,
      repository: null,
      task: null,
      jobId: null,
      instructionAction: null,
      historyVisible: false,
      message: null,
    });

    assert.equal(hidden.action, "history");
    assert.equal(hidden.historyVisible, false);
    const specific = validateIntent({
      action: "history",
      project: null,
      repository: null,
      task: null,
      jobId: "abcd1234",
      instructionAction: null,
      historyVisible: false,
      message: null,
    });
    assert.equal(specific.jobId, "abcd1234");
    assert.throws(() => validateIntent({
      action: "history",
      project: null,
      repository: null,
      task: null,
      jobId: null,
      instructionAction: null,
      historyVisible: null,
      message: null,
    }), /whether to show or hide job history/);
  });
});
