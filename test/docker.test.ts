import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("Docker OpenCode configuration", () => {
  it("disables the five-minute provider timeout for new and persisted configs", async () => {
    const config = JSON.parse(await readFile("docker/opencode.json", "utf8")) as {
      provider?: Record<string, { options?: { timeout?: number | false } }>;
    };
    const entrypoint = await readFile("docker/docker-entrypoint.sh", "utf8");

    assert.equal(config.provider?.anthropic?.options?.timeout, false);
    assert.equal(config.provider?.openai?.options?.timeout, false);
    assert.equal(config.provider?.openrouter?.options?.timeout, false);
    assert.match(entrypoint, /opencode-provider-timeouts\.mjs/);
  });

  it("disables the timeout for the configured model provider", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["docker/opencode-provider-timeouts.mjs", "docker/opencode.json"],
      { env: { ...process.env, OPENCODE_MODEL: "custom-provider/model" } },
    );
    const overlay = JSON.parse(stdout) as {
      provider: Record<string, { options: { timeout: number | false } }>;
    };

    assert.equal(overlay.provider.openrouter?.options.timeout, false);
    assert.equal(overlay.provider["custom-provider"]?.options.timeout, false);
  });
});
