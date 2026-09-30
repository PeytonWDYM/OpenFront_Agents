import { z } from "zod";

export class CodexTurnError extends Error {
  constructor(readonly details: Record<string, unknown> & { message: string }) {
    super(details.message);
  }
}

export type RecoveryAction = "retry" | "replace" | "pause" | "stop";
const errorInfo = z.union([z.string(), z.record(z.string(), z.unknown())]);
const transientCodes = new Set([
  "serverOverloaded",
  "internalServerError",
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
  "flexUnavailable",
]);

/** Retry only known transient failures. Never recreate a policy-rejected prompt. */
export function recoveryAction(error: unknown): RecoveryAction {
  const text = error instanceof Error ? error.message : String(error);
  const details = error instanceof CodexTurnError ? error.details : undefined;
  if (
    /usage[ _-]?policy|policy[ _-]?violation|cyber[ _-]?policy|safety|flagged|invalid prompt|content[ _-]?filter/i.test(
      `${text} ${JSON.stringify(details?.codexErrorInfo ?? null)}`,
    ) ||
    (details?.misalignment !== undefined && details.misalignment !== null)
  )
    return "stop";
  const parsed = errorInfo.safeParse(details?.codexErrorInfo);
  const code = parsed.success
    ? typeof parsed.data === "string"
      ? parsed.data
      : Object.keys(parsed.data)[0]
    : undefined;
  const wrapped =
    parsed.success && typeof parsed.data !== "string"
      ? z
          .object({ httpStatusCode: z.number().nullable().optional() })
          .safeParse(Object.values(parsed.data)[0])
      : undefined;
  const httpStatus = wrapped?.success ? wrapped.data.httpStatusCode : undefined;
  if (
    [
      "usageLimitExceeded",
      "rateLimitExceeded",
      "unauthorized",
      "sessionBudgetExceeded",
    ].includes(code ?? "") ||
    httpStatus === 401 ||
    httpStatus === 402 ||
    httpStatus === 429 ||
    /quota|rate.?limit|usage.?limit|billing|credits|unauthoriz|authenticat|log.?in|Codex app-server (exited|is closed)/i.test(
      text,
    )
  )
    return "pause";
  if (httpStatus !== undefined && httpStatus !== null && httpStatus < 500)
    return "stop";
  if (code === "contextWindowExceeded") return "replace";
  if (code && transientCodes.has(code)) return "retry";
  // RPC errors lack CodexErrorInfo. Keep this fallback specific to transport failures.
  if (
    !code &&
    /timed out|ECONNRESET|ETIMEDOUT|server overloaded|connection (reset|closed)/i.test(
      text,
    )
  )
    return "retry";
  return "stop";
}
