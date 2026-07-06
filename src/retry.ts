export type RetryOptions = {
  /** Total number of attempts, including the first. Set to 1 to disable retries. */
  maxAttempts?: number;
  /** Base for the exponential backoff between attempts. */
  baseDelayMs?: number;
  /** Upper bound on the backoff between attempts. */
  maxDelayMs?: number;
  /** HTTP status codes that trigger a retry. */
  retryStatuses?: number[];
};

/** Never wait longer than this between attempts, even if Retry-After asks for more. */
const RETRY_AFTER_CAP_MS = 30_000;

/**
 * fetch with a per-attempt timeout and exponential backoff (full jitter) on
 * retryable statuses and network errors. `makeInit` is called once per
 * attempt so time-sensitive request material (e.g. a signed JWT assertion)
 * is rebuilt fresh. Returns the last response, retryable or not; throws only
 * when the final attempt fails at the network level.
 *
 * `consumeBody`, when given, runs for each ok response inside the attempt,
 * so the per-attempt timeout and retry policy cover the body download too —
 * a body read aborted by the timeout retries like any network error.
 */
export async function fetchWithRetry(
  url: string,
  makeInit: () => RequestInit,
  timeoutMs: number,
  {
    maxAttempts = 3,
    baseDelayMs = 250,
    maxDelayMs = 8_000,
    retryStatuses = [429, 500, 502, 503, 504],
  }: RetryOptions = {},
  consumeBody?: (response: Response) => Promise<void>,
): Promise<Response> {
  const backoffDelayMs = (attempt: number) =>
    Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);

  for (let attempt = 0; ; attempt++) {
    const isLastAttempt = attempt >= maxAttempts - 1;

    let response: Response;
    try {
      response = await fetch(url, {
        ...makeInit(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok && consumeBody) {
        await consumeBody(response);
      }
    } catch (error) {
      if (isLastAttempt) throw error;
      await sleep(backoffDelayMs(attempt));
      continue;
    }

    if (isLastAttempt || !retryStatuses.includes(response.status)) {
      return response;
    }

    await response.body?.cancel().catch(() => {});
    await sleep(retryAfterMs(response) ?? backoffDelayMs(attempt));
  }
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  // Treat an empty value as absent: Number("") is 0, which would turn a
  // buggy proxy's bare header into zero-delay retries with no backoff.
  if (header === null || header.trim() === "") return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
  }

  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(0, date - Date.now()), RETRY_AFTER_CAP_MS);
  }

  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
