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

type AttachmentFetch = (url: string) => Promise<Response>;

function mimeType(value: string | null): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

export async function discordAttachments(
  attachments: Iterable<DiscordAttachment>,
  fetchAttachment: AttachmentFetch = fetch,
): Promise<OpenCodeAttachment[]> {
  return Promise.all([...attachments].map(async (attachment) => {
    const response = await fetchAttachment(attachment.url);
    if (!response.ok) {
      throw new Error(`Unable to download Discord attachment ${attachment.name || "file"}: HTTP ${response.status}`);
    }
    const mime = mimeType(attachment.contentType)
      ?? mimeType(response.headers.get("content-type"))
      ?? "application/octet-stream";
    const data = Buffer.from(await response.arrayBuffer()).toString("base64");
    return {
      mime,
      url: `data:${mime};base64,${data}`,
      ...(attachment.name ? { filename: attachment.name } : {}),
    };
  }));
}
