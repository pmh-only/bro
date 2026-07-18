import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Project } from "./projects.js";

export type JobState = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";

export interface Job {
  id: string;
  project: Project;
  task: string;
  requestedBy: string;
  channelId: string;
  messageId: string;
  guildId?: string;
  state: JobState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  sessionId?: string;
  sessionUrl?: string;
  result?: string;
  error?: string;
  baseCommit?: string;
  progress?: string;
  promptAttempts: number;
  lastPromptAt?: number;
  notified: boolean;
}

interface EnqueueOptions {
  project: Project;
  task: string;
  requestedBy: string;
  channelId: string;
  messageId: string;
  guildId?: string;
}

export interface JobInstruction {
  id: number;
  jobId: string;
  content: string;
  createdAt: number;
}

const terminalStates = new Set<JobState>(["completed", "failed", "cancelled"]);

export class JobStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        project_alias TEXT NOT NULL,
        project_directory TEXT NOT NULL,
        task TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        guild_id TEXT,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        session_id TEXT,
        session_url TEXT,
        result TEXT,
        error TEXT,
        base_commit TEXT,
        progress TEXT,
        prompt_attempts INTEGER NOT NULL DEFAULT 0,
        last_prompt_at INTEGER,
        notified INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS jobs_state_created ON jobs(state, created_at);
      CREATE TABLE IF NOT EXISTS job_instructions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS job_instructions_pending ON job_instructions(job_id, sent_at, created_at);
    `);
    const columns = this.database.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "base_commit")) {
      this.database.exec("ALTER TABLE jobs ADD COLUMN base_commit TEXT");
    }
    if (!columns.some((column) => column.name === "progress")) {
      this.database.exec("ALTER TABLE jobs ADD COLUMN progress TEXT");
    }
  }

  enqueue(options: EnqueueOptions): Job {
    const job: Job = {
      id: randomUUID().slice(0, 8),
      project: options.project,
      task: options.task,
      requestedBy: options.requestedBy,
      channelId: options.channelId,
      messageId: options.messageId,
      ...(options.guildId ? { guildId: options.guildId } : {}),
      state: "queued",
      createdAt: Date.now(),
      promptAttempts: 0,
      notified: false,
    };
    this.save(job);
    return job;
  }

  save(job: Job): void {
    this.database
      .prepare(`
        INSERT INTO jobs (
          id, project_alias, project_directory, task, requested_by, channel_id, message_id, guild_id,
          state, created_at, started_at, finished_at, session_id, session_url, result, error, base_commit, progress,
          prompt_attempts, last_prompt_at, notified
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          state = excluded.state, started_at = excluded.started_at, finished_at = excluded.finished_at,
          session_id = excluded.session_id, session_url = excluded.session_url, result = excluded.result,
          error = excluded.error, base_commit = excluded.base_commit, progress = excluded.progress,
          prompt_attempts = excluded.prompt_attempts,
          last_prompt_at = excluded.last_prompt_at, notified = excluded.notified
      `)
      .run(...this.values(job));
  }

  get(id: string): Job | undefined {
    return this.row(this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(id.toLowerCase()));
  }

  active(): Job[] {
    return this.database
      .prepare("SELECT * FROM jobs WHERE state NOT IN ('completed', 'failed', 'cancelled') ORDER BY created_at")
      .all()
      .map((row) => this.row(row)!);
  }

  history(limit = 500): Job[] {
    return this.database
      .prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map((row) => this.row(row)!)
      .reverse();
  }

  resume(): void {
    this.database.prepare("UPDATE jobs SET started_at = ? WHERE state = 'running'").run(Date.now());
  }

  ready(): Job[] {
    const active = this.active();
    const occupied = new Set(
      active.filter((job) => job.state !== "queued").map((job) => job.project.directory),
    );
    const selected = new Set<string>();
    return active.filter((job) => {
      if (job.state !== "queued" || occupied.has(job.project.directory) || selected.has(job.project.directory)) return false;
      selected.add(job.project.directory);
      return true;
    });
  }

  cancel(id: string): Job | undefined {
    const job = this.get(id);
    if (!job || terminalStates.has(job.state)) return undefined;
    if (job.state === "queued") {
      job.state = "cancelled";
      job.finishedAt = Date.now();
    } else {
      job.state = "cancelling";
    }
    this.save(job);
    return job;
  }

  enqueueInstruction(jobId: string, content: string): JobInstruction {
    const createdAt = Date.now();
    const result = this.database
      .prepare("INSERT INTO job_instructions (job_id, content, created_at) VALUES (?, ?, ?)")
      .run(jobId, content, createdAt);
    return { id: Number(result.lastInsertRowid), jobId, content, createdAt };
  }

  pendingInstructions(jobId: string): JobInstruction[] {
    return this.database
      .prepare("SELECT id, job_id, content, created_at FROM job_instructions WHERE job_id = ? AND sent_at IS NULL ORDER BY created_at, id")
      .all(jobId)
      .map((value) => {
        const row = value as Record<string, string | number>;
        return { id: Number(row.id), jobId: String(row.job_id), content: String(row.content), createdAt: Number(row.created_at) };
      });
  }

  markInstructionSent(id: number): void {
    this.database.prepare("UPDATE job_instructions SET sent_at = ? WHERE id = ?").run(Date.now(), id);
  }

  close(): void {
    this.database.close();
  }

  private values(job: Job): SQLInputValue[] {
    return [
      job.id,
      job.project.alias,
      job.project.directory,
      job.task,
      job.requestedBy,
      job.channelId,
      job.messageId,
      job.guildId ?? null,
      job.state,
      job.createdAt,
      job.startedAt ?? null,
      job.finishedAt ?? null,
      job.sessionId ?? null,
      job.sessionUrl ?? null,
      job.result ?? null,
      job.error ?? null,
      job.baseCommit ?? null,
      job.progress ?? null,
      job.promptAttempts,
      job.lastPromptAt ?? null,
      job.notified ? 1 : 0,
    ];
  }

  private row(value: unknown): Job | undefined {
    if (!value) return undefined;
    const row = value as Record<string, string | number | null>;
    return {
      id: String(row.id),
      project: { alias: String(row.project_alias), directory: String(row.project_directory) },
      task: String(row.task),
      requestedBy: String(row.requested_by),
      channelId: String(row.channel_id),
      messageId: String(row.message_id),
      ...(row.guild_id ? { guildId: String(row.guild_id) } : {}),
      state: String(row.state) as JobState,
      createdAt: Number(row.created_at),
      ...(row.started_at ? { startedAt: Number(row.started_at) } : {}),
      ...(row.finished_at ? { finishedAt: Number(row.finished_at) } : {}),
      ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
      ...(row.session_url ? { sessionUrl: String(row.session_url) } : {}),
      ...(row.result !== null ? { result: String(row.result) } : {}),
      ...(row.error !== null ? { error: String(row.error) } : {}),
      ...(row.base_commit ? { baseCommit: String(row.base_commit) } : {}),
      ...(row.progress ? { progress: String(row.progress) } : {}),
      promptAttempts: Number(row.prompt_attempts),
      ...(row.last_prompt_at ? { lastPromptAt: Number(row.last_prompt_at) } : {}),
      notified: Boolean(row.notified),
    };
  }
}
