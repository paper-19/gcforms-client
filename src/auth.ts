import { createPrivateKey, sign } from "node:crypto";
import { z } from "zod";
import { GcFormsAuthError } from "./errors.js";
import { fetchWithRetry, type RetryOptions } from "./retry.js";
import type { GcFormsCredentials } from "./types.js";

const ASSERTION_LIFETIME_SECONDS = 60;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 30 * 60;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().default(DEFAULT_TOKEN_LIFETIME_SECONDS),
});

export type GcFormsAuthConfig = {
  identityProviderUrl: string;
  projectIdentifier: string;
  credentials: GcFormsCredentials;
  timeoutMs: number;
  retry: RetryOptions;
};

/** RS256-signed OAuth JWT-bearer assertion, as required by the GC Forms IdP (Zitadel). */
export function signJwtAssertion({
  identityProviderUrl,
  credentials,
}: Pick<GcFormsAuthConfig, "identityProviderUrl" | "credentials">): string {
  const issuedAt = Math.floor(Date.now() / 1000);

  const header = base64UrlJson({
    alg: "RS256",
    typ: "JWT",
    kid: credentials.keyId,
  });
  const payload = base64UrlJson({
    iss: credentials.userId,
    sub: credentials.userId,
    aud: identityProviderUrl,
    iat: issuedAt,
    exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
  });

  const signingInput = `${header}.${payload}`;
  const signature = sign(
    "sha256",
    Buffer.from(signingInput),
    createPrivateKey(credentials.key),
  ).toString("base64url");

  return `${signingInput}.${signature}`;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

type CachedToken = { value: string; expiresAt: number };

/**
 * Fetches and caches bearer tokens for the GC Forms API. Tokens are reused
 * until shortly before expiry (they are valid for 30 minutes), and
 * concurrent refreshes are coalesced into a single token request.
 */
export class TokenProvider {
  private cached: CachedToken | undefined;
  private inflight: Promise<string> | undefined;

  public constructor(private readonly config: GcFormsAuthConfig) {}

  public async getAccessToken(): Promise<string> {
    if (
      this.cached &&
      this.cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()
    ) {
      return this.cached.value;
    }

    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** Drops the cached token so the next call fetches a fresh one. */
  public invalidate(): void {
    this.cached = undefined;
  }

  private async fetchToken(): Promise<string> {
    let response: Response;
    try {
      response = await fetchWithRetry(
        `${this.config.identityProviderUrl}/oauth/v2/token`,
        () => ({
          method: "POST",
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: signJwtAssertion(this.config),
            scope: `openid profile urn:zitadel:iam:org:project:id:${this.config.projectIdentifier}:aud`,
          }),
        }),
        this.config.timeoutMs,
        this.config.retry,
      );
    } catch (error) {
      throw new GcFormsAuthError(
        "Failed to obtain GC Forms access token",
        undefined,
        undefined,
        { cause: error },
      );
    }

    if (!response.ok) {
      const responseBody = await response.text().catch(() => undefined);
      throw new GcFormsAuthError(
        `Failed to obtain GC Forms access token (HTTP ${response.status})`,
        response.status,
        responseBody,
      );
    }

    let access_token: string;
    let expires_in: number;
    try {
      ({ access_token, expires_in } = tokenResponseSchema.parse(
        await response.json(),
      ));
    } catch (error) {
      throw new GcFormsAuthError(
        "GC Forms identity provider returned a malformed token response",
        undefined,
        undefined,
        { cause: error },
      );
    }

    this.cached = {
      value: access_token,
      expiresAt: Date.now() + expires_in * 1000,
    };

    return access_token;
  }
}
