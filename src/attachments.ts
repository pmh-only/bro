export interface OpenCodeAttachment {
  mime: string;
  url: string;
  filename?: string;
}

interface DiscordAttachment {
  contentType: string | null;
  name: string;
  url: string;
}

export function discordAttachments(attachments: Iterable<DiscordAttachment>): OpenCodeAttachment[] {
  return [...attachments].map((attachment) => ({
    mime: attachment.contentType ?? "application/octet-stream",
    url: attachment.url,
    ...(attachment.name ? { filename: attachment.name } : {}),
  }));
}
