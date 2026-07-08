# gcforms-client

> [!IMPORTANT]
> This is an unofficial, community-maintained client. It is not a Government of Canada project and is not affiliated with, maintained, or endorsed by the GC Forms team or the Canadian Digital Service.

TypeScript client for the [GC Forms](https://articles.alpha.canada.ca/forms-formulaires/) (Government of Canada Forms) API. Handles OAuth2 JWT-bearer authentication against the GC Forms identity provider, retrieval and decryption of form submissions (RSA-OAEP + AES-256-GCM), integrity verification, attachment downloads, and confirmation — with built-in retries and typed errors.

Requires Node.js 20 or later. ESM-only.

## Install

```sh
npm install @paper19/gcforms-client
```

## Quick start

Generate an API key for your form in GC Forms under **Settings → API integration**. This downloads a `<formId>_private_api_key.json` file — it is the only configuration the client needs.

```ts
import { readFile } from "node:fs/promises";
import { GcFormsClient, gcFormsCredentialsSchema } from "@paper19/gcforms-client";

const credentials = gcFormsCredentialsSchema.parse(
  JSON.parse(await readFile("./<formId>_private_api_key.json", "utf8")),
);

const client = new GcFormsClient({ credentials });

// Up to the 100 oldest submissions still in "New" status.
const newSubmissions = await client.getNewSubmissions();

for (const { name } of newSubmissions) {
  // Fetches, decrypts and integrity-checks the submission.
  const submission = await client.getSubmission(name);
  const answers = JSON.parse(submission.answers);

  // Attachment download links are only valid for ~10 seconds after
  // retrieval — download immediately, before doing anything else.
  for (const attachment of submission.attachments ?? []) {
    if (attachment.isPotentiallyMalicious) continue; // flagged by GC Forms scanning
    const bytes = await client.downloadAttachment(attachment);
    // ...persist bytes...
  }

  // ...persist answers...

  // Only confirm once everything is safely stored: confirmed submissions
  // are deleted from GC Forms after 30 days.
  await client.confirmSubmission(name, submission.confirmationCode);
}
```

### Loading the key from Azure Key Vault

```sh
az keyvault secret set \
  --vault-name <vault-name> \
  --name gcforms-private-api-key \
  --file <formId>_private_api_key.json
```

```ts
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import { GcFormsClient, gcFormsCredentialsSchema } from "@paper19/gcforms-client";

const vault = new SecretClient(
  "https://<vault-name>.vault.azure.net",
  new DefaultAzureCredential(),
);

const secret = await vault.getSecret("gcforms-private-api-key");
if (!secret.value) {
  throw new Error("Secret gcforms-private-api-key has no value");
}

const credentials = gcFormsCredentialsSchema.parse(JSON.parse(secret.value));
const client = new GcFormsClient({ credentials });
```

## API

| Method | Description |
| --- | --- |
| `getFormTemplate()` | Form structure and question definitions (shape depends on the form). |
| `getNewSubmissions()` | Up to the 100 oldest submissions in `New` status. |
| `getSubmission(name)` | Fetches, decrypts and integrity-checks one submission. |
| `getEncryptedSubmission(name)` | The raw encrypted envelope, if you want to decrypt later/elsewhere. |
| `downloadAttachment(attachment)` | Downloads via the pre-signed link (valid ~10 s) → `ArrayBuffer`. |
| `confirmSubmission(name, confirmationCode)` | Marks a submission as received. |
| `reportProblem(name, problem)` | Flags a submission for GC Forms support review. |

Standalone helpers `decryptFormSubmission(encrypted, credentials)` and `verifySubmissionIntegrity(answers, checksum)` are also exported, along with all zod schemas and inferred types (`formSubmissionSchema`, `FormSubmission`, …).

## Configuration

All fields except `credentials` are optional; the defaults point at the production GC Forms service.

```ts
new GcFormsClient({
  credentials,                  // required — parsed <formId>_private_api_key.json
  apiUrl,                       // default "https://api.forms-formulaires.alpha.canada.ca"
  identityProviderUrl,          // default "https://auth.forms-formulaires.alpha.canada.ca"
  projectIdentifier,            // default "284778202772022819" (GC Forms Zitadel project)
  apiVersion,                   // default "v1"
  timeoutMs,                    // default 10_000 — per request attempt
  retry: {
    maxAttempts,                // default 3 (total attempts; 1 disables retries)
    baseDelayMs,                // default 250
    maxDelayMs,                 // default 8_000
    retryStatuses,              // default [429, 500, 502, 503, 504]
  },
});
```

Retries use exponential backoff with full jitter and honour `Retry-After` (capped at 30 s). Network errors and timeouts are retried; a `401` triggers a single re-authentication with a fresh token. Access tokens are cached per client instance and refreshed shortly before expiry.

## Error handling

Everything the package throws (other than zod validation errors on your own inputs) extends `GcFormsApiError`:

```ts
import { GcFormsApiError, GcFormsAuthError, GcFormsDecryptionError } from "@paper19/gcforms-client";

try {
  await client.getSubmission(name);
} catch (error) {
  if (error instanceof GcFormsAuthError) {
    // token could not be obtained from the identity provider
  } else if (error instanceof GcFormsDecryptionError) {
    // decryption failed or the checksum did not match
  } else if (error instanceof GcFormsApiError) {
    console.error(error.status, error.responseBody, error.cause);
  }
}
```

## Security notes

- The `key` in the private API key file is both the OAuth signing key and the submission decryption key — treat the whole file as a secret (do not commit it; load it from your secret store).
- Check `attachment.isPotentiallyMalicious` before using attachments; it is set by GC Forms' malware scanning.
- The MD5 `checksum` is the service's integrity check, not a security boundary — authenticity is provided by the AES-GCM auth tag.
- Confirm a submission only after its answers and attachments are durably persisted; confirmed submissions are deleted from GC Forms after 30 days.

## Development

```sh
npm install
npm test           # vitest
npm run typecheck  # tsc over src + tests
npm run build      # emits dist/ (ESM + .d.ts)
```

Publishing: `npm version <patch|minor|major> && npm publish` (the `prepack` script builds `dist/` automatically).
