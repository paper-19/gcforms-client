import {
  constants,
  createCipheriv,
  createHash,
  generateKeyPairSync,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { vi, type Mock } from "vitest";
import type {
  EncryptedFormSubmission,
  FormSubmission,
  GcFormsCredentials,
} from "../src/types.js";

export type TestKeys = {
  publicKey: KeyObject;
  credentials: GcFormsCredentials;
};

export function generateTestKeys(
  overrides: Partial<GcFormsCredentials> = {},
): TestKeys {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });

  return {
    publicKey,
    credentials: {
      keyId: "test-key-id",
      key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      userId: "test-user-id",
      formId: "test-form-id",
      ...overrides,
    },
  };
}

/** Inverse of decryptFormSubmission: produces a valid encrypted envelope. */
export function encryptSubmission(
  payload: string,
  publicKey: KeyObject,
): EncryptedFormSubmission {
  const key = randomBytes(32);
  const nonce = randomBytes(12);

  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encryptedResponses = Buffer.concat([
    cipher.update(payload, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const rsaEncrypt = (data: Buffer) =>
    publicEncrypt(
      {
        key: publicKey,
        oaepHash: "sha256",
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      data,
    ).toString("base64");

  return {
    encryptedKey: rsaEncrypt(key),
    encryptedNonce: rsaEncrypt(nonce),
    encryptedAuthTag: rsaEncrypt(authTag),
    encryptedResponses: encryptedResponses.toString("base64"),
  };
}

export function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

export function buildSubmission(answers: string): FormSubmission {
  return {
    createdAt: 1700000000000,
    status: "New",
    confirmationCode: "1a2b3c4d",
    answers,
    checksum: md5(answers),
  };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

export function tokenResponse(
  accessToken = "test-access-token",
  expiresIn = 1800,
): Response {
  return jsonResponse({ access_token: accessToken, expires_in: expiresIn });
}

export function mockFetch(): Mock {
  const fn = vi.fn();
  vi.stubGlobal("fetch", fn);
  return fn;
}
