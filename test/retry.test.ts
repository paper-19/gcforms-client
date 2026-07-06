import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "../src/retry.js";
import { mockFetch } from "./helpers.js";

const URL = "https://api.example.com/resource";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fetchWithRetry", () => {
  it("retries retryable statuses with exponential backoff and succeeds", async () => {
    // Pin jitter to its maximum so delays are exactly base * 2^attempt.
    vi.spyOn(Math, "random").mockReturnValue(1);
    const fetchMock = mockFetch()
      .mockResolvedValueOnce(new Response("err", { status: 500 }))
      .mockResolvedValueOnce(new Response("err", { status: 502 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const promise = fetchWithRetry(URL, () => ({}), 10_000);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(249);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await expect(promise).resolves.toMatchObject({ status: 200 });
  });

  it("returns the last response when attempts are exhausted", async () => {
    const fetchMock = mockFetch().mockImplementation(() =>
      Promise.resolve(new Response("err", { status: 503 })),
    );

    const promise = fetchWithRetry(URL, () => ({}), 10_000);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("honours Retry-After in seconds", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const fetchMock = mockFetch()
      .mockResolvedValueOnce(
        new Response("busy", { status: 429, headers: { "retry-after": "2" } }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const promise = fetchWithRetry(URL, () => ({}), 10_000);

    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(promise).resolves.toMatchObject({ status: 200 });
  });

  it("falls back to exponential backoff for an empty Retry-After header", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const fetchMock = mockFetch()
      .mockResolvedValueOnce(
        new Response("busy", { status: 429, headers: { "retry-after": "" } }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const promise = fetchWithRetry(URL, () => ({}), 10_000);

    await vi.advanceTimersByTimeAsync(249);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(promise).resolves.toMatchObject({ status: 200 });
  });

  it("caps Retry-After at 30 seconds", async () => {
    const fetchMock = mockFetch()
      .mockResolvedValueOnce(
        new Response("busy", { status: 429, headers: { "retry-after": "120" } }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const promise = fetchWithRetry(URL, () => ({}), 10_000);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(promise).resolves.toMatchObject({ status: 200 });
  });

  it("does not retry non-retryable statuses", async () => {
    const fetchMock = mockFetch().mockResolvedValue(
      new Response("bad request", { status: 400 }),
    );

    const response = await fetchWithRetry(URL, () => ({}), 10_000);

    expect(response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry when maxAttempts is 1", async () => {
    const fetchMock = mockFetch().mockResolvedValue(
      new Response("err", { status: 500 }),
    );

    const response = await fetchWithRetry(
      URL,
      () => ({}),
      10_000,
      { maxAttempts: 1 },
    );

    expect(response.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats explicitly-undefined options as defaults instead of looping forever", async () => {
    const fetchMock = mockFetch().mockImplementation(() =>
      Promise.resolve(new Response("err", { status: 503 })),
    );

    const promise = fetchWithRetry(URL, () => ({}), 10_000, {
      maxAttempts: undefined,
      baseDelayMs: undefined,
      maxDelayMs: undefined,
      retryStatuses: undefined,
    });
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries network errors and throws the last one on exhaustion", async () => {
    const fetchMock = mockFetch().mockRejectedValue(new TypeError("boom"));

    const promise = fetchWithRetry(URL, () => ({}), 10_000);
    const assertion = expect(promise).rejects.toThrow("boom");
    await vi.runAllTimersAsync();

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries when the body consumer fails mid-read", async () => {
    const fetchMock = mockFetch().mockImplementation(() =>
      Promise.resolve(new Response("payload", { status: 200 })),
    );
    let calls = 0;
    const consumeBody = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new DOMException("aborted due to timeout", "TimeoutError");
      }
    });

    const promise = fetchWithRetry(URL, () => ({}), 10_000, {}, consumeBody);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(consumeBody).toHaveBeenCalledTimes(2);
  });

  it("throws the body consumer's error when attempts are exhausted", async () => {
    mockFetch().mockImplementation(() =>
      Promise.resolve(new Response("payload", { status: 200 })),
    );
    const consumeBody = vi.fn(async () => {
      throw new DOMException("aborted due to timeout", "TimeoutError");
    });

    const promise = fetchWithRetry(URL, () => ({}), 10_000, {}, consumeBody);
    const assertion = expect(promise).rejects.toThrow("aborted due to timeout");
    await vi.runAllTimersAsync();

    await assertion;
    expect(consumeBody).toHaveBeenCalledTimes(3);
  });

  it("does not run the body consumer for non-ok responses", async () => {
    mockFetch().mockResolvedValue(new Response("bad request", { status: 400 }));
    const consumeBody = vi.fn(async () => {});

    const response = await fetchWithRetry(URL, () => ({}), 10_000, {}, consumeBody);

    expect(response.status).toBe(400);
    expect(consumeBody).not.toHaveBeenCalled();
  });

  it("rebuilds the request init on every attempt", async () => {
    mockFetch()
      .mockResolvedValueOnce(new Response("err", { status: 500 }))
      .mockResolvedValueOnce(new Response("err", { status: 500 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const makeInit = vi.fn(() => ({}));

    const promise = fetchWithRetry(URL, makeInit, 10_000);
    await vi.runAllTimersAsync();
    await promise;

    expect(makeInit).toHaveBeenCalledTimes(3);
  });
});
