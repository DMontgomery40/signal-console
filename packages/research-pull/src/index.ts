export {
  CAPTURE_MODES,
  MARKET_SCOPES,
  ODDS_API_IO_MODES,
  oddsApiIoOptionsSchema,
  pullJobRequestSchema,
} from "./contract";
export type {
  CaptureMode,
  MarketScope,
  OddsApiIoMode,
  OddsApiIoOptions,
  PullJobRequest,
} from "./contract";

export {
  ARTIFACT_CLASSES,
  SOURCE_CAPABILITY_MATRIX,
  SOURCE_CLASSES,
  classToArtifactClass,
  getSourceCapability,
  isKnownSource,
} from "./capability-matrix";
export type { ArtifactClass, SourceCapability, SourceClass } from "./capability-matrix";

export {
  ODDS_API_IO_MARKETS,
  ODDS_API_IO_MULTI_MAX_BOOKMAKERS,
  ODDS_API_IO_MULTI_MAX_EVENT_IDS,
  ODDS_API_IO_SPINE,
  UPDATED_FOLLOW_MAX_SINCE_AGE_SECONDS,
  VALIDATION_CODES,
  validatePullJobRequest,
} from "./validator";
export type {
  ValidateOptions,
  ValidationCode,
  ValidationError,
  ValidationResult,
} from "./validator";

export { EXPORT_SCOPES, exportRequestSchema } from "./export-contract";
export type { ExportRequest, ExportScope } from "./export-contract";

export { EXPORT_VALIDATION_CODES, validateExportRequest } from "./export-validator";
export type {
  ExportValidationCode,
  ExportValidationError,
  ExportValidationResult,
} from "./export-validator";

export { planPullJob } from "./planner";
export type { PlannedOperation, PlannedSource, PullPlan } from "./planner";

export { redactOddsApiIoUrl } from "./redact";

export {
  ARTIFACT_GZIP_THRESHOLD_BYTES,
  JOB_STATES,
  executePullJob,
  redactEvidence,
  resolveJobState,
} from "./executor";
export type {
  CanonicalSyncSummary,
  ExecuteOptions,
  ExecuteResult,
  ExecutorAdapters,
  JobState,
  PullJob,
  SourceResult,
  StoredArtifact,
} from "./executor";
