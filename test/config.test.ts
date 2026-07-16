import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";

describe("configuration", () => {
  it("loads secure defaults", () => {
    const config = loadConfig({
      DISCORD_TOKEN: "token",
      DISCORD_ALLOWED_USER_IDS: "123, 456",
    });

    assert.deepEqual([...config.allowedUserIds], ["123", "456"]);
    assert.equal(config.opencodeUrl, "http://localhost:4096");
    assert.equal(config.opencodeAutoApprove, true);
    assert.equal(config.taskTimeoutMs, 30 * 60 * 1_000);
    assert.equal(config.routingTimeoutMs, 2 * 60 * 1_000);
    assert.equal(config.cloneTimeoutMs, 5 * 60 * 1_000);
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
});
