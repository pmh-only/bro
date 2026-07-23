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
  return job.state === "queued"
    ? `Waiting for the ${job.scope === "global" ? "global" : "project"} queue.`
    : "No response yet.";
}

export function projectThreads(store: JobStore): ProjectThread[] {
  const projects = new Map<string, ThreadJob[]>();
  const jobs = store.jobHistoryVisible()
    ? store.history()
    : store.history().filter((job) => job.state !== "completed" && job.state !== "failed" && job.state !== "cancelled");
  for (const job of jobs) {
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
    .map(([project, jobs]) => ({
      project,
      jobs: jobs.sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id)),
    }))
    .sort((left, right) =>
      (right.jobs[0]?.createdAt ?? 0) - (left.jobs[0]?.createdAt ?? 0) || left.project.localeCompare(right.project));
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

function page(threads: ProjectThread[], selectedProject: string | null, historyVisible: boolean): string {
  const selected = threads.find((thread) => thread.project === selectedProject) ?? threads[0];
  const jobs = threads.flatMap((thread) => thread.jobs);
  const activeJobs = jobs.filter((job) =>
    job.state === "queued" || job.state === "running" || job.state === "integrating"
    || job.state === "conflicted" || job.state === "cancelling").length;
  const navigation = threads.length
    ? `<nav aria-label="Projects"><p>Projects</p>${threads.map((thread) => {
        const active = thread === selected;
        const latestState = thread.jobs[0]?.state ?? "completed";
        return `<a href="/?project=${encodeURIComponent(thread.project)}"${active ? ' class="active" aria-current="page"' : ""}><i class="project-state ${latestState}" aria-hidden="true"></i><span>${escapeHtml(thread.project)}</span><small>${thread.jobs.length}</small></a>`;
      }).join("")}</nav>`
    : '<nav aria-label="Projects"><p>Projects</p><span class="no-projects">No projects</span></nav>';
  const project = selected
    ? `<section>
        <div class="project-heading"><div><span class="section-label">Selected project</span><h2>${escapeHtml(selected.project)}</h2></div><p>${selected.jobs.length} job${selected.jobs.length === 1 ? "" : "s"}</p></div>
        <div class="thread">${selected.jobs.map((job, index) => `
          <article class="job ${job.state}">
            <header><code>#${job.id}</code><span class="state ${job.state}">${job.state}</span>${index === 0 ? '<span class="latest">Latest</span>' : ""}<time datetime="${new Date(job.createdAt).toISOString()}">${new Date(job.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })} UTC</time></header>
            <div class="message request"><strong>Request</strong><pre>${escapeHtml(job.request)}</pre></div>
            <div class="message response"><strong>Response</strong><pre>${escapeHtml(job.response)}</pre></div>
            ${job.sessionUrl ? `<a class="session-link" href="${escapeHtml(job.sessionUrl)}" target="_blank" rel="noreferrer">Open in OpenCode</a>` : ""}
          </article>`).join("")}
        </div>
      </section>`
    : `<p class="empty">${historyVisible ? "No jobs have been recorded yet." : "Job history is hidden and there are no active jobs."}</p>`;
  const historyNotice = historyVisible
    ? ""
    : '<p class="history-notice" role="status">Job history is hidden. Only active jobs are shown.</p>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15"><title>Bro project threads</title>
<style>
:root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#090c0f;color:#e8edf2;--line:#28313a;--muted:#82909d;--green:#74e39a;--blue:#7795ff;--yellow:#f4cf65;--red:#ff767f}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 75% -10%,#17253a 0,transparent 34rem),linear-gradient(#090c0f,#0c1014)}body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.16;background-image:linear-gradient(#62708020 1px,transparent 1px),linear-gradient(90deg,#62708020 1px,transparent 1px);background-size:32px 32px}main{position:relative;width:min(1320px,calc(100% - 40px));margin:52px auto 80px}.eyebrow,.section-label{color:var(--green);font-size:11px;font-weight:700;letter-spacing:.17em;text-transform:uppercase}h1{font:750 clamp(34px,6vw,64px)/.95 system-ui,sans-serif;letter-spacing:-.045em;margin:10px 0 14px}.lede{color:var(--muted);margin:0}.dashboard-header{display:flex;align-items:end;justify-content:space-between;gap:28px;margin-bottom:42px}.summary{display:flex;border:1px solid var(--line);background:#0c1117cc;box-shadow:0 16px 48px #0005}.summary div{min-width:92px;padding:13px 16px;border-left:1px solid var(--line)}.summary div:first-child{border:0}.summary strong{display:block;color:#f6f8fa;font:700 20px/1 system-ui,sans-serif}.summary span{display:block;color:#697785;font-size:9px;letter-spacing:.13em;text-transform:uppercase;margin-top:7px}.layout{display:grid;grid-template-columns:240px minmax(0,1fr);gap:28px;align-items:start}nav{position:sticky;top:24px;border:1px solid var(--line);background:#0d1218e8;padding:10px;backdrop-filter:blur(12px);box-shadow:0 18px 50px #0004}nav p{margin:4px 9px 10px;color:#697785;font-size:10px;letter-spacing:.16em;text-transform:uppercase}nav a{display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:center;gap:10px;color:#acb6c0;text-decoration:none;padding:12px 10px;border-left:2px solid transparent;transition:background .15s,color .15s}nav a:hover{background:#171e26;color:#fff}nav a.active{background:#172019;border-left-color:var(--green);color:var(--green)}nav a span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}nav small{color:#64717d}.project-state{width:7px;height:7px;border-radius:50%;background:#697785}.project-state.completed{background:var(--green)}.project-state.failed,.project-state.cancelled,.project-state.conflicted{background:var(--red)}.project-state.running,.project-state.integrating{background:var(--blue);box-shadow:0 0 12px var(--blue)}.project-state.queued,.project-state.cancelling{background:var(--yellow)}.no-projects{display:block;padding:10px;color:#697785}section{min-width:0;margin-bottom:56px}.project-heading{display:flex;align-items:end;justify-content:space-between;border-bottom:1px solid var(--line);padding:2px 2px 15px;margin-bottom:18px}.project-heading h2{font:700 25px/1 system-ui,sans-serif;letter-spacing:-.025em;margin:7px 0 0}.project-heading p{color:#697785;font-size:11px;margin:0}.thread{display:grid;gap:16px}.job{position:relative;background:linear-gradient(125deg,#121820,#0f141a);border:1px solid var(--line);border-left:3px solid var(--blue);padding:20px;box-shadow:0 14px 35px #0004}.job.completed{border-left-color:var(--green)}.job.failed,.job.cancelled,.job.conflicted{border-left-color:var(--red)}.job.queued,.job.cancelling{border-left-color:var(--yellow)}header{display:flex;gap:10px;align-items:center;color:var(--muted);font-size:11px}header code{color:#b8c3ce}.state,.latest{padding:3px 7px;border:1px solid currentColor;text-transform:uppercase;font-size:9px;letter-spacing:.08em}.state.completed{color:var(--green)}.state.failed,.state.cancelled,.state.conflicted{color:var(--red)}.state.running,.state.integrating{color:var(--blue)}.state.queued,.state.cancelling{color:var(--yellow)}.latest{color:#8d99a5;border-color:#3a4550}header time{margin-left:auto;color:#697785}.message{margin-top:18px}.message strong{display:block;color:#768492;font-size:10px;text-transform:uppercase;letter-spacing:.14em}.message pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:7px 0 0;font:14px/1.6 inherit;color:#dce2e8}.response{border-top:1px dashed #303945;padding-top:17px}.session-link{display:inline-block;margin-top:18px;border:1px solid #405790;color:#a9bbff;text-decoration:none;padding:8px 11px;font-size:11px}.session-link:hover{background:#17213a;color:#fff}.empty{padding:32px;border:1px dashed #3b4652;color:var(--muted);background:#0d1218}@media(max-width:760px){main{width:min(100% - 24px,680px);margin-top:28px}.dashboard-header{display:block;margin-bottom:26px}.summary{margin-top:24px;width:100%}.summary div{flex:1;min-width:0}.layout{display:block}nav{position:static;display:flex;overflow-x:auto;margin-bottom:24px}nav p{display:none}nav a{flex:0 0 auto;grid-template-columns:8px auto auto;border-left:0;border-bottom:2px solid transparent}nav a.active{border-left:0;border-bottom-color:var(--green)}.job{padding:16px}header{flex-wrap:wrap}header time{width:100%;margin:2px 0 0}.project-heading{align-items:center}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body><main><div class="dashboard-header"><div><span class="eyebrow">Bro / Activity log</span><h1>Project threads</h1><p class="lede">Discord requests and OpenCode responses, refreshed every 15 seconds.</p></div><div class="summary" aria-label="Job summary"><div><strong>${threads.length}</strong><span>Projects</span></div><div><strong>${activeJobs}</strong><span>Active</span></div><div><strong>${jobs.length}</strong><span>Visible jobs</span></div></div></div>${historyNotice}<div class="layout">${navigation}<div>${project}</div></div></main></body></html>`;
}

export async function startThreadServer(
  store: JobStore,
  port: number,
  hostname = "0.0.0.0",
): Promise<Server> {
  const server = createServer((request, response_) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
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
      const historyVisible = store.jobHistoryVisible();
      response_.setHeader("Content-Type", "text/html; charset=utf-8");
      response_.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
      response_.end(page(projectThreads(store), url.searchParams.get("project"), historyVisible));
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
