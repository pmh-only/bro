export type IntentAction = "run" | "clone" | "projects" | "status" | "cancel" | "help" | "unknown";

export interface NaturalLanguageIntent {
  action: IntentAction;
  project: string | null;
  task: string | null;
  repository: string | null;
  jobId: string | null;
  message: string | null;
}

const actions = new Set<IntentAction>(["run", "clone", "projects", "status", "cancel", "help", "unknown"]);

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`OpenCode returned an invalid ${field}`);
  const trimmed = value.trim();
  return trimmed || null;
}

export function validateIntent(value: unknown): NaturalLanguageIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenCode did not return a natural-language intent object");
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.action !== "string" || !actions.has(candidate.action as IntentAction)) {
    throw new Error("OpenCode returned an unsupported intent action");
  }

  const intent: NaturalLanguageIntent = {
    action: candidate.action as IntentAction,
    project: nullableString(candidate.project, "project"),
    task: nullableString(candidate.task, "task"),
    repository: nullableString(candidate.repository, "repository"),
    jobId: nullableString(candidate.jobId, "job ID"),
    message: nullableString(candidate.message, "message"),
  };

  if (intent.action === "run" && (!intent.project || !intent.task)) {
    throw new Error("OpenCode could not identify both the project and task");
  }
  if (intent.action === "clone" && (!intent.project || !intent.repository)) {
    throw new Error("OpenCode could not identify both the repository and project name");
  }
  if (intent.action === "cancel" && !intent.jobId) {
    throw new Error("OpenCode could not identify the job to cancel");
  }
  return intent;
}

export const intentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["run", "clone", "projects", "status", "cancel", "help", "unknown"] },
    project: { anyOf: [{ type: "string" }, { type: "null" }] },
    task: { anyOf: [{ type: "string" }, { type: "null" }] },
    repository: { anyOf: [{ type: "string" }, { type: "null" }] },
    jobId: { anyOf: [{ type: "string" }, { type: "null" }] },
    message: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["action", "project", "task", "repository", "jobId", "message"],
} as const;
