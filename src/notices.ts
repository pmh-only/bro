import type { MessageCreateOptions } from "discord.js";
import type { Job } from "./jobs.js";
import { redactSensitiveText } from "./safety.js";

export function terminalJobNotice(job: Job): string | undefined {
  if (job.state !== "completed" && job.state !== "failed") return undefined;
  const alias = job.project.alias.replace(/`/g, "'").replace(/[\r\n]+/g, " ");
  const outcome = job.state === "completed" ? "completed successfully" : "failed";
  return `Job \`${job.id}\` on **${alias}** ${outcome}. See the updated status message for details.`;
}

export function terminalJobNotification(job: Job): MessageCreateOptions | undefined {
  const notice = terminalJobNotice(job);
  if (!notice) return undefined;
  return {
    content: `<@${job.requestedBy}> ${notice}`,
    allowedMentions: { parse: [], users: [job.requestedBy], repliedUser: false },
    reply: { messageReference: job.messageId, failIfNotExists: false },
  };
}

export function operationalDetailsNotification(job: Job): MessageCreateOptions | undefined {
  if (job.state !== "completed" || !job.operationalDetails) return undefined;
  return {
    content: `<@${job.requestedBy}> **Operational details for job \`${job.id}\`**\n${redactSensitiveText(job.operationalDetails, job.task)}`,
    allowedMentions: { parse: [], users: [job.requestedBy], repliedUser: false },
    reply: { messageReference: job.messageId, failIfNotExists: false },
  };
}

export function hasPendingJobNotification(job: Job): boolean {
  const terminalNotice = (job.state === "completed" || job.state === "failed") && !job.notified;
  const operationalNotice = job.state === "completed" && Boolean(job.operationalDetails) && !job.operationalDetailsNotified;
  return terminalNotice || operationalNotice;
}
