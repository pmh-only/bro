import { createServer, type Server } from "node:http";
import type { Job, JobStore } from "./jobs.js";

interface ThreadJob {
  id: string;
  state: Job["state"];
  request: string;
  response: string;
  createdAt: number;
  finishedAt?: number;
  sessionUrl?: string;
}

interface ProjectThread {
  project: string;
  jobs: ThreadJob[];
}

function response(job: Job): string {
  if (job.result) return job.result;
  if (job.state === "failed" && job.error) return job.error;
  if (job.progress) return job.progress;
  if (job.error) return job.error;
  return job.state === "queued" ? "Waiting for the project queue." : "No response yet.";
}

export function projectThreads(store: JobStore): ProjectThread[] {
  const projects = new Map<string, ThreadJob[]>();
  for (const job of store.history()) {
    const jobs = projects.get(job.project.alias) ?? [];
    jobs.push({
      id: job.id,
      state: job.state,
      request: job.task,
      response: response(job),
      createdAt: job.createdAt,
      ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
      ...(job.sessionUrl ? { sessionUrl: job.sessionUrl } : {}),
    });
    projects.set(job.project.alias, jobs);
  }
  return [...projects.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([project, jobs]) => ({ project, jobs }));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function page(threads: ProjectThread[]): string {
  const projects = threads.length
    ? threads.map((thread) => `
      <section>
        <h2>${escapeHtml(thread.project)}</h2>
        <div class="thread">${thread.jobs.map((job) => `
          <article>
            <header><code>${job.id}</code><span class="state ${job.state}">${job.state}</span><time>${new Date(job.createdAt).toISOString()}</time></header>
            <div class="message request"><strong>Request</strong><pre>${escapeHtml(job.request)}</pre></div>
            <div class="message response"><strong>Response</strong><pre>${escapeHtml(job.response)}</pre></div>
            ${job.sessionUrl ? `<a href="${escapeHtml(job.sessionUrl)}" target="_blank" rel="noreferrer">Open in OpenCode</a>` : ""}
          </article>`).join("")}
        </div>
      </section>`).join("")
    : '<p class="empty">No jobs have been recorded yet.</p>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15"><title>Bro project threads</title>
<style>
:root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#0b0d10;color:#e8edf2}*{box-sizing:border-box}body{margin:0}main{width:min(1100px,calc(100% - 32px));margin:48px auto 80px}h1{font:700 clamp(28px,5vw,52px)/1 sans-serif;margin:0 0 12px}p.lede{color:#8f9aa6;margin:0 0 48px}section{margin:0 0 56px}h2{font-size:18px;color:#8ce99a;border-bottom:1px solid #29313a;padding-bottom:12px}.thread{display:grid;gap:18px}article{background:#12161b;border:1px solid #29313a;border-left:4px solid #5c7cfa;padding:18px;box-shadow:0 12px 30px #0005}header{display:flex;gap:12px;align-items:center;color:#8f9aa6;font-size:12px}header time{margin-left:auto}.state{padding:3px 7px;border:1px solid currentColor;text-transform:uppercase}.completed{color:#8ce99a}.failed,.cancelled{color:#ff8787}.running{color:#91a7ff}.queued,.cancelling{color:#ffd43b}.message{margin-top:16px}.message strong{display:block;color:#8f9aa6;font-size:11px;text-transform:uppercase;letter-spacing:.12em}.message pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 0;font:14px/1.55 inherit}.response{border-top:1px dashed #29313a;padding-top:16px}a{display:inline-block;margin-top:16px;color:#91a7ff}.empty{padding:30px;border:1px dashed #3b4652;color:#8f9aa6}@media(max-width:600px){main{margin-top:28px}header{flex-wrap:wrap}header time{width:100%;margin:0}}
</style></head><body><main><h1>Project threads</h1><p class="lede">Persisted Discord requests and OpenCode responses. Refreshes every 15 seconds.</p>${projects}</main></body></html>`;
}

export async function startThreadServer(
  store: JobStore,
  port: number,
  hostname = "0.0.0.0",
): Promise<Server> {
  const server = createServer((request, response_) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    response_.setHeader("Cache-Control", "no-store");
    response_.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method === "GET" && path === "/healthz") {
      response_.setHeader("Content-Type", "text/plain; charset=utf-8");
      response_.end("ok\n");
      return;
    }
    if (request.method === "GET" && path === "/api/projects") {
      response_.setHeader("Content-Type", "application/json; charset=utf-8");
      response_.end(JSON.stringify(projectThreads(store)));
      return;
    }
    if (request.method === "GET" && path === "/") {
      response_.setHeader("Content-Type", "text/html; charset=utf-8");
      response_.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
      response_.end(page(projectThreads(store)));
      return;
    }
    response_.statusCode = 404;
    response_.setHeader("Content-Type", "text/plain; charset=utf-8");
    response_.end("not found\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

export async function closeThreadServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
