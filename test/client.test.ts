import { afterEach, describe, expect, it, vi } from "vitest";
import { GcFormsClient, DEFAULT_API_URL } from "../src/client.js";
import { GcFormsApiError, GcFormsDecryptionError } from "../src/errors.js";
import type { FormSubmissionProblem } from "../src/types.js";
import {
  buildSubmission,
  encryptSubmission,
  generateTestKeys,
  jsonResponse,
  mockFetch,
  tokenResponse,
  type TestKeys,
} from "./helpers.js";

const NO_RETRY = { maxAttempts: 1 };

function makeClient(keys: TestKeys, config: Partial<ConstructorParameters<typeof GcFormsClient>[0]> = {}) {
  return new GcFormsClient({
    credentials: keys.credentials,
    retry: NO_RETRY,
    ...config,
  });
}

/** Mocks fetch, answering the token endpoint automatically and delegating API calls. */
function routeFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  return mockFetch().mockImplementation(
    async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/oauth/v2/token")) return tokenResponse();
      return handler(target, init);
    },
  );
}

function apiCalls(fetchMock: ReturnType<typeof mockFetch>) {
  return fetchMock.mock.calls.filter(
    ([url]) => !String(url).endsWith("/oauth/v2/token"),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A response body that errors mid-read, as an aborted transfer does. */
function erroringStream(): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.error(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      );
    },
  });
}

describe("GcFormsClient", () => {
  it("rejects an invalid private API key at construction", () => {
    const keys = generateTestKeys();
    expect(() =>
      makeClient({ ...keys, credentials: { ...keys.credentials, formId: "" } }),
    ).toThrow();
  });

  it("exposes the formId from the private API key", () => {
    expect(makeClient(generateTestKeys()).formId).toBe("test-form-id");
  });

  it("getNewSubmissions hits the default API with a bearer token", async () => {
    const keys = generateTestKeys();
    const submissions = [{ name: "01-08-a1b2c", createdAt: 1700000000000 }];
    const fetchMock = routeFetch(() => jsonResponse(submissions));

    const result = await makeClient(keys).getNewSubmissions();

    expect(result).toEqual(submissions);
    const [url, init] = apiCalls(fetchMock)[0]!;
    expect(url).toBe(
      `${DEFAULT_API_URL}/v1/forms/test-form-id/submission/new`,
    );
    expect(init!.method).toBe("GET");
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-access-token",
    );
  });

  it("getFormTemplate returns the parsed template", async () => {
    const keys = generateTestKeys();
    routeFetch(() => jsonResponse({ titleEn: "My form" }));

    await expect(makeClient(keys).getFormTemplate()).resolves.toEqual({
      titleEn: "My form",
    });
  });

  it("URI-encodes submission names", async () => {
    const keys = generateTestKeys();
    const fetchMock = routeFetch(() =>
      jsonResponse(encryptSubmission("{}", keys.publicKey)),
    );

    await makeClient(keys).getEncryptedSubmission("name with/slash");

    expect(String(apiCalls(fetchMock)[0]![0])).toContain(
      "/submission/name%20with%2Fslash",
    );
  });

  it("honours custom apiUrl and apiVersion, tolerating stray slashes", async () => {
    const keys = generateTestKeys();
    const fetchMock = routeFetch(() => jsonResponse([]));

    await makeClient(keys, {
      apiUrl: "https://api.example.com/",
      apiVersion: "/v2/",
    }).getNewSubmissions();

    expect(String(apiCalls(fetchMock)[0]![0])).toBe(
      "https://api.example.com/v2/forms/test-form-id/submission/new",
    );
  });

  it("getSubmission decrypts, parses and integrity-checks a submission", async () => {
    const keys = generateTestKeys();
    const submission = buildSubmission('{"1":"answer"}');
    routeFetch(() =>
      jsonResponse(encryptSubmission(JSON.stringify(submission), keys.publicKey)),
    );

    await expect(makeClient(keys).getSubmission("abc")).resolves.toEqual(
      submission,
    );
  });

  it("getSubmission throws GcFormsDecryptionError on checksum mismatch", async () => {
    const keys = generateTestKeys();
    const submission = { ...buildSubmission('{"1":"answer"}'), checksum: "0".repeat(32) };
    routeFetch(() =>
      jsonResponse(encryptSubmission(JSON.stringify(submission), keys.publicKey)),
    );

    await expect(makeClient(keys).getSubmission("abc")).rejects.toThrow(
      GcFormsDecryptionError,
    );
  });

  it("confirmSubmission PUTs to the confirm endpoint", async () => {
    const keys = generateTestKeys();
    const fetchMock = routeFetch(() => new Response(null, { status: 200 }));

    await makeClient(keys).confirmSubmission("abc", "code/1");

    const [url, init] = apiCalls(fetchMock)[0]!;
    expect(String(url)).toBe(
      `${DEFAULT_API_URL}/v1/forms/test-form-id/submission/abc/confirm/code%2F1`,
    );
    expect(init!.method).toBe("PUT");
  });

  it("reportProblem POSTs the JSON problem payload", async () => {
    const keys = generateTestKeys();
    const fetchMock = routeFetch(() => new Response(null, { status: 200 }));
    const problem: FormSubmissionProblem = {
      contactEmail: "user@example.com",
      description: "Something went wrong here",
      preferredLanguage: "en",
    };

    await makeClient(keys).reportProblem("abc", problem);

    const [url, init] = apiCalls(fetchMock)[0]!;
    expect(String(url)).toBe(
      `${DEFAULT_API_URL}/v1/forms/test-form-id/submission/abc/problem`,
    );
    expect(init!.method).toBe("POST");
    expect(init!.body).toBe(JSON.stringify(problem));
    expect((init!.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("reportProblem rejects an invalid problem before any request", async () => {
    const keys = generateTestKeys();
    const fetchMock = routeFetch(() => new Response(null, { status: 200 }));

    await expect(
      makeClient(keys).reportProblem("abc", {
        contactEmail: "not-an-email",
        description: "too short",
        preferredLanguage: "en",
      } as FormSubmissionProblem),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("wraps unexpected 200 response shapes in GcFormsApiError", async () => {
    const keys = generateTestKeys();
    routeFetch(() => jsonResponse({ not: "an array" }));

    const promise = makeClient(keys).getNewSubmissions();

    await expect(promise).rejects.toThrow(GcFormsApiError);
    await expect(promise).rejects.toMatchObject({
      cause: expect.objectContaining({ name: "ZodError" }),
    });
  });

  it("wraps non-JSON 200 bodies in GcFormsApiError", async () => {
    const keys = generateTestKeys();
    routeFetch(() => new Response("<html>proxy error</html>", { status: 200 }));

    await expect(makeClient(keys).getFormTemplate()).rejects.toThrow(
      GcFormsApiError,
    );
  });

  it("wraps malformed decrypted submission data in GcFormsApiError", async () => {
    const keys = generateTestKeys();
    routeFetch(() =>
      jsonResponse(encryptSubmission("this is not json", keys.publicKey)),
    );

    await expect(makeClient(keys).getSubmission("abc")).rejects.toThrow(
      GcFormsApiError,
    );
  });

  it("wraps non-ok responses in GcFormsApiError with status and body", async () => {
    const keys = generateTestKeys();
    routeFetch(() => new Response("not found", { status: 404 }));

    const promise = makeClient(keys).getNewSubmissions();

    await expect(promise).rejects.toThrow(GcFormsApiError);
    await expect(promise).rejects.toMatchObject({
      status: 404,
      responseBody: "not found",
    });
  });

  it("wraps network errors in GcFormsApiError with a cause", async () => {
    const keys = generateTestKeys();
    routeFetch(() => {
      throw new TypeError("fetch failed");
    });

    await expect(makeClient(keys).getNewSubmissions()).rejects.toMatchObject({
      name: "GcFormsApiError",
      cause: new TypeError("fetch failed"),
    });
  });

  it("re-authenticates once on a 401 and retries the request", async () => {
    const keys = generateTestKeys();
    let apiAttempts = 0;
    const fetchMock = routeFetch(() => {
      apiAttempts += 1;
      return apiAttempts === 1
        ? new Response("expired", { status: 401 })
        : jsonResponse([]);
    });

    await expect(makeClient(keys).getNewSubmissions()).resolves.toEqual([]);

    expect(apiAttempts).toBe(2);
    const tokenCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/oauth/v2/token"),
    );
    expect(tokenCalls).toHaveLength(2);
  });

  it("downloadAttachment fetches the pre-signed link without auth headers", async () => {
    const keys = generateTestKeys();
    const fetchMock = mockFetch().mockResolvedValue(
      new Response(Buffer.from("file-bytes"), { status: 200 }),
    );

    const result = await makeClient(keys).downloadAttachment({
      name: "file.pdf",
      downloadLink: "https://files.example.com/presigned",
      isPotentiallyMalicious: false,
    });

    expect(Buffer.from(result).toString("utf8")).toBe("file-bytes");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://files.example.com/presigned");
    expect(init.headers).toBeUndefined();
  });

  it("downloadAttachment wraps a body read aborted mid-transfer in GcFormsApiError", async () => {
    const keys = generateTestKeys();
    mockFetch().mockImplementation(() =>
      Promise.resolve(new Response(erroringStream(), { status: 200 })),
    );

    const promise = makeClient(keys).downloadAttachment({
      name: "big.pdf",
      downloadLink: "https://files.example.com/presigned",
      isPotentiallyMalicious: false,
    });

    await expect(promise).rejects.toThrow(GcFormsApiError);
    await expect(promise).rejects.toMatchObject({
      cause: expect.objectContaining({ name: "TimeoutError" }),
    });
  });

  it("downloadAttachment retries a failed body read", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const keys = generateTestKeys();
    const fetchMock = mockFetch()
      .mockResolvedValueOnce(new Response(erroringStream(), { status: 200 }))
      .mockResolvedValueOnce(new Response(Buffer.from("file-bytes"), { status: 200 }));

    const result = await makeClient(keys, {
      retry: { maxAttempts: 2 },
    }).downloadAttachment({
      name: "file.pdf",
      downloadLink: "https://files.example.com/presigned",
      isPotentiallyMalicious: false,
    });

    expect(Buffer.from(result).toString("utf8")).toBe("file-bytes");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("downloadAttachment throws GcFormsApiError on a non-ok response", async () => {
    const keys = generateTestKeys();
    mockFetch().mockResolvedValue(new Response("gone", { status: 403 }));

    await expect(
      makeClient(keys).downloadAttachment({
        name: "file.pdf",
        downloadLink: "https://files.example.com/expired",
        isPotentiallyMalicious: false,
      }),
    ).rejects.toMatchObject({ name: "GcFormsApiError", status: 403 });
  });
});
