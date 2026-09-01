/**
 * The error envelope every public endpoint returns.
 *
 * A public API is consumed by code that cannot read a sentence and decide what
 * to do. So every failure carries a stable machine-readable `code` that we
 * promise not to change, alongside a `message` written for the human reading
 * the logs at 2am. Callers branch on the code; they display the message.
 *
 * The codes are deliberately coarse. A caller can act on "you are out of
 * quota" or "that estimate does not exist". There is nothing useful they can
 * do with the difference between two internal failure modes, and every code we
 * publish is a code we can never remove.
 */

export const ERROR_CODES = [
  /** No credential, malformed header, unknown key, or the key was revoked. */
  "unauthorized",
  /** The key is valid but not permitted to do this. */
  "forbidden",
  /** The request body or parameters did not validate. `detail` says where. */
  "invalid_request",
  /** The referenced estimate does not exist, or belongs to another account. */
  "not_found",
  /** Too many requests in the burst window. Look at Retry-After. */
  "rate_limited",
  /** The monthly estimate allowance is spent. */
  "quota_exceeded",
  /** The document was readable but unusable — empty, too short, wrong type. */
  "unprocessable_document",
  /** The document exceeded a size limit. */
  "payload_too_large",
  /** Same Idempotency-Key, different body. */
  "idempotency_conflict",
  /** Something on our side broke. The caller can retry. */
  "internal_error",
  /** A dependency we need (the model provider) is unavailable. */
  "service_unavailable",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Field-level specifics for `invalid_request`. Never present otherwise. */
    detail?: string[];
    /**
     * Echoed on every error so a customer can quote one line in a support
     * email and we can find the exact request in the logs.
     */
    request_id: string;
  };
}

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  invalid_request: 400,
  not_found: 404,
  rate_limited: 429,
  quota_exceeded: 429,
  unprocessable_document: 422,
  payload_too_large: 413,
  idempotency_conflict: 409,
  internal_error: 500,
  service_unavailable: 503,
};

export const statusFor = (code: ErrorCode): number => STATUS[code];

/**
 * Builds an error response.
 *
 * `headers` exists for the two cases that need them: `WWW-Authenticate` on a
 * 401 and `Retry-After` on a 429. A 429 without Retry-After forces every
 * client to invent its own backoff, and they invent it badly.
 */
export function apiError(
  code: ErrorCode,
  message: string,
  requestId: string,
  opts: { detail?: string[]; headers?: Record<string, string> } = {},
): Response {
  const body: ApiErrorBody = {
    error: { code, message, request_id: requestId, ...(opts.detail ? { detail: opts.detail } : {}) },
  };
  return Response.json(body, {
    status: statusFor(code),
    headers: { "Cache-Control": "no-store", ...(opts.headers ?? {}) },
  });
}

/**
 * A failure that a route can throw from anywhere and have rendered correctly.
 * Anything that is *not* an ApiFault becomes a 500 with no detail attached —
 * an unexpected exception's message may contain a file path, a query, or a
 * fragment of someone's solicitation, and none of that belongs in a response.
 */
export class ApiFault extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: string[],
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiFault";
  }
}
