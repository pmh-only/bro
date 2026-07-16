import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import type { Project } from "./projects.js";

export type JobState = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";

export interface Job {
  id: string;
  project: Project;
  task: string;
  requestedBy: string;
  state: JobState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  sessionId?: string;
  result?: string;
  error?: string;
  controller: AbortController;
}

interface EnqueueOptions {
  project: Project;
  task: string;
  requestedBy: string;
  execute: (job: Job) => Promise<string>;
  onChange: (job: Job) => Promise<void>;
}

const terminalStates = new Set<JobState>(["completed", "failed", "cancelled"]);
const retainedJobCount = 100;

export class JobQueue {
  private readonly jobs = new Map<string, Job>();
  private readonly projectTails = new Map<string, Promise<void>>();
  private readonly statusCallbacks = new Map<string, (job: Job) => Promise<void>>();

  enqueue(options: EnqueueOptions): Job {
    const job: Job = {
      id: randomUUID().slice(0, 8),
      project: options.project,
      task: options.task,
      requestedBy: options.requestedBy,
      state: "queued",
      createdAt: Date.now(),
      controller: new AbortController(),
    };
    this.jobs.set(job.id, job);
    this.statusCallbacks.set(job.id, options.onChange);

    const previous = this.projectTails.get(job.project.directory) ?? Promise.resolve();
    const execution = previous
      .catch(() => undefined)
      .then(async () => {
        if (job.state === "cancelled") return;
        job.state = "running";
        job.startedAt = Date.now();
        await this.notify(options.onChange, job);

        try {
          job.result = await options.execute(job);
          job.state = job.controller.signal.aborted ? "cancelled" : "completed";
        } catch (error) {
          if (job.controller.signal.aborted) {
            job.state = "cancelled";
          } else {
            job.state = "failed";
            job.error = error instanceof Error ? error.message : String(error);
          }
        } finally {
          job.finishedAt = Date.now();
          await this.notify(options.onChange, job);
          this.statusCallbacks.delete(job.id);
          this.trimHistory();
        }
      })
      .finally(() => {
        if (this.projectTails.get(job.project.directory) === execution) {
          this.projectTails.delete(job.project.directory);
        }
      });

    this.projectTails.set(job.project.directory, execution);
    return job;
  }

  async cancel(id: string): Promise<Job | undefined> {
    const job = this.jobs.get(id.toLowerCase());
    if (!job || terminalStates.has(job.state)) return undefined;

    if (job.state === "queued") {
      job.state = "cancelled";
      job.finishedAt = Date.now();
    } else {
      job.state = "cancelling";
    }
    job.controller.abort(new Error("Cancelled from Discord"));
    const callback = this.statusCallbacks.get(job.id);
    if (callback) await this.notify(callback, job);
    if (job.state === "cancelled") {
      this.statusCallbacks.delete(job.id);
      this.trimHistory();
    }
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id.toLowerCase());
  }

  active(): Job[] {
    return [...this.jobs.values()]
      .filter((job) => !terminalStates.has(job.state))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async cancelAll(): Promise<void> {
    await Promise.all(this.active().map((job) => this.cancel(job.id)));
  }

  private trimHistory(): void {
    const terminal = [...this.jobs.values()]
      .filter((job) => terminalStates.has(job.state))
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const job of terminal.slice(retainedJobCount)) this.jobs.delete(job.id);
  }

  private async notify(callback: (job: Job) => Promise<void>, job: Job): Promise<void> {
    try {
      await Promise.race([
        callback(job),
        setTimeout(5_000, undefined, { ref: false }).then(() => {
          throw new Error("Discord status update timed out");
        }),
      ]);
    } catch (error) {
      console.error(`Failed to publish status for job ${job.id}`, error);
    }
  }
}
