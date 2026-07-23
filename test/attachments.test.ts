import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { discordAttachments } from "../src/attachments.js";

describe("Discord attachments", () => {
  it("downloads Discord files as OpenCode data URL attachments", async () => {
    const requested: string[] = [];
    const fetchAttachment = async (url: string): Promise<Response> => {
      requested.push(url);
      return url.endsWith("mockup.png")
        ? new Response(Buffer.from([0, 1, 2]), { headers: { "content-type": "ignored/type" } })
        : new Response("notes", { headers: { "content-type": "text/plain; charset=utf-8" } });
    };

    assert.deepEqual(await discordAttachments([
      { contentType: "image/png", name: "mockup.png", url: "https://cdn.discordapp.com/mockup.png" },
      { contentType: null, name: "notes.txt", url: "https://cdn.discordapp.com/notes.txt" },
    ], fetchAttachment), [
      { mime: "image/png", filename: "mockup.png", url: "data:image/png;base64,AAEC" },
      { mime: "text/plain", filename: "notes.txt", url: "data:text/plain;base64,bm90ZXM=" },
    ]);
    assert.deepEqual(requested, [
      "https://cdn.discordapp.com/mockup.png",
      "https://cdn.discordapp.com/notes.txt",
    ]);
  });

  it("reports failed Discord attachment downloads", async () => {
    await assert.rejects(discordAttachments([
      { contentType: null, name: "data.bin", url: "https://cdn.discordapp.com/data.bin" },
    ], async () => new Response(null, { status: 404 })), {
      message: "Unable to download Discord attachment data.bin: HTTP 404",
    });
  });

  it("falls back to a binary MIME type", async () => {
    assert.deepEqual(await discordAttachments([
      { contentType: null, name: "data.bin", url: "https://cdn.discordapp.com/data.bin" },
    ], async () => new Response(Buffer.from([255]))), [
      { mime: "application/octet-stream", filename: "data.bin", url: "data:application/octet-stream;base64,/w==" },
    ]);
  });
});
