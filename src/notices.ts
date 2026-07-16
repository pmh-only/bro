import type { Job } from "./jobs.js";

export function terminalJobNotice(job: Job): string | undefined {
  if (job.state !== "completed" && job.state !== "failed") return undefined;
  const alias = job.project.alias.replace(/`/g, "'").replace(/[\r\n]+/g, " ");
  const outcome = job.state === "completed" ? "completed successfully" : "failed";
  return `Job \`${job.id}\` on **${alias}** ${outcome}. See the updated status message for details.`;
}
