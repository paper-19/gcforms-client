import { z } from "zod";
import { TokenProvider } from "./auth.js";
import { decryptFormSubmission, verifySubmissionIntegrity } from "./crypto.js";
import { GcFormsApiError, GcFormsDecryptionError } from "./errors.js";
import { fetchWithRetry, type RetryOptions } from "./retry.js";
import {
  encryptedFormSubmissionSchema,
  formSubmissionProblemSchema,
  formSubmissionSchema,
  newFormSubmissionSchema,
  gcFormsCredentialsSchema,
  type Attachment,
  type EncryptedFormSubmission,
  type FormSubmission,
  type FormSubmissionProblem,
  type NewFormSubmission,
  type GcFormsCredentials,
} from "./types.js";

export const DEFAULT_API_URL = "https://api.forms-formulaires.alpha.canada.ca";
export const DEFAULT_IDENTITY_PROVIDER_URL =
  "https://auth.forms-formulaires.alpha.canada.ca";
export const DEFAULT_PROJECT_IDENTIFIER = "284778202772022819";

const DEFAULT_API_VERSION = "v1";
const DEFAULT_TIMEOUT_MS = 10_000;

export type GcFormsClientConfig = {
  /** Contents of the `<formId>_private_api_key.json` file from GC Forms. */
  credentials: GcFormsCredentials;
  /** @default DEFAULT_API_URL (the production GC Forms API) */
  apiUrl?: string;
  /** @default DEFAULT_IDENTITY_PROVIDER_URL (the production GC Forms IdP) */
  identityProviderUrl?: string;
  /** @default DEFAULT_PROJECT_IDENTIFIER (the production GC Forms Zitadel project) */
  projectIdentifier?: string;
  /** API version path segment. @default "v1" */
  apiVersion?: string;
  /** Per-attempt request timeout. @default 10_000 */
  timeoutMs?: number;
  retry?: RetryOptions;
};

export class GcFormsClient {
  /** The form this client is bound to, taken from the private API key. */
  public readonly formId: string;

  private readonly baseUrl: string;
  private readonly credentials: GcFormsCredentials;
  private readonly timeoutMs: number;
  private readonly retry: RetryOptions;
  private readonly tokenProvider: TokenProvider;

  public constructor(config: GcFormsClientConfig) {
    this.credentials = gcFormsCredentialsSchema.parse(config.credentials);
    this.formId = this.credentials.formId;

    const apiUrl = trimTrailingSlashes(config.apiUrl ?? DEFAULT_API_URL);
    const apiVersion = trimSlashes(config.apiVersion ?? DEFAULT_API_VERSION);
    this.baseUrl = `${apiUrl}/${apiVersion}`;

    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = config.retry ?? {};
    this.tokenProvider = new TokenProvider({
      identityProviderUrl: trimTrailingSlashes(
        config.identityProviderUrl ?? DEFAULT_IDENTITY_PROVIDER_URL,
      ),
      projectIdentifier: config.projectIdentifier ?? DEFAULT_PROJECT_IDENTIFIER,
      credentials: this.credentials,
      timeoutMs: this.timeoutMs,
      retry: this.retry,
    });
  }

  /** Form structure and question definitions; shape depends on the form. */
  public async getFormTemplate(): Promise<Record<string, unknown>> {
    const response = await this.request("GET", `/forms/${this.formId}/template`);
    return parseResponse(
      response,
      z.record(z.string(), z.unknown()),
      "form template",
    );
  }

  /** Up to the 100 oldest submissions still in "New" status. */
  public async getNewSubmissions(): Promise<NewFormSubmission[]> {
    const response = await this.request(
      "GET",
      `/forms/${this.formId}/submission/new`,
    );
    return parseResponse(
      response,
      z.array(newFormSubmissionSchema),
      "new submissions",
    );
  }

  public async getEncryptedSubmission(
    submissionName: string,
  ): Promise<EncryptedFormSubmission> {
    const response = await this.request(
      "GET",
      `/forms/${this.formId}/submission/${encodeURIComponent(submissionName)}`,
    );
    return parseResponse(
      response,
      encryptedFormSubmissionSchema,
      `submission ${submissionName}`,
    );
  }

  /**
   * Retrieves, decrypts and integrity-checks a submission. Note that any
   * `attachments[].downloadLink` is only valid for ~10 seconds — download
   * promptly (see downloadAttachment) before confirming.
   */
  public async getSubmission(submissionName: string): Promise<FormSubmission> {
    const encrypted = await this.getEncryptedSubmission(submissionName);
    const decrypted = decryptFormSubmission(encrypted, this.credentials);

    let submission: FormSubmission;
    try {
      submission = formSubmissionSchema.parse(JSON.parse(decrypted));
    } catch (error) {
      throw new GcFormsApiError(
        `GC Forms returned malformed decrypted data for submission ${submissionName}`,
        undefined,
        undefined,
        { cause: error },
      );
    }

    if (!verifySubmissionIntegrity(submission.answers, submission.checksum)) {
      throw new GcFormsDecryptionError(
        `Integrity check failed for submission ${submissionName}: answers do not match checksum`,
      );
    }

    return submission;
  }

  /**
   * Marks a submission as received. Only confirm after its answers and
   * attachments are safely persisted; confirmed submissions are deleted
   * from GC Forms after 30 days.
   */
  public async confirmSubmission(
    submissionName: string,
    confirmationCode: string,
  ): Promise<void> {
    await this.request(
      "PUT",
      `/forms/${this.formId}/submission/${encodeURIComponent(submissionName)}/confirm/${encodeURIComponent(confirmationCode)}`,
    );
  }

  /** Flags a submission for GC Forms support review. */
  public async reportProblem(
    submissionName: string,
    problem: FormSubmissionProblem,
  ): Promise<void> {
    await this.request(
      "POST",
      `/forms/${this.formId}/submission/${encodeURIComponent(submissionName)}/problem`,
      formSubmissionProblemSchema.parse(problem),
    );
  }

  /**
   * Downloads an attachment via its pre-signed link (valid ~10 seconds).
   * Callers should check `attachment.isPotentiallyMalicious` before use.
   */
  public async downloadAttachment(attachment: Attachment): Promise<ArrayBuffer> {
    let data: ArrayBuffer | undefined;
    let response: Response;
    try {
      response = await fetchWithRetry(
        attachment.downloadLink,
        () => ({}),
        this.timeoutMs,
        this.retry,
        async (ok) => {
          data = await ok.arrayBuffer();
        },
      );
    } catch (error) {
      throw new GcFormsApiError(
        `Failed to download attachment '${attachment.name}'`,
        undefined,
        undefined,
        { cause: error },
      );
    }

    if (!response.ok || data === undefined) {
      throw new GcFormsApiError(
        `Failed to download attachment '${attachment.name}' (HTTP ${response.status})`,
        response.status,
      );
    }

    return data;
  }

  private async request(
    method: "GET" | "PUT" | "POST",
    path: string,
    body?: unknown,
  ): Promise<Response> {
    let response = await this.send(method, path, body);

    // The cached token can be revoked server-side before its expiry; retry
    // once with a freshly fetched token.
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      this.tokenProvider.invalidate();
      response = await this.send(method, path, body);
    }

    if (!response.ok) {
      const responseBody = await response.text().catch(() => undefined);
      throw new GcFormsApiError(
        `GC Forms request failed: ${method} ${path} (HTTP ${response.status})`,
        response.status,
        responseBody,
      );
    }

    return response;
  }

  private async send(
    method: "GET" | "PUT" | "POST",
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const accessToken = await this.tokenProvider.getAccessToken();

    try {
      return await fetchWithRetry(
        `${this.baseUrl}${path}`,
        () => ({
          method,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            ...(body !== undefined && { "Content-Type": "application/json" }),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        }),
        this.timeoutMs,
        this.retry,
      );
    } catch (error) {
      throw new GcFormsApiError(
        `GC Forms request failed: ${method} ${path}`,
        undefined,
        undefined,
        { cause: error },
      );
    }
  }
}

/** Parses a successful response body, translating malformed server data into GcFormsApiError. */
async function parseResponse<T>(
  response: Response,
  schema: { parse(data: unknown): T },
  description: string,
): Promise<T> {
  try {
    return schema.parse(await response.json());
  } catch (error) {
    throw new GcFormsApiError(
      `GC Forms returned an unexpected response for ${description}`,
      undefined,
      undefined,
      { cause: error },
    );
  }
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}
