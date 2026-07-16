import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  TextDisplayBuilder,
} from "discord.js";
import type { Job } from "./jobs.js";

interface CardOptions {
  accentColor?: number;
  buttons?: ButtonBuilder[];
}

const colors = {
  neutral: 0x5865f2,
  queued: 0xfee75c,
  running: 0x5865f2,
  cancelling: 0xfee75c,
  completed: 0x57f287,
  failed: 0xed4245,
  cancelled: 0x747f8d,
} as const;

export function cardComponents(title: string, body: string, options: CardOptions = {}): ContainerBuilder[] {
  const container = new ContainerBuilder()
    .setAccentColor(options.accentColor ?? colors.neutral)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${title}\n${body}`));

  if (options.buttons?.length) {
    container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(options.buttons));
  }
  return [container];
}

export function jobComponents(job: Job, body: string): ContainerBuilder[] {
  const buttons: ButtonBuilder[] = [];
  if (job.sessionUrl) {
    buttons.push(new ButtonBuilder().setLabel("Open in OpenCode").setStyle(ButtonStyle.Link).setURL(job.sessionUrl));
  }
  if (job.state === "queued" || job.state === "running" || job.state === "cancelling") {
    buttons.push(
      new ButtonBuilder().setCustomId(`job:refresh:${job.id}`).setLabel("Refresh").setStyle(ButtonStyle.Secondary),
    );
  }
  if (job.state === "queued" || job.state === "running") {
    buttons.push(
      new ButtonBuilder().setCustomId(`job:cancel:${job.id}`).setLabel("Cancel job").setStyle(ButtonStyle.Danger),
    );
  }

  const title = `${job.state[0]?.toUpperCase()}${job.state.slice(1)} job`;
  return cardComponents(title, body, { accentColor: colors[job.state], buttons });
}

export function parseJobButton(customId: string): { action: "refresh" | "cancel"; jobId: string } | undefined {
  const match = /^job:(refresh|cancel):([a-f0-9]{8})$/.exec(customId);
  if (!match) return undefined;
  return { action: match[1] as "refresh" | "cancel", jobId: match[2]! };
}
