import { dirname, join, resolve } from "node:path";

export interface AppConfig {
  discordToken: string;
  allowedUserIds: Set<string>;
  allowedRoleIds: Set<string>;
  allowedGuildIds: Set<string>;
  allowedChannelIds: Set<string>;
  opencodeUrl: string;
  opencodePublicUrl: string;
  opencodeUsername: string;
  opencodePassword?: string;
  opencodeAgent: string;
  opencodeModel?: { providerID: string; modelID: string };
  opencodeReasoningEffort?: string;
  opencodeAutoApprove: boolean;
  taskTimeoutMs: number;
  routingTimeoutMs: number;
  cloneTimeoutMs: number;
  jobPollIntervalMs: number;
  jobContinueIntervalMs: number;
  jobsDatabase: string;
  projectsFile: string;
  projectsRoot: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function idSet(value: string | undefined, name: string): Set<string> {
  const ids = new Set(
    (value ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );

  for (const id of ids) {
    if (!/^\d+$/.test(id)) throw new Error(`${name} must contain comma-separated Discord IDs`);
  }
  return ids;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  throw new Error(`Expected true or false, received ${JSON.stringify(value)}`);
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function model(value: string | undefined): AppConfig["opencodeModel"] {
  const configured = value?.trim();
  if (!configured) return undefined;
  const separator = configured.indexOf("/");
  if (separator <= 0 || separator === configured.length - 1) {
    throw new Error("OPENCODE_MODEL must use provider/model format");
  }
  return { providerID: configured.slice(0, separator), modelID: configured.slice(separator + 1) };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const allowedUserIds = idSet(env.DISCORD_ALLOWED_USER_IDS, "DISCORD_ALLOWED_USER_IDS");
  const allowedRoleIds = idSet(env.DISCORD_ALLOWED_ROLE_IDS, "DISCORD_ALLOWED_ROLE_IDS");
  if (allowedUserIds.size === 0 && allowedRoleIds.size === 0) {
    throw new Error("Set DISCORD_ALLOWED_USER_IDS or DISCORD_ALLOWED_ROLE_IDS; unrestricted access is not allowed");
  }

  const opencodeUrl = new URL(env.OPENCODE_URL?.trim() || "http://localhost:4096");
  if (opencodeUrl.protocol !== "http:" && opencodeUrl.protocol !== "https:") {
    throw new Error("OPENCODE_URL must use http or https");
  }
  const opencodePublicUrl = new URL(env.OPENCODE_PUBLIC_URL?.trim() || opencodeUrl);
  if (opencodePublicUrl.protocol !== "http:" && opencodePublicUrl.protocol !== "https:") {
    throw new Error("OPENCODE_PUBLIC_URL must use http or https");
  }

  const password = env.OPENCODE_PASSWORD?.trim();
  const opencodeModel = model(env.OPENCODE_MODEL);
  const projectsFile = resolve(env.PROJECTS_FILE?.trim() || "projects.json");
  return {
    discordToken: required(env, "DISCORD_TOKEN"),
    allowedUserIds,
    allowedRoleIds,
    allowedGuildIds: idSet(env.DISCORD_ALLOWED_GUILD_IDS, "DISCORD_ALLOWED_GUILD_IDS"),
    allowedChannelIds: idSet(env.DISCORD_ALLOWED_CHANNEL_IDS, "DISCORD_ALLOWED_CHANNEL_IDS"),
    opencodeUrl: opencodeUrl.toString().replace(/\/$/, ""),
    opencodePublicUrl: opencodePublicUrl.toString().replace(/\/$/, ""),
    opencodeUsername: env.OPENCODE_USERNAME?.trim() || "opencode",
    ...(password ? { opencodePassword: password } : {}),
    opencodeAgent: env.OPENCODE_AGENT?.trim() || "build",
    ...(opencodeModel ? { opencodeModel } : {}),
    ...(env.OPENCODE_REASONING_EFFORT?.trim() ? { opencodeReasoningEffort: env.OPENCODE_REASONING_EFFORT.trim() } : {}),
    opencodeAutoApprove: booleanValue(env.OPENCODE_AUTO_APPROVE, true),
    taskTimeoutMs: positiveInteger(env.OPENCODE_TASK_TIMEOUT_MS, 30 * 60 * 1_000, "OPENCODE_TASK_TIMEOUT_MS"),
    routingTimeoutMs: positiveInteger(env.OPENCODE_ROUTING_TIMEOUT_MS, 2 * 60 * 1_000, "OPENCODE_ROUTING_TIMEOUT_MS"),
    cloneTimeoutMs: positiveInteger(env.GIT_CLONE_TIMEOUT_MS, 5 * 60 * 1_000, "GIT_CLONE_TIMEOUT_MS"),
    jobPollIntervalMs: positiveInteger(env.JOB_POLL_INTERVAL_MS, 10_000, "JOB_POLL_INTERVAL_MS"),
    jobContinueIntervalMs: positiveInteger(env.JOB_CONTINUE_INTERVAL_MS, 60_000, "JOB_CONTINUE_INTERVAL_MS"),
    jobsDatabase: resolve(env.JOBS_DATABASE?.trim() || join(dirname(projectsFile), "jobs.sqlite")),
    projectsFile,
    projectsRoot: resolve(env.PROJECTS_ROOT?.trim() || "projects"),
  };
}
