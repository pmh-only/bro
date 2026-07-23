import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { discordAttachments } from "../src/attachments.js";

describe("Discord attachments", () => {
  it("converts Discord files to OpenCode attachment metadata", () => {
    assert.deepEqual(discordAttachments([
      { contentType: "image/png", name: "mockup.png", url: "https://cdn.discordapp.com/mockup.png" },
      { contentType: null, name: "data.bin", url: "https://cdn.discordapp.com/data.bin" },
    ]), [
      { mime: "image/png", filename: "mockup.png", url: "https://cdn.discordapp.com/mockup.png" },
      { mime: "application/octet-stream", filename: "data.bin", url: "https://cdn.discordapp.com/data.bin" },
    ]);
  });
});
