import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
        message: null,
      }),
      {
        action: "clone",
        project: "example project",
        repository: "https://github.com/example/project.git",
        task: "create a Node.js hello world and push it",
        jobId: null,
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
          message: null,
        }),
      /both the project and task/,
    );
  });
});
