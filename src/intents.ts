import type { InstructionAction } from "./jobs.js";

export type IntentAction = "run" | "global" | "instruction" | "clone" | "projects" | "status" | "cancel" | "help" | "unknown";

export interface RoutableJob {
  id: string;
  project: string;
  task: string;
}

export interface NaturalLanguageIntent {
  action: IntentAction;
  project: string | null;
  task: string | null;
  repository: string | null;
  jobId: string | null;
  instructionAction: InstructionAction | null;
  message: string | null;
}

const actions = new Set<IntentAction>(["run", "global", "instruction", "clone", "projects", "status", "cancel", "help", "unknown"]);
const instructionActions = new Set<InstructionAction>(["queue", "replace", "steer"]);

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`OpenCode returned an invalid ${field}`);
  const trimmed = value.trim();
  return trimmed || null;
}

export function validateIntent(value: unknown, routableJobs: readonly RoutableJob[] = []): NaturalLanguageIntent {
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
    instructionAction: nullableString(candidate.instructionAction, "instruction action") as InstructionAction | null,
    message: nullableString(candidate.message, "message"),
  };

  if (intent.instructionAction && !instructionActions.has(intent.instructionAction)) {
    throw new Error("OpenCode returned an unsupported instruction action");
  }

  if (intent.action === "run" && (!intent.project || !intent.task)) {
    throw new Error("OpenCode could not identify both the project and task");
  }
  if (intent.action === "global" && !intent.task) {
    throw new Error("OpenCode could not identify the global task");
  }
  if (intent.action === "clone" && (!intent.project || !intent.repository)) {
    throw new Error("OpenCode could not identify both the repository and project name");
  }
  if (intent.action === "cancel" && !intent.jobId) {
    throw new Error("OpenCode could not identify the job to cancel");
  }
  if (intent.action === "instruction") {
    if (!intent.jobId || !intent.task) throw new Error("OpenCode could not identify both the job and instruction");
    if (!intent.instructionAction) throw new Error("OpenCode did not choose queue, steer, or replace for the instruction");
    const target = routableJobs.find((job) => job.id === intent.jobId);
    if (!target || (intent.project && intent.project !== target.project)) {
      throw new Error("OpenCode selected an unavailable instruction target");
    }
  }
  return intent;
}

export const intentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["run", "global", "instruction", "clone", "projects", "status", "cancel", "help", "unknown"] },
    project: { anyOf: [{ type: "string" }, { type: "null" }] },
    task: { anyOf: [{ type: "string" }, { type: "null" }] },
    repository: { anyOf: [{ type: "string" }, { type: "null" }] },
    jobId: { anyOf: [{ type: "string" }, { type: "null" }] },
    instructionAction: { anyOf: [{ type: "string", enum: ["queue", "replace", "steer"] }, { type: "null" }] },
    message: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["action", "project", "task", "repository", "jobId", "instructionAction", "message"],
} as const;
