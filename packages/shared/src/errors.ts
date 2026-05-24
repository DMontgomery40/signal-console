import type { ZodIssue } from "zod";

export const appErrorCodes = [
  "ADAPTER_FAILURE",
  "DATABASE_FAILURE",
  "EVENT_NOT_FOUND",
  "GAME_NOT_FOUND",
  "INTERNAL_ERROR",
  "INSTRUMENT_NOT_FOUND",
  "INVALID_MODE",
  "VALIDATION_ERROR",
] as const;

export type AppErrorCode = (typeof appErrorCodes)[number];

export type ValidationIssueDetail = {
  code?: string;
  message: string;
  path: string;
};

export type AppErrorDetails =
  | Record<string, unknown>
  | ValidationIssueDetail[]
  | undefined;

type AppErrorOptions = {
  cause?: unknown;
  code: AppErrorCode;
  details?: AppErrorDetails;
  message: string;
  operatorHint?: string;
  statusCode: number;
};

export type ApiErrorEnvelope = {
  error: {
    code: AppErrorCode;
    details?: AppErrorDetails;
    message: string;
    operatorHint?: string;
    requestId?: string;
  };
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details?: AppErrorDetails;
  readonly operatorHint?: string;
  readonly statusCode: number;

  constructor(options: AppErrorOptions) {
    super(options.message);
    this.name = new.target.name;
    this.code = options.code;
    this.details = options.details;
    this.operatorHint = options.operatorHint;
    this.statusCode = options.statusCode;

    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export class ValidationAppError extends AppError {
  constructor(details?: AppErrorDetails, operatorHint?: string) {
    super({
      code: "VALIDATION_ERROR",
      details,
      message: "Validation failed.",
      operatorHint:
        operatorHint ??
        "Check the request contract and enum values before retrying this route.",
      statusCode: 400,
    });
  }
}

export class InvalidModeError extends AppError {
  constructor(mode: string | undefined, details?: AppErrorDetails) {
    super({
      code: "INVALID_MODE",
      details,
      message: mode ? `Mode "${mode}" is not supported.` : "Mode is required.",
      operatorHint: "Use the supported operating mode: live.",
      statusCode: 400,
    });
  }
}

export class EventNotFoundError extends AppError {
  constructor(eventId: string, details?: AppErrorDetails) {
    super({
      code: "EVENT_NOT_FOUND",
      details,
      message: `Event "${eventId}" was not found.`,
      operatorHint:
        "Confirm the requested canonical event id exists in persisted live research data before retrying this route.",
      statusCode: 404,
    });
  }
}

export class GameNotFoundError extends AppError {
  constructor(gameId: string, details?: AppErrorDetails) {
    super({
      code: "GAME_NOT_FOUND",
      details,
      message: `Game "${gameId}" was not found.`,
      operatorHint:
        "Confirm the canonical game id exists in the live research store before retrying this route.",
      statusCode: 404,
    });
  }
}

export class InstrumentNotFoundError extends AppError {
  constructor(instrumentId: string, details?: AppErrorDetails) {
    super({
      code: "INSTRUMENT_NOT_FOUND",
      details,
      message: `Instrument "${instrumentId}" was not found.`,
      operatorHint:
        "Confirm the canonical instrument id exists for the requested game before retrying this route.",
      statusCode: 404,
    });
  }
}

export class DatabaseFailureError extends AppError {
  constructor(
    message: string,
    options?: Omit<AppErrorOptions, "code" | "message" | "statusCode">
  ) {
    super({
      ...options,
      code: "DATABASE_FAILURE",
      message,
      statusCode: 500,
    });
  }
}

export class AdapterFailureError extends AppError {
  constructor(
    message: string,
    options?: Omit<AppErrorOptions, "code" | "message" | "statusCode">
  ) {
    super({
      ...options,
      code: "ADAPTER_FAILURE",
      message,
      statusCode: 503,
    });
  }
}

export class InternalAppError extends AppError {
  constructor(cause?: unknown) {
    super({
      cause,
      code: "INTERNAL_ERROR",
      message: "Unexpected internal error.",
      operatorHint:
        "Use the requestId and structured logs to trace the upstream exception boundary.",
      statusCode: 500,
    });
  }
}

export function formatValidationIssues(
  issues: ZodIssue[]
): ValidationIssueDetail[] {
  return issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: issue.path.join("."),
  }));
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  return new InternalAppError(error);
}

export function buildApiErrorEnvelope(
  error: AppError,
  requestId?: string
): ApiErrorEnvelope {
  return {
    error: {
      code: error.code,
      details: error.details,
      message: error.message,
      operatorHint: error.operatorHint,
      requestId,
    },
  };
}

export function serializeErrorForLog(error: unknown) {
  const appError = toAppError(error);
  const cause = (appError as Error & { cause?: unknown }).cause;

  return {
    code: appError.code,
    details: appError.details,
    message: appError.message,
    name: appError.name,
    operatorHint: appError.operatorHint,
    statusCode: appError.statusCode,
    stack: appError.stack,
    cause:
      cause instanceof Error
        ? {
            message: cause.message,
            name: cause.name,
            stack: cause.stack,
          }
        : cause,
  };
}
