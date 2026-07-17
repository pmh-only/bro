import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { loginWithRetry } from "../src/discord.js";

describe("Discord login", () => {
  it("backs off and creates a fresh client after transient failures", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const clients = [
      { login: async () => Promise.reject(new Error("Internal Server Error")) },
      { login: async () => Promise.reject(new Error("rate limited")) },
      { login: async () => Promise.resolve("token") },
    ];

    const connected = await loginWithRetry(
      () => clients[attempts++]!,
      "token",
      { wait: async (delayMs) => void waits.push(delayMs) },
    );

    assert.equal(connected, clients[2]);
    assert.equal(attempts, 3);
    assert.deepEqual(waits, [60_000, 120_000]);
  });

  it("does not retry an invalid token", async () => {
    const invalidToken = Object.assign(new Error("invalid token"), { code: "TokenInvalid" });
    let waited = false;

    await assert.rejects(
      loginWithRetry(() => ({ login: async () => Promise.reject(invalidToken) }), "token", {
        wait: async () => {
          waited = true;
        },
      }),
      invalidToken,
    );
    assert.equal(waited, false);
  });
});
