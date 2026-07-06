/**
 * Base class for every error thrown by this package; `instanceof
 * GcFormsApiError` catches them all.
 */
export class GcFormsApiError extends Error {
  public constructor(
    message: string,
    public readonly status?: number,
    public readonly responseBody?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GcFormsApiError";
  }
}

/** Failure to obtain an access token from the GC Forms identity provider. */
export class GcFormsAuthError extends GcFormsApiError {
  public constructor(
    message: string,
    status?: number,
    responseBody?: string,
    options?: ErrorOptions,
  ) {
    super(message, status, responseBody, options);
    this.name = "GcFormsAuthError";
  }
}

/** Failure to decrypt a submission or verify its integrity checksum. */
export class GcFormsDecryptionError extends GcFormsApiError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, undefined, undefined, options);
    this.name = "GcFormsDecryptionError";
  }
}
