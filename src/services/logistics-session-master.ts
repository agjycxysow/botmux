import type { FeedbackSurveyRecord } from './feedback-survey.js';
import type { LogisticsSessionSnapshot, LogisticsSnapshotMessage } from './logistics-session-capture.js';

const DEFAULT_MODEL_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_TRANSCRIPT_CHARS = 12_000;

export interface LogisticsSessionMasterConfig {
  enabled?: boolean;
  larkBase?: {
    appToken: string;
    tableId: string;
    identity?: 'user' | 'bot';
  };
  sqlite?: {
    enabled?: boolean;
    path?: string;
  };
  harness?: {
    rootDir?: string;
  };
  modelTask?: {
    enabled?: boolean;
    timeoutMs?: number;
    model?: string;
  };
  maxTranscriptChars?: number;
}

export interface NormalizedLogisticsSessionMasterConfig {
  enabled: boolean;
  maxTranscriptChars: number;
  modelTask: {
    enabled: boolean;
    timeoutMs: number;
    model?: string;
  };
  larkBase?: {
    appToken: string;
    tableId: string;
    identity: 'user' | 'bot';
  };
  sqlite: {
    enabled: boolean;
    path?: string;
  };
  harness: {
    rootDir?: string;
  };
}

export type LogisticsConfidence = 'high' | 'medium' | 'low';
export type LogisticsResolutionStatus = 'resolved' | 'in_progress' | 'unknown';
export type LogisticsTaggingState = 'pending_capture' | 'tagging' | 'tagged' | 'needs_review';

export interface LogisticsEvidenceAnchor {
  role: 'goal' | 'domain' | 'outcome' | 'open_item' | 'failure';
  messageIndex: number;
}

export interface LogisticsModelTagging {
  businessCategory: string;
  problemType: string;
  resolutionStatus: LogisticsResolutionStatus;
  overallConfidence: LogisticsConfidence;
  needsReview: boolean;
  reviewReason?: string;
  harnessRevision?: string;
  businessReasonCode?: string;
  problemReasonCode?: string;
  resolutionReasonCode?: string;
  evidenceAnchors?: LogisticsEvidenceAnchor[];
  manualReviewStatus?: 'pending';
}

export interface LogisticsSessionMasterRecord {
  masterKey: string;
  larkAppId: string;
  sessionId: string;
  turnId: string;
  surveyId: string;
  settledSurveyIds: string[];
  ratingCount: number;
  chatId: string;
  rootMessageId: string | null;
  respondentOpenId: string;
  title?: string;
  recap?: string;
  answerMessageId?: string;
  surveyStatus: FeedbackSurveyRecord['status'];
  dueAt: number;
  sentAt?: number;
  rating?: number;
  answeredAt?: number;
  ratingState: 'awaiting' | 'rated' | 'timed_out' | 'invalidated';
  transcript?: string;
  transcriptHash?: string;
  captureState?: LogisticsSessionSnapshot['captureState'];
  messages?: LogisticsSnapshotMessage[];
  taggingState: LogisticsTaggingState;
  businessCategory?: string;
  problemType?: string;
  resolutionStatus?: LogisticsResolutionStatus;
  overallConfidence?: LogisticsConfidence;
  needsReview: boolean;
  reviewReason?: string;
  harnessRevision?: string;
  businessReasonCode?: string;
  problemReasonCode?: string;
  resolutionReasonCode?: string;
  evidenceAnchors?: LogisticsEvidenceAnchor[];
  manualReviewStatus?: 'pending';
  modelAttempts: number;
  modelError?: string;
  baseRecordId?: string;
  baseSyncError?: string;
  baseSyncAttempts: number;
  createdAt: number;
  updatedAt: number;
}

export type LogisticsSessionModelTaskRunner = (input: {
  record: LogisticsSessionMasterRecord;
}) => Promise<LogisticsModelTagging>;

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === 'object' ? input as Record<string, unknown> : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function boundedInt(value: unknown, fallback: number, max: number): number {
  return Math.min(positiveInt(value) ?? fallback, max);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeLogisticsSessionMasterConfig(
  input: unknown,
): NormalizedLogisticsSessionMasterConfig {
  const raw = asRecord(input);
  const rawBase = asRecord(raw?.larkBase);
  const rawModelTask = asRecord(raw?.modelTask);
  const rawSqlite = asRecord(raw?.sqlite);
  const rawHarness = asRecord(raw?.harness);
  const appToken = optionalText(rawBase?.appToken);
  const tableId = optionalText(rawBase?.tableId);
  const larkBase = appToken && tableId
    ? { appToken, tableId, identity: rawBase?.identity === 'user' ? 'user' as const : 'bot' as const }
    : undefined;
  const sqlitePath = optionalText(rawSqlite?.path);
  const sqlite = {
    enabled: rawSqlite?.enabled !== false,
    ...(sqlitePath ? { path: sqlitePath } : {}),
  };
  const harnessRoot = optionalText(rawHarness?.rootDir)
    ?? optionalText(process.env.LOGISTICS_CONVERSATION_HARNESS_ROOT);
  return {
    enabled: raw?.enabled === true && (sqlite.enabled || !!larkBase),
    maxTranscriptChars: boundedInt(raw?.maxTranscriptChars, DEFAULT_MAX_TRANSCRIPT_CHARS, 30_000),
    modelTask: {
      enabled: rawModelTask?.enabled === true,
      timeoutMs: boundedInt(rawModelTask?.timeoutMs, DEFAULT_MODEL_TIMEOUT_MS, 10 * 60_000),
      ...(optionalText(rawModelTask?.model) ? { model: optionalText(rawModelTask?.model) } : {}),
    },
    larkBase,
    sqlite,
    harness: { ...(harnessRoot ? { rootDir: harnessRoot } : {}) },
  };
}

export function stableLogisticsSessionMasterKey(
  _larkAppId: string,
  sessionId: string,
  _turnId: string,
  chatId?: string,
): string {
  return `${chatId ?? 'unknown'}:${sessionId}`;
}

export function fallbackLogisticsTagging(reason: string): LogisticsModelTagging {
  return {
    businessCategory: 'LB99',
    problemType: 'LP99',
    resolutionStatus: 'unknown',
    overallConfidence: 'low',
    needsReview: true,
    reviewReason: reason,
  };
}
