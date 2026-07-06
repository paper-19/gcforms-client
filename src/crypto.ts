import { createDecipheriv, createHash, privateDecrypt } from "node:crypto";
import { GcFormsDecryptionError } from "./errors.js";
import type { EncryptedFormSubmission, GcFormsCredentials } from "./types.js";

/**
 * Decrypts a submission payload: the AES key, nonce and auth tag are each
 * RSA-OAEP(SHA-256) encrypted with the form's key pair, and the responses
 * themselves are AES-256-GCM encrypted. Returns the decrypted JSON string.
 */
export function decryptFormSubmission(
  encryptedSubmission: EncryptedFormSubmission,
  credentials: GcFormsCredentials,
): string {
  try {
    const privateKey = { key: credentials.key, oaepHash: "sha256" };

    const key = privateDecrypt(
      privateKey,
      Buffer.from(encryptedSubmission.encryptedKey, "base64"),
    );
    const nonce = privateDecrypt(
      privateKey,
      Buffer.from(encryptedSubmission.encryptedNonce, "base64"),
    );
    const authTag = privateDecrypt(
      privateKey,
      Buffer.from(encryptedSubmission.encryptedAuthTag, "base64"),
    );

    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedSubmission.encryptedResponses, "base64")),
      decipher.final(),
    ]);

    return decrypted.toString("utf8");
  } catch (error) {
    throw new GcFormsDecryptionError("Failed to decrypt form submission", {
      cause: error,
    });
  }
}

/**
 * Verifies the MD5 checksum GC Forms computes over the `answers` string.
 * MD5 is what the service uses; it is an integrity check, not a security
 * boundary (authenticity is already covered by the GCM auth tag).
 */
export function verifySubmissionIntegrity(
  answers: string,
  checksum: string,
): boolean {
  return createHash("md5").update(answers).digest("hex") === checksum;
}
