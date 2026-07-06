import { z } from "zod";

/**
 * Contents of the `<formId>_private_api_key.json` file generated from
 * GC Forms under "Settings > API integration". `key` is a PEM-encoded
 * RSA private key used both to sign the OAuth JWT assertion and to
 * decrypt submissions.
 */
export const gcFormsCredentialsSchema = z.object({
  keyId: z.string().min(1),
  key: z.string().min(1),
  userId: z.string().min(1),
  formId: z.string().min(1),
});

export type GcFormsCredentials = z.infer<typeof gcFormsCredentialsSchema>;

export const newFormSubmissionSchema = z.object({
  name: z.string().min(1),
  createdAt: z.number(),
});

export type NewFormSubmission = z.infer<typeof newFormSubmissionSchema>;

export const encryptedFormSubmissionSchema = z.object({
  encryptedKey: z.string().min(1),
  encryptedNonce: z.string().min(1),
  encryptedAuthTag: z.string().min(1),
  encryptedResponses: z.string().min(1),
});

export type EncryptedFormSubmission = z.infer<
  typeof encryptedFormSubmissionSchema
>;

export const formSubmissionStatusSchema = z.enum([
  "New",
  "Downloaded",
  "Confirmed",
  "Problem",
]);

export type FormSubmissionStatus = z.infer<typeof formSubmissionStatusSchema>;

export const attachmentSchema = z.object({
  name: z.string(),
  /** Pre-signed URL, only valid for ~10 seconds after retrieval. */
  downloadLink: z.string(),
  isPotentiallyMalicious: z.boolean(),
});

export type Attachment = z.infer<typeof attachmentSchema>;

export const formSubmissionSchema = z.object({
  createdAt: z.number(),
  status: formSubmissionStatusSchema,
  confirmationCode: z.string(),
  /** JSON string mapping question ids to answers; shape depends on the form template. */
  answers: z.string(),
  checksum: z.string(),
  attachments: z.array(attachmentSchema).optional(),
});

export type FormSubmission = z.infer<typeof formSubmissionSchema>;

export const formSubmissionProblemSchema = z.object({
  contactEmail: z.email(),
  description: z.string().min(10),
  preferredLanguage: z.enum(["en", "fr"]),
});

export type FormSubmissionProblem = z.infer<typeof formSubmissionProblemSchema>;
