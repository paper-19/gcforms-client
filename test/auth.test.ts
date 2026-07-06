import { verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signJwtAssertion, TokenProvider } from "../src/auth.js";
import { GcFormsAuthError } from "../src/errors.js";
import {
  generateTestKeys,
  jsonResponse,
  mockFetch,
  tokenResponse,
  type TestKeys,
} from "./helpers.js";

const IDP_URL = "https://idp.example.com";
const PROJECT_ID = "123456789";

function makeProvider(keys: TestKeys): TokenProvider {
  return new TokenProvider({
    identityProviderUrl: IDP_URL,
    projectIdentifier: PROJECT_ID,
    credentials: keys.credentials,
    timeoutMs: 10_000,
    retry: { maxAttempts: 1 },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("signJwtAssertion", () => {
  it("produces a verifiable RS256 JWT with the expected claims", () => {
    const keys = generateTestKeys();
    const before = Math.floor(Date.now() / 1000);

    const assertion = signJwtAssertion({
      identityProviderUrl: IDP_URL,
      credentials: keys.credentials,
    });

    const [headerPart, payloadPart, signaturePart] = assertion.split(".");
    const header = JSON.parse(
      Buffer.from(headerPart!, "base64url").toString("utf8"),
    );
    const payload = JSON.parse(
      Buffer.from(payloadPart!, "base64url").toString("utf8"),
    );

    expect(header).toEqual({ alg: "RS256", typ: "JWT", kid: "test-key-id" });
    expect(payload.iss).toBe("test-user-id");
    expect(payload.sub).toBe("test-user-id");
    expect(payload.aud).toBe(IDP_URL);
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    expect(payload.exp - payload.iat).toBe(60);

    const verified = verify(
      "sha256",
      Buffer.from(`${headerPart}.${payloadPart}`),
      keys.publicKey,
      Buffer.from(signaturePart!, "base64url"),
    );
    expect(verified).toBe(true);
  });
});

describe("TokenProvider", () => {
  it("requests a token with the JWT-bearer grant and project scope", async () => {
    const keys = generateTestKeys();
    const fetchMock = mockFetch().mockResolvedValue(tokenResponse());

    const token = await makeProvider(keys).getAccessToken();

    expect(token).toBe("test-access-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${IDP_URL}/oauth/v2/token`);

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = init.body as URLSearchParams;
    expect(body.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    expect(body.get("scope")).toBe(
      `openid profile urn:zitadel:iam:org:project:id:${PROJECT_ID}:aud`,
    );
    expect(body.get("assertion")).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("caches the token and refreshes it near expiry", async () => {
    vi.useFakeTimers();
    const keys = generateTestKeys();
    const fetchMock = mockFetch().mockResolvedValue(tokenResponse());
    const provider = makeProvider(keys);

    await provider.getAccessToken();
    await provider.getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue(tokenResponse("fresh-token"));
    // Refresh margin is 60s before the 1800s expiry.
    vi.advanceTimersByTime((1800 - 60) * 1000 + 1);
    const refreshed = await provider.getAccessToken();

    expect(refreshed).toBe("fresh-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent refreshes into a single request", async () => {
    const keys = generateTestKeys();
    const fetchMock = mockFetch().mockResolvedValue(tokenResponse());
    const provider = makeProvider(keys);

    const [a, b] = await Promise.all([
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);

    expect(a).toBe("test-access-token");
    expect(b).toBe("test-access-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not share tokens between instances", async () => {
    const keys = generateTestKeys();
    const fetchMock = mockFetch().mockImplementation(() =>
      Promise.resolve(tokenResponse()),
    );

    await makeProvider(keys).getAccessToken();
    await makeProvider(keys).getAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetches a fresh token after invalidate()", async () => {
    const keys = generateTestKeys();
    const fetchMock = mockFetch().mockImplementation(() =>
      Promise.resolve(tokenResponse()),
    );
    const provider = makeProvider(keys);

    await provider.getAccessToken();
    provider.invalidate();
    await provider.getAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws GcFormsAuthError with status and body on a rejected token request", async () => {
    const keys = generateTestKeys();
    mockFetch().mockResolvedValue(new Response("denied", { status: 403 }));

    const promise = makeProvider(keys).getAccessToken();

    await expect(promise).rejects.toThrow(GcFormsAuthError);
    await expect(promise).rejects.toMatchObject({
      status: 403,
      responseBody: "denied",
    });
  });

  it("throws GcFormsAuthError when a 200 token response is malformed", async () => {
    const keys = generateTestKeys();

    // Non-JSON body (e.g. an HTML error page from a proxy).
    mockFetch().mockImplementation(() =>
      Promise.resolve(new Response("<html>proxy error</html>", { status: 200 })),
    );
    await expect(makeProvider(keys).getAccessToken()).rejects.toThrow(
      GcFormsAuthError,
    );

    // Valid JSON missing access_token.
    mockFetch().mockImplementation(() =>
      Promise.resolve(jsonResponse({ token_type: "Bearer" })),
    );
    const promise = makeProvider(keys).getAccessToken();
    await expect(promise).rejects.toThrow(GcFormsAuthError);
    await expect(promise).rejects.toMatchObject({
      cause: expect.objectContaining({ name: "ZodError" }),
    });
  });

  it("throws GcFormsAuthError with a cause on network failure", async () => {
    const keys = generateTestKeys();
    mockFetch().mockRejectedValue(new TypeError("fetch failed"));

    const promise = makeProvider(keys).getAccessToken();

    await expect(promise).rejects.toThrow(GcFormsAuthError);
    await expect(promise).rejects.toMatchObject({
      cause: new TypeError("fetch failed"),
    });
  });
});
