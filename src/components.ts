import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  ModalBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { InstructionAction, Job } from "./jobs.js";

interface CardOptions {
  accentColor?: number;
  buttons?: ButtonBuilder[];
}

const colors = {
  neutral: 0x5865f2,
  queued: 0xfee75c,
  running: 0x5865f2,
  integrating: 0x5865f2,
  conflicted: 0xed4245,
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

export function jobComponents(job: Job, body: string, codeServerPublicUrl: string): ContainerBuilder[] {
  const buttons: ButtonBuilder[] = [];
  if (job.sessionUrl) {
    buttons.push(new ButtonBuilder().setLabel("Open in OpenCode").setStyle(ButtonStyle.Link).setURL(job.sessionUrl));
  }
  if (job.state === "running" || job.state === "conflicted") {
    const codeServerUrl = new URL(codeServerPublicUrl);
    codeServerUrl.searchParams.set("folder", job.worktreeDirectory ?? job.project.directory);
    buttons.push(
      new ButtonBuilder().setLabel("Open in code-server").setStyle(ButtonStyle.Link).setURL(codeServerUrl.toString()),
    );
  }
  if (["queued", "running", "integrating", "conflicted", "cancelling"].includes(job.state)) {
    buttons.push(
      new ButtonBuilder().setCustomId(`job:refresh:${job.id}`).setLabel("Refresh").setStyle(ButtonStyle.Secondary),
    );
  }
  if (["queued", "running", "integrating", "conflicted"].includes(job.state)) {
    if (job.state === "running") {
      buttons.push(
        new ButtonBuilder().setCustomId(`job:prompt:${job.id}`).setLabel("Add instruction").setStyle(ButtonStyle.Primary),
      );
    }
    buttons.push(
      new ButtonBuilder().setCustomId(`job:cancel:${job.id}`).setLabel("Cancel job").setStyle(ButtonStyle.Danger),
    );
  }

  const title = `${job.state[0]?.toUpperCase()}${job.state.slice(1)} job`;
  const terminal = job.state === "completed" || job.state === "failed" || job.state === "cancelled";
  const tokenUsage = terminal
    ? `\n\n**Tokens consumed:** ${job.consumedTokens?.toLocaleString("en-US") ?? "unavailable"}`
    : "";
  return cardComponents(title, `${body}${tokenUsage}`, { accentColor: colors[job.state], buttons });
}

export function jobInstructionModal(jobId: string): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId("instruction")
    .setLabel("Additional instruction")
    .setPlaceholder("Describe what OpenCode should change or do next")
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(1)
    .setMaxLength(2_000)
    .setRequired(true);
  return new ModalBuilder()
    .setCustomId(`job:prompt:${jobId}`)
    .setTitle("Add job instruction")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

export function instructionChoiceComponents(choiceId: string, jobId: string): ContainerBuilder[] {
  return cardComponents(
    "Choose instruction action",
    [
      `Job \`${jobId}\` is running. How should this instruction be applied?`,
      "**Queue** — run after the active and queued instructions finish successfully.",
      "**Replace** — stop the active instruction, discard queued instructions, and run this one.",
      "**Steer** — stop the active instruction, run this one, then continue queued instructions.",
    ].join("\n"),
    {
      buttons: [
        new ButtonBuilder().setCustomId(`instruction:queue:${choiceId}`).setLabel("Queue").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`instruction:replace:${choiceId}`).setLabel("Replace").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`instruction:steer:${choiceId}`).setLabel("Steer").setStyle(ButtonStyle.Primary),
      ],
    },
  );
}

export function parseInstructionChoice(customId: string): { action: InstructionAction; choiceId: string } | undefined {
  const match = /^instruction:(queue|replace|steer):([a-f0-9]{8})$/.exec(customId);
  if (!match) return undefined;
  return { action: match[1] as InstructionAction, choiceId: match[2]! };
}

export function parseJobButton(customId: string): { action: "refresh" | "prompt" | "cancel"; jobId: string } | undefined {
  const match = /^job:(refresh|prompt|cancel):([a-f0-9]{8})$/.exec(customId);
  if (!match) return undefined;
  return { action: match[1] as "refresh" | "prompt" | "cancel", jobId: match[2]! };
}
