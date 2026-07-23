import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { OpenCodeAttachment } from "./attachments.js";
import type { Project } from "./projects.js";

export type JobState = "queued" | "running" | "integrating" | "conflicted" | "cancelling" | "completed" | "failed" | "cancelled";
export type JobScope = "project" | "global";
export type InstructionAction = "queue" | "replace" | "steer";

export interface Job {
  id: string;
  scope: JobScope;
  project: Project;
  task: string;
  attachments: OpenCodeAttachment[];
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
  worktreeDirectory?: string;
  worktreeBranch?: string;
  targetBranch?: string;
  projectSequence: number;
  integrationBase?: string;
  integrationHead?: string;
  progress?: string;
  interruptAction?: "replace" | "steer";
  promptAttempts: number;
  lastPromptAt?: number;
  consumedTokens?: number;
  notified: boolean;
}

interface EnqueueOptions {
  scope?: JobScope;
  project: Project;
  task: string;
  attachments?: OpenCodeAttachment[];
  requestedBy: string;
  channelId: string;
  messageId: string;
  guildId?: string;
}

export interface JobInstruction {
  id: number;
  jobId: string;
  content: string;
  attachments: OpenCodeAttachment[];
  createdAt: number;
  sequence: number;
  sentAt?: number;
  completedAt?: number;
}

export interface InstructionChoice {
  id: string;
  jobId: string;
  content: string;
  attachments: OpenCodeAttachment[];
  requestedBy: string;
  createdAt: number;
  resolvedAction?: InstructionAction;
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
        scope TEXT NOT NULL DEFAULT 'project',
        project_alias TEXT NOT NULL,
        project_directory TEXT NOT NULL,
        task TEXT NOT NULL,
        attachments TEXT NOT NULL DEFAULT '[]',
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
        worktree_directory TEXT,
        worktree_branch TEXT,
        target_branch TEXT,
        project_sequence INTEGER NOT NULL,
        integration_base TEXT,
        integration_head TEXT,
        progress TEXT,
        interrupt_action TEXT,
        prompt_attempts INTEGER NOT NULL DEFAULT 0,
        last_prompt_at INTEGER,
        consumed_tokens INTEGER,
        notified INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS jobs_state_created ON jobs(state, created_at);
      CREATE TABLE IF NOT EXISTS job_instructions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        content TEXT NOT NULL,
        attachments TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        sent_at INTEGER,
        completed_at INTEGER,
        FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS job_instructions_pending ON job_instructions(job_id, sent_at, created_at);
      CREATE TABLE IF NOT EXISTS instruction_choices (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        content TEXT NOT NULL,
        attachments TEXT NOT NULL DEFAULT '[]',
        requested_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        resolved_action TEXT,
        FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const columns = this.database.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "scope")) {
      this.database.exec("ALTER TABLE jobs ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'");
    }
    if (!columns.some((column) => column.name === "attachments")) {
      this.database.exec("ALTER TABLE jobs ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
    }
    if (!columns.some((column) => column.name === "base_commit")) {
      this.database.exec("ALTER TABLE jobs ADD COLUMN base_commit TEXT");
    }
    if (!columns.some((column) => column.name === "progress")) {
      this.database.exec("ALTER TABLE jobs ADD COLUMN progress TEXT");
    }
    if (!columns.some((column) => column.name === "interrupt_action")) {
      this.database.exec("ALTER TABLE jobs ADD COLUMN interrupt_action TEXT");
    }
    if (!columns.some((column) => column.name === "worktree_directory")) {
      this.database.exec("ALTER TABLE jobs ADD COLUMN worktree_directory TEXT");
    }
    if (!columns.some((column) => column.name === "worktree_branch")) {
      this.database.exec("ALTER TABLE jobs ADD COLUMN worktree_branch TEXT");
    }
    if (!columns.some((column) => column.name === "target_branch")) {
      this.database.exec("ALTER TABLE jobs ADD COLUMN target_branch TEXT");
    }
    if (!columns.some((column) => column.name === "project_sequence")) {
      this.database.exec(`
        ALTER TABLE jobs ADD COLUMN project_sequence INTEGER;
        UPDATE jobs SET project_sequence = (
          SELECT COUNT(*) FROM jobs AS earlier
          WHERE earlier.project_directory = jobs.project_directory
            AND (earlier.created_at < jobs.created_at OR (earlier.created_at = jobs.created_at AND earlier.id <= jobs.id))
        )
      `);
    }
    if (!columns.some((column) => column.name === "integration_base")) {
      this.database.exec("ALTER TABLE jobs ADD COLUMN integration_base TEXT");
    }
    if (!columns.some((column) => column.name === "integration_head")) {
      this.database.exec("ALTER TABLE jobs ADD COLUMN integration_head TEXT");
    }
    if (!columns.some((column) => column.name === "consumed_tokens")) {
      this.database.exec("ALTER TABLE jobs ADD COLUMN consumed_tokens INTEGER");
    }
    const instructionColumns = this.database.prepare("PRAGMA table_info(job_instructions)").all() as Array<{ name: string }>;
    if (!instructionColumns.some((column) => column.name === "attachments")) {
      this.database.exec("ALTER TABLE job_instructions ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
    }
    if (!instructionColumns.some((column) => column.name === "sequence")) {
      this.database.exec("ALTER TABLE job_instructions ADD COLUMN sequence INTEGER; UPDATE job_instructions SET sequence = id");
    }
    if (!instructionColumns.some((column) => column.name === "completed_at")) {
      this.database.exec(`
        ALTER TABLE job_instructions ADD COLUMN completed_at INTEGER;
        UPDATE job_instructions SET completed_at = sent_at
        WHERE sent_at IS NOT NULL AND (
          job_id IN (SELECT id FROM jobs WHERE state IN ('completed', 'failed', 'cancelled'))
          OR id != (
            SELECT latest.id FROM job_instructions AS latest
            WHERE latest.job_id = job_instructions.job_id AND latest.sent_at IS NOT NULL
            ORDER BY latest.sent_at DESC, latest.id DESC LIMIT 1
          )
        )
      `);
    }
    const choiceColumns = this.database.prepare("PRAGMA table_info(instruction_choices)").all() as Array<{ name: string }>;
    if (!choiceColumns.some((column) => column.name === "attachments")) {
      this.database.exec("ALTER TABLE instruction_choices ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
    }
    this.database.exec("DROP INDEX job_instructions_pending; CREATE INDEX job_instructions_pending ON job_instructions(job_id, sent_at, sequence)");
  }

  enqueue(options: EnqueueOptions): Job {
    const projectSequence = Number((this.database.prepare(
      "SELECT COALESCE(MAX(project_sequence), 0) + 1 AS sequence FROM jobs WHERE project_directory = ?",
    ).get(options.project.directory) as { sequence: number }).sequence);
    const job: Job = {
      id: randomUUID().slice(0, 8),
      scope: options.scope ?? "project",
      project: options.project,
      task: options.task,
      attachments: options.attachments ?? [],
      requestedBy: options.requestedBy,
      channelId: options.channelId,
      messageId: options.messageId,
      ...(options.guildId ? { guildId: options.guildId } : {}),
      state: "queued",
      createdAt: Date.now(),
      projectSequence,
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
          id, scope, project_alias, project_directory, task, attachments, requested_by, channel_id, message_id, guild_id,
          state, created_at, started_at, finished_at, session_id, session_url, result, error, base_commit, progress,
          worktree_directory, worktree_branch, target_branch, project_sequence, integration_base, integration_head,
          interrupt_action, prompt_attempts, last_prompt_at, consumed_tokens, notified
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          attachments = excluded.attachments,
          state = excluded.state, started_at = excluded.started_at, finished_at = excluded.finished_at,
          session_id = excluded.session_id, session_url = excluded.session_url, result = excluded.result,
          error = excluded.error, base_commit = excluded.base_commit, progress = excluded.progress,
          worktree_directory = excluded.worktree_directory, worktree_branch = excluded.worktree_branch,
          target_branch = excluded.target_branch, project_sequence = excluded.project_sequence,
          integration_base = excluded.integration_base, integration_head = excluded.integration_head,
          interrupt_action = excluded.interrupt_action,
          prompt_attempts = excluded.prompt_attempts,
          last_prompt_at = excluded.last_prompt_at, consumed_tokens = excluded.consumed_tokens,
          notified = excluded.notified
      `)
      .run(...this.values(job));
  }

  get(id: string): Job | undefined {
    return this.row(this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(id.toLowerCase()));
  }

  runningForProject(directory: string): Job | undefined {
    return this.row(this.database
      .prepare("SELECT * FROM jobs WHERE project_directory = ? AND state = 'running' AND session_id IS NOT NULL ORDER BY created_at LIMIT 1")
      .get(directory));
  }

  runningByMessage(channelId: string, messageId: string): Job | undefined {
    return this.row(this.database
      .prepare("SELECT * FROM jobs WHERE channel_id = ? AND message_id = ? AND state = 'running' AND session_id IS NOT NULL")
      .get(channelId, messageId));
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

  jobHistoryVisible(): boolean {
    const setting = this.database.prepare("SELECT value FROM settings WHERE key = 'job_history_visible'").get() as
      | { value: string }
      | undefined;
    return setting?.value !== "false";
  }

  setJobHistoryVisible(visible: boolean): void {
    this.database.prepare(`
      INSERT INTO settings (key, value) VALUES ('job_history_visible', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(visible));
  }

  resume(): void {
    this.database.prepare("UPDATE jobs SET started_at = ? WHERE state IN ('running', 'conflicted')").run(Date.now());
  }

  ready(): Job[] {
    const active = this.active();
    const firstGlobalJob = active.find((job) => job.scope === "global");
    const legacyProjects = new Set(active
      .filter((job) => job.scope === "project" && job.state !== "queued" && !job.worktreeDirectory)
      .map((job) => job.project.directory));
    return active.filter((job) => job.state === "queued"
      && (job.scope === "global" ? job.id === firstGlobalJob?.id : !legacyProjects.has(job.project.directory)));
  }

  canIntegrate(job: Job): boolean {
    const earlier = this.database.prepare(`
      SELECT COUNT(*) AS count FROM jobs
      WHERE project_directory = ? AND project_sequence < ?
        AND state NOT IN ('completed', 'failed', 'cancelled')
    `).get(job.project.directory, job.projectSequence) as { count: number };
    return Number(earlier.count) === 0;
  }

  cancel(id: string): Job | undefined {
    const job = this.get(id);
    if (!job || terminalStates.has(job.state) || job.integrationHead) return undefined;
    if (job.state === "queued" && !job.worktreeDirectory) {
      job.state = "cancelled";
      job.finishedAt = Date.now();
      job.consumedTokens = 0;
    } else {
      job.state = "cancelling";
    }
    this.save(job);
    return job;
  }

  enqueueInstruction(jobId: string, content: string, attachments: OpenCodeAttachment[] = []): JobInstruction {
    const createdAt = Date.now();
    const sequence = Number((this.database
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM job_instructions WHERE job_id = ?")
      .get(jobId) as { sequence: number }).sequence);
    const result = this.database
      .prepare("INSERT INTO job_instructions (job_id, content, attachments, created_at, sequence) VALUES (?, ?, ?, ?, ?)")
      .run(jobId, content, JSON.stringify(attachments), createdAt, sequence);
    return { id: Number(result.lastInsertRowid), jobId, content, attachments, createdAt, sequence };
  }

  pendingInstructions(jobId: string): JobInstruction[] {
    return this.database
      .prepare("SELECT * FROM job_instructions WHERE job_id = ? AND sent_at IS NULL ORDER BY sequence, id")
      .all(jobId)
      .map((value) => this.instruction(value));
  }

  markInstructionSent(id: number): void {
    this.database.prepare("UPDATE job_instructions SET sent_at = ? WHERE id = ?").run(Date.now(), id);
  }

  activeInstruction(jobId: string): JobInstruction | undefined {
    const value = this.database
      .prepare("SELECT * FROM job_instructions WHERE job_id = ? AND sent_at IS NOT NULL AND completed_at IS NULL ORDER BY sent_at DESC, id DESC LIMIT 1")
      .get(jobId);
    return value ? this.instruction(value) : undefined;
  }

  markInstructionCompleted(id: number): void {
    this.database.prepare("UPDATE job_instructions SET completed_at = ? WHERE id = ?").run(Date.now(), id);
  }

  clearInterruptAction(jobId: string): void {
    this.database.prepare("UPDATE jobs SET interrupt_action = NULL WHERE id = ?").run(jobId);
  }

  createInstructionChoice(
    jobId: string,
    content: string,
    requestedBy: string,
    attachments: OpenCodeAttachment[] = [],
  ): InstructionChoice {
    const choice = { id: randomUUID().slice(0, 8), jobId, content, attachments, requestedBy, createdAt: Date.now() };
    this.database
      .prepare("INSERT INTO instruction_choices (id, job_id, content, attachments, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(choice.id, choice.jobId, choice.content, JSON.stringify(choice.attachments), choice.requestedBy, choice.createdAt);
    return choice;
  }

  getInstructionChoice(id: string): InstructionChoice | undefined {
    const value = this.database.prepare("SELECT * FROM instruction_choices WHERE id = ?").get(id);
    return value ? this.choice(value) : undefined;
  }

  resolveInstructionChoice(
    choiceId: string,
    action: InstructionAction,
    requestedBy: string,
  ): { choice: InstructionChoice; instruction: JobInstruction; job: Job } | undefined {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = this.database.prepare("SELECT * FROM instruction_choices WHERE id = ?").get(choiceId);
      const choice = value ? this.choice(value) : undefined;
      if (!choice || choice.requestedBy !== requestedBy || choice.resolvedAction) {
        this.database.exec("ROLLBACK");
        return undefined;
      }
      const job = this.get(choice.jobId);
      if (!job || job.state !== "running" || !job.sessionId || (job.interruptAction && action !== "queue")) {
        this.database.exec("ROLLBACK");
        return undefined;
      }

      if (action === "replace") {
        this.database.prepare("DELETE FROM job_instructions WHERE job_id = ? AND sent_at IS NULL").run(job.id);
      }
      if (action !== "queue") {
        this.database
          .prepare("UPDATE job_instructions SET completed_at = ? WHERE job_id = ? AND sent_at IS NOT NULL AND completed_at IS NULL")
          .run(Date.now(), job.id);
      }
      const sequenceRow = this.database
        .prepare(action === "queue"
          ? "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM job_instructions WHERE job_id = ?"
          : "SELECT COALESCE(MIN(sequence), 1) - 1 AS sequence FROM job_instructions WHERE job_id = ?")
        .get(job.id) as { sequence: number };
      const createdAt = Date.now();
      const inserted = this.database
        .prepare("INSERT INTO job_instructions (job_id, content, attachments, created_at, sequence) VALUES (?, ?, ?, ?, ?)")
        .run(job.id, choice.content, JSON.stringify(choice.attachments), createdAt, Number(sequenceRow.sequence));
      this.database.prepare("UPDATE instruction_choices SET resolved_action = ? WHERE id = ?").run(action, choice.id);
      if (action !== "queue") {
        this.database.prepare("UPDATE jobs SET interrupt_action = ?, progress = ? WHERE id = ?")
          .run(action, `${action === "replace" ? "Replacing" : "Steering"} the active OpenCode prompt.`, job.id);
      }
      this.database.exec("COMMIT");
      const instruction: JobInstruction = {
        id: Number(inserted.lastInsertRowid),
        jobId: job.id,
        content: choice.content,
        attachments: choice.attachments,
        createdAt,
        sequence: Number(sequenceRow.sequence),
      };
      return { choice: { ...choice, resolvedAction: action }, instruction, job: this.get(job.id)! };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  beginIntegrationIfIdle(jobId: string, result: string): Job | undefined {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const job = this.get(jobId);
      const pending = Number((this.database
        .prepare("SELECT COUNT(*) AS count FROM job_instructions WHERE job_id = ? AND completed_at IS NULL")
        .get(jobId) as { count: number }).count);
      if (!job || job.state !== "running" || job.interruptAction || pending) {
        this.database.exec("ROLLBACK");
        return undefined;
      }
      this.database.prepare(`
        UPDATE jobs SET state = 'integrating', result = ?, progress = 'Waiting for rebase-only integration.' WHERE id = ?
      `).run(result, jobId);
      this.database.exec("COMMIT");
      return this.get(jobId);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  private values(job: Job): SQLInputValue[] {
    return [
      job.id,
      job.scope,
      job.project.alias,
      job.project.directory,
      job.task,
      JSON.stringify(job.attachments),
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
      job.worktreeDirectory ?? null,
      job.worktreeBranch ?? null,
      job.targetBranch ?? null,
      job.projectSequence,
      job.integrationBase ?? null,
      job.integrationHead ?? null,
      job.interruptAction ?? null,
      job.promptAttempts,
      job.lastPromptAt ?? null,
      job.consumedTokens ?? null,
      job.notified ? 1 : 0,
    ];
  }

  private row(value: unknown): Job | undefined {
    if (!value) return undefined;
    const row = value as Record<string, string | number | null>;
    return {
      id: String(row.id),
      scope: String(row.scope) as JobScope,
      project: { alias: String(row.project_alias), directory: String(row.project_directory) },
      task: String(row.task),
      attachments: this.parseAttachments(row.attachments),
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
      ...(row.worktree_directory ? { worktreeDirectory: String(row.worktree_directory) } : {}),
      ...(row.worktree_branch ? { worktreeBranch: String(row.worktree_branch) } : {}),
      ...(row.target_branch ? { targetBranch: String(row.target_branch) } : {}),
      projectSequence: Number(row.project_sequence),
      ...(row.integration_base ? { integrationBase: String(row.integration_base) } : {}),
      ...(row.integration_head ? { integrationHead: String(row.integration_head) } : {}),
      ...(row.interrupt_action ? { interruptAction: String(row.interrupt_action) as "replace" | "steer" } : {}),
      promptAttempts: Number(row.prompt_attempts),
      ...(row.last_prompt_at ? { lastPromptAt: Number(row.last_prompt_at) } : {}),
      ...(row.consumed_tokens !== null ? { consumedTokens: Number(row.consumed_tokens) } : {}),
      notified: Boolean(row.notified),
    };
  }

  private instruction(value: unknown): JobInstruction {
    const row = value as Record<string, string | number | null>;
    return {
      id: Number(row.id),
      jobId: String(row.job_id),
      content: String(row.content),
      attachments: this.parseAttachments(row.attachments),
      createdAt: Number(row.created_at),
      sequence: Number(row.sequence),
      ...(row.sent_at ? { sentAt: Number(row.sent_at) } : {}),
      ...(row.completed_at ? { completedAt: Number(row.completed_at) } : {}),
    };
  }

  private choice(value: unknown): InstructionChoice {
    const row = value as Record<string, string | number | null>;
    return {
      id: String(row.id),
      jobId: String(row.job_id),
      content: String(row.content),
      attachments: this.parseAttachments(row.attachments),
      requestedBy: String(row.requested_by),
      createdAt: Number(row.created_at),
      ...(row.resolved_action ? { resolvedAction: String(row.resolved_action) as InstructionAction } : {}),
    };
  }

  private parseAttachments(value: string | number | null | undefined): OpenCodeAttachment[] {
    if (typeof value !== "string") return [];
    return JSON.parse(value) as OpenCodeAttachment[];
  }
}
