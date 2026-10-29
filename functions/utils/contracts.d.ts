export interface UploadLimits {
    maxSingleBytes: number;
    maxTotalBytes: number;
    maxChunkBytes: number;
}

export interface UploadPolicyConfiguration {
    /** @deprecated Ignored: application file-size caps are disabled. */
    UPLOAD_MAX_SINGLE_BYTES?: string | number;
    /** @deprecated Ignored: application file-size caps are disabled. */
    UPLOAD_MAX_TOTAL_BYTES?: string | number;
    /** @deprecated Ignored: application file-size caps are disabled. */
    UPLOAD_MAX_CHUNK_BYTES?: string | number;
    /** @deprecated Ignored: all upload extensions are accepted. */
    UPLOAD_ALLOWED_EXTENSIONS?: string;
    /** @deprecated Ignored: all upload MIME types are accepted. */
    UPLOAD_ALLOWED_MIME_TYPES?: string;
    UPLOAD_ALLOW_LEGACY_CHUNKS?: string;
}

export interface UploadFileInput {
    fileName?: unknown;
    fileType?: unknown;
    fileSize?: unknown;
}

export type UploadPolicyResult =
    | { ok: true; fileType: string }
    | { ok: false; status: number; code: string; message: string };

export interface UrlValidationOptions {
    allowedHosts?: string | string[];
    requireAllowlist?: boolean;
}

export type UrlValidationResult =
    | { ok: true; parsed: URL }
    | { ok: false; error: string };

export interface CorsConfiguration {
    CORS_ALLOWED_ORIGINS?: string;
    CORS_ALLOW_CREDENTIALS?: string;
}

export interface CorsOptions {
    methods?: string;
    headers?: string;
    maxAge?: string;
    exposeHeaders?: string;
    request?: Request;
    env?: CorsConfiguration;
}
