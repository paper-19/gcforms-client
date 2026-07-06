import { describe, expect, it } from "vitest";
import { decryptFormSubmission, verifySubmissionIntegrity } from "../src/crypto.js";
import { GcFormsDecryptionError } from "../src/errors.js";
import { encryptSubmission, generateTestKeys, md5 } from "./helpers.js";

describe("decryptFormSubmission", () => {
  it("round-trips an encrypted payload", () => {
    const { publicKey, credentials } = generateTestKeys();
    const payload = JSON.stringify({ answers: '{"1":"hello"}' });

    const decrypted = decryptFormSubmission(
      encryptSubmission(payload, publicKey),
      credentials,
    );

    expect(decrypted).toBe(payload);
  });

  it("throws GcFormsDecryptionError with a cause for the wrong private key", () => {
    const { publicKey } = generateTestKeys();
    const otherKeys = generateTestKeys();
    const encrypted = encryptSubmission("payload", publicKey);

    let thrown: unknown;
    try {
      decryptFormSubmission(encrypted, otherKeys.credentials);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GcFormsDecryptionError);
    expect((thrown as GcFormsDecryptionError).cause).toBeDefined();
  });

  it("throws GcFormsDecryptionError for tampered ciphertext", () => {
    const { publicKey, credentials } = generateTestKeys();
    const encrypted = encryptSubmission("payload", publicKey);
    const corrupted = Buffer.from(encrypted.encryptedResponses, "base64");
    corrupted[0] = corrupted[0]! ^ 0xff;

    expect(() =>
      decryptFormSubmission(
        { ...encrypted, encryptedResponses: corrupted.toString("base64") },
        credentials,
      ),
    ).toThrow(GcFormsDecryptionError);
  });

  it("throws GcFormsDecryptionError for a tampered auth tag", () => {
    const { publicKey, credentials } = generateTestKeys();
    const encrypted = encryptSubmission("payload", publicKey);

    expect(() =>
      decryptFormSubmission(
        { ...encrypted, encryptedAuthTag: encrypted.encryptedKey },
        credentials,
      ),
    ).toThrow(GcFormsDecryptionError);
  });
});

describe("verifySubmissionIntegrity", () => {
  it("accepts a matching MD5 checksum", () => {
    expect(verifySubmissionIntegrity("answers", md5("answers"))).toBe(true);
  });

  it("rejects a mismatched checksum", () => {
    expect(verifySubmissionIntegrity("answers", md5("other"))).toBe(false);
  });
});
