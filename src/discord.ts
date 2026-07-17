import { setTimeout } from "node:timers/promises";

export const DISCORD_LOGIN_RETRY_INITIAL_MS = 60_000;
export const DISCORD_LOGIN_RETRY_MAX_MS = 5 * 60_000;

interface DiscordLoginClient {
  login(token: string): Promise<string>;
}

interface LoginOptions {
  wait?: (delayMs: number) => Promise<void>;
  onRetry?: (error: unknown, delayMs: number) => void;
}

function isInvalidToken(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "TokenInvalid";
}

export async function loginWithRetry<T extends DiscordLoginClient>(
  createClient: () => T,
  token: string,
  options: LoginOptions = {},
): Promise<T> {
  const wait = options.wait ?? ((delayMs: number) => setTimeout(delayMs));
  let delayMs = DISCORD_LOGIN_RETRY_INITIAL_MS;

  for (;;) {
    const client = createClient();
    try {
      await client.login(token);
      return client;
    } catch (error) {
      if (isInvalidToken(error)) throw error;
      options.onRetry?.(error, delayMs);
      await wait(delayMs);
      delayMs = Math.min(delayMs * 2, DISCORD_LOGIN_RETRY_MAX_MS);
    }
  }
}
