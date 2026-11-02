import { config } from './config.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(public status: number, public url: string) {
    super(`HTTP ${status} from ${url}`);
  }
}

/** Fetch with timeout, and backoff on network errors, 429 and 5xx. Other statuses return as-is. */
export async function fetchRetry(url: string, init: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= config.httpRetries; attempt++) {
    if (attempt > 0) await sleep(config.httpBackoffMs * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new HttpError(res.status, url);
        await res.body?.cancel();
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
