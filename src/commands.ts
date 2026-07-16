export function hasBotMention(content: string, botId: string): boolean {
  return content.includes(`<@${botId}>`) || content.includes(`<@!${botId}>`);
}

export function stripBotMention(content: string, botId: string): string {
  return content.replaceAll(`<@${botId}>`, " ").replaceAll(`<@!${botId}>`, " ").trim();
}
