import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("Docker OpenCode configuration", () => {
  it("disables the five-minute provider timeout for new and persisted configs", async () => {
    const config = JSON.parse(await readFile("docker/opencode.json", "utf8")) as {
      provider?: Record<string, { options?: { timeout?: number | false } }>;
    };
    const entrypoint = await readFile("docker/docker-entrypoint.sh", "utf8");

    assert.equal(config.provider?.anthropic?.options?.timeout, false);
    assert.equal(config.provider?.openai?.options?.timeout, false);
    assert.match(entrypoint, /OPENCODE_CONFIG_CONTENT=.*anthropic.*timeout.*false.*openai.*timeout.*false/);
  });
});
