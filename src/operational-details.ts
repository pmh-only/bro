import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function readOperationalDetails(directory: string, sessionId: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return undefined;
  try {
    const value = JSON.parse(await readFile(join(directory, `${sessionId}.json`), "utf8")) as {
      sessionId?: unknown;
      details?: unknown;
    };
    if (value.sessionId !== sessionId || typeof value.details !== "string") return undefined;
    const details = value.details.trim();
    return details ? details : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    console.warn(`Unable to read operational details for OpenCode session ${sessionId}`, error);
    return undefined;
  }
}
