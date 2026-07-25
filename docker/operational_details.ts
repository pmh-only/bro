import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tool } from "@opencode-ai/plugin";

const detailsDirectory = process.env.BRO_OPERATIONAL_DETAILS_DIR || "/home/opencode/data/operational-details";

export default tool({
  description: [
    "Queue a separate Discord message containing operational details after the current job completes successfully.",
    "Use this once near the end only when the work requires configuration, persistent storage paths, exposed ports,",
    "service management, credentials setup, deployment steps, or similar information the operator must act on.",
    "Do not use it for ordinary implementation summaries or verification results.",
  ].join(" "),
  args: {
    details: tool.schema.string().min(1).max(1_500).describe(
      "Concise Markdown instructions for the operator, including exact paths, ports, commands, or settings where relevant.",
    ),
  },
  async execute({ details }, context) {
    if (!/^[A-Za-z0-9_-]+$/.test(context.sessionID)) throw new Error("Invalid OpenCode session ID");
    await mkdir(detailsDirectory, { recursive: true });
    const destination = join(detailsDirectory, `${context.sessionID}.json`);
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ sessionId: context.sessionID, details: details.trim() })}\n`, { mode: 0o600 });
    await rename(temporary, destination);
    return "Operational details queued for a separate Discord message after successful completion.";
  },
});
