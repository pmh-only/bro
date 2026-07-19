import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("configuration", () => {
  it("loads secure defaults", () => {
    const config = loadConfig({
      DISCORD_TOKEN: "token",
      DISCORD_ALLOWED_USER_IDS: "123, 456",
    });

    assert.deepEqual([...config.allowedUserIds], ["123", "456"]);
    assert.equal(config.opencodeUrl, "http://localhost:4096");
    assert.equal(config.opencodePublicUrl, "http://localhost:4096");
    assert.equal(config.codeServerPublicUrl, "http://localhost:8081");
    assert.equal(config.opencodeAutoApprove, true);
    assert.equal(config.opencodeModel, undefined);
    assert.equal(config.opencodeReasoningEffort, undefined);
    assert.equal(config.taskTimeoutMs, 30 * 60 * 1_000);
    assert.equal(config.routingTimeoutMs, 2 * 60 * 1_000);
    assert.equal(config.cloneTimeoutMs, 5 * 60 * 1_000);
    assert.equal(config.jobPollIntervalMs, 10_000);
    assert.equal(config.jobContinueIntervalMs, 60_000);
    assert.equal(config.webPort, 8_080);
    assert.match(config.jobsDatabase, /jobs\.sqlite$/);
  });

  it("requires an allowlisted user or role", () => {
    assert.throws(
      () => loadConfig({ DISCORD_TOKEN: "token" }),
      /DISCORD_ALLOWED_USER_IDS or DISCORD_ALLOWED_ROLE_IDS/,
    );
  });

  it("validates Discord IDs", () => {
    assert.throws(
      () => loadConfig({ DISCORD_TOKEN: "token", DISCORD_ALLOWED_ROLE_IDS: "developers" }),
      /comma-separated Discord IDs/,
    );
  });

  it("allows automatic permission approval to be disabled", () => {
    const config = loadConfig({
      DISCORD_TOKEN: "token",
      DISCORD_ALLOWED_USER_IDS: "123",
      OPENCODE_AUTO_APPROVE: "false",
    });
    assert.equal(config.opencodeAutoApprove, false);
  });

  it("uses a separate public OpenCode URL for browser links", () => {
    const config = loadConfig({
      DISCORD_TOKEN: "token",
      DISCORD_ALLOWED_USER_IDS: "123",
      OPENCODE_URL: "http://opencode:4096",
      OPENCODE_PUBLIC_URL: "https://opencode.example.com/",
    });

    assert.equal(config.opencodeUrl, "http://opencode:4096");
    assert.equal(config.opencodePublicUrl, "https://opencode.example.com");
  });

  it("uses a separate public code-server URL for running job links", () => {
    const config = loadConfig({
      DISCORD_TOKEN: "token",
      DISCORD_ALLOWED_USER_IDS: "123",
      CODE_SERVER_PUBLIC_URL: "https://code.example.com/base/",
    });

    assert.equal(config.codeServerPublicUrl, "https://code.example.com/base");
  });

  it("accepts a model and reasoning-effort variant", () => {
    const config = loadConfig({
      DISCORD_TOKEN: "token",
      DISCORD_ALLOWED_USER_IDS: "123",
      OPENCODE_MODEL: "openrouter/openai/gpt-5.2",
      OPENCODE_REASONING_EFFORT: "high",
    });

    assert.deepEqual(config.opencodeModel, { providerID: "openrouter", modelID: "openai/gpt-5.2" });
    assert.equal(config.opencodeReasoningEffort, "high");
  });

  it("requires model settings to include a provider and model", () => {
    assert.throws(
      () => loadConfig({ DISCORD_TOKEN: "token", DISCORD_ALLOWED_USER_IDS: "123", OPENCODE_MODEL: "gpt-5.2" }),
      /provider\/model format/,
    );
  });
});
