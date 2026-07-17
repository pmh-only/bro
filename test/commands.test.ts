import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { hasBotMention, stripBotMention } from "../src/commands.js";

describe("Discord mention handling", () => {
  it("removes direct Discord mention forms without parsing the request", () => {
    assert.equal(
      stripBotMention("<@1234> please clone the repo and call it example", "1234"),
      "please clone the repo and call it example",
    );
    assert.equal(stripBotMention("hello <@!1234>", "1234"), "hello");
  });

  it("requires a direct mention in message content", () => {
    assert.equal(hasBotMention("<@1234> show my projects", "1234"), true);
    assert.equal(hasBotMention("<@!1234> show my projects", "1234"), true);
    assert.equal(hasBotMention("@everyone show my projects", "1234"), false);
    assert.equal(hasBotMention("show my projects", "1234"), false);
  });
});
