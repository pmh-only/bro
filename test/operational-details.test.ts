import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { readOperationalDetails } from "../src/operational-details.js";

describe("operational details handoff", () => {
  it("reads details written for the matching OpenCode session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bro-operational-details-"));
    await writeFile(join(directory, "ses_test.json"), JSON.stringify({
      sessionId: "ses_test",
      details: "  Persist `/data` and expose port `9000`.  ",
    }));

    assert.equal(
      await readOperationalDetails(directory, "ses_test"),
      "Persist `/data` and expose port `9000`.",
    );
    assert.equal(await readOperationalDetails(directory, "../unsafe"), undefined);
  });

  it("ignores absent, mismatched, and empty handoffs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bro-operational-details-"));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "ses_wrong.json"), JSON.stringify({ sessionId: "other", details: "port 80" }));
    await writeFile(join(directory, "ses_empty.json"), JSON.stringify({ sessionId: "ses_empty", details: " " }));

    assert.equal(await readOperationalDetails(directory, "ses_missing"), undefined);
    assert.equal(await readOperationalDetails(directory, "ses_wrong"), undefined);
    assert.equal(await readOperationalDetails(directory, "ses_empty"), undefined);
  });
});
