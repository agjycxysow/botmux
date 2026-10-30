import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

import { sanitizeLogisticsMessageText } from './logistics-session-capture.js';
import {
  buildLogisticsTopicKey,
  buildLogisticsTopicPublicId,
  classifyLogisticsTopic,
  type LogisticsTopicExclusionReason,
} from './logistics-analysis-topic.js';

const require = createRequire(import.meta.url);

export const LOGISTICS_ANALYSIS_SCHEMA_VERSION = 3;
export const LOGISTICS_ANALYSIS_DEFAULT_LIST_LIMIT = 50;
export const LOGISTICS_ANALYSIS_MAX_LIST_LIMIT = 200;
export const LOGISTICS_ANALYSIS_MAX_LABEL_ATTEMPTS = 3;
export const LOGISTICS_ANALYSIS_LABEL_RUN_RETENTION_MS = 30 * 24 * 60 * 60_000;

export type LogisticsAnalysisScope = 'thread' | 'chat' | 'meeting' | 'special';
export type LogisticsAnalysisSessionStatus = 'active' | 'closed' | 'unknown';
export type LogisticsAnalysisCaptureStatus =
  | 'pending'
  | 'running'
  | 'captured'
  | 'partial'
  | 'failed'
  | 'conflict';
export type LogisticsAnalysisLabelStatus = 'not_ready' | 'pending' | 'running' | 'failed' | 'labeled';
export type LogisticsAnalysisLabelRunStatus = 'running' | 'succeeded' | 'failed' | 'expired' | 'skipped';
export type LogisticsAnalysisMessageSource =
  | 'lark_history'
  | 'botmux_send_marker'
  | 'codex_rollout'
  | 'legacy';
export type LogisticsAnalysisRole = 'user' | 'assistant';
export type LogisticsAnalysisResolutionStatus = 'resolved' | 'in_progress' | 'unknown';
export type LogisticsAnalysisConfidence = 'high' | 'medium' | 'low';

export interface LogisticsAnalysisStoreOptions {
  dataDir: string;
  path?: string;
  readOnly?: boolean;
}

export interface LogisticsAnalysisSessionInput {
  sessionKey?: string;
  botmuxSessionId?: string;
  cliSessionId?: string;
  botId: string;
  botName?: string;
  chatId: string;
  chatName?: string;
  scope: LogisticsAnalysisScope;
  rootMessageId?: string | null;
  larkMessageUrl?: string | null;
  title?: string;
  initiatorId?: string;
  initiatorName?: string;
  sessionStatus?: LogisticsAnalysisSessionStatus;
  createdAt: number;
  lastMessageAt?: number;
  captureStatus?: LogisticsAnalysisCaptureStatus;
  captureError?: string;
  contentHash?: string | null;
  updatedAt?: number;
}

export interface LogisticsAnalysisSession extends LogisticsAnalysisSessionInput {
  sessionKey: string;
  publicId: string;
  rootMessageId: string;
  scope: 'thread';
  sessionStatus: LogisticsAnalysisSessionStatus;
  createdAt: number;
  captureStatus: LogisticsAnalysisCaptureStatus;
  captureVersion: number;
  updatedAt: number;
  contentHash?: string;
}

export interface LogisticsAnalysisMessageInput {
  sessionKey: string;
  messageKey?: string;
  platformMessageId?: string | null;
  role: LogisticsAnalysisRole;
  senderId?: string;
  senderName?: string;
  content: string;
  occurredAt?: number;
  responseKind?: 'final';
  source: LogisticsAnalysisMessageSource;
}

export interface LogisticsAnalysisMessage extends Omit<LogisticsAnalysisMessageInput, 'sessionKey' | 'messageKey'> {
  messageKey: string;
  sessionKey: string;
  contentHash: string;
}

export interface LogisticsAnalysisMessageConflict {
  sessionKey: string;
  platformMessageId: string;
  existingContentHash: string;
  incomingContentHash: string;
  existingSource: LogisticsAnalysisMessageSource;
  incomingSource: LogisticsAnalysisMessageSource;
  resolution: 'replaced_by_trusted_recovery' | 'kept_trusted_recovery' | 'unresolved';
}

export interface LogisticsAnalysisMessageWriteResult {
  total: number;
  inserted: number;
  updated: number;
  unchanged: number;
  missingPlatformMessageIds: number;
  diagnostics: Array<{
    type: 'missing_platform_message_id';
    sessionKey: string;
    messageKey: string;
    contentHash: string;
  }>;
  conflicts: LogisticsAnalysisMessageConflict[];
}

export interface LogisticsAnalysisSyncResult {
  total: number;
  included: number;
  inserted: number;
  updated: number;
  unchanged: number;
  excluded: number;
  excludedByReason: Record<LogisticsTopicExclusionReason, number>;
}

export interface LogisticsAnalysisCaptureResult {
  sessionKey: string;
  contentHash?: string;
  captureStatus: LogisticsAnalysisCaptureStatus;
  invalidatedLabels: number;
}

export interface LogisticsAnalysisPendingCaptureFilters {
  botId?: string;
  limit?: number;
  offset?: number;
}

export interface LogisticsAnalysisPendingLabelFilters {
  botId?: string;
  labelerRevision: string;
  incrementalLabels?: boolean;
  limit?: number;
  offset?: number;
}

export interface LogisticsAnalysisLabelInput {
  lb: string;
  lp: string;
  resolutionStatus: LogisticsAnalysisResolutionStatus;
  confidence: LogisticsAnalysisConfidence;
  needsReview: boolean;
  labelReason?: string;
}

export interface LogisticsAnalysisLabelRunRegistration {
  sessionKey: string;
  contentHash: string;
  labelerRevision: string;
  model?: string;
  now?: number;
  runId?: string;
}

export interface LogisticsAnalysisLabelRunRegistrationResult {
  runId: string;
  attempt: number;
  status: LogisticsAnalysisLabelRunStatus;
  outcome: 'created' | 'reused' | 'skipped';
  alreadyLabeled: boolean;
  remainingAttempts: number;
}

export interface LogisticsAnalysisLabelRunState {
  completed: boolean;
  attempts: number;
  nextAttempt: number;
  remainingAttempts: number;
  latestStatus?: LogisticsAnalysisLabelRunStatus;
}

export interface LogisticsAnalysisLabelCommitInput extends LogisticsAnalysisLabelInput {
  runId: string;
  sessionKey: string;
  contentHash: string;
  labelerRevision: string;
  labeledAt?: number;
}

export interface LogisticsAnalysisLabelCommitResult {
  sessionKey: string;
  contentHash: string;
  labelerRevision: string;
  labeledAt: number;
}

export interface LogisticsAnalysisLabelRunFailureInput {
  runId: string;
  error: string;
  completedAt?: number;
}

export interface LogisticsAnalysisLabelRunExpirationInput {
  runId: string;
  reason: string;
  completedAt?: number;
}

export interface LogisticsAnalysisCleanupResult {
  cutoff: number;
  deleted: number;
}

export interface LogisticsAnalysisFilters {
  labelerRevision: string;
  from?: string | number;
  to?: string | number;
  botId?: string;
  scope?: 'thread';
  sessionStatus?: LogisticsAnalysisSessionStatus;
  captureStatus?: LogisticsAnalysisCaptureStatus;
  labelStatus?: LogisticsAnalysisLabelStatus;
  lb?: string;
  lp?: string;
  resolutionStatus?: LogisticsAnalysisResolutionStatus;
  needsReview?: boolean;
}

export interface LogisticsAnalysisListItem {
  topicPublicId: string;
  title: string | null;
  botId: string;
  botName: string | null;
  scope: 'thread';
  captureStatus: LogisticsAnalysisCaptureStatus;
  labelStatus: LogisticsAnalysisLabelStatus;
  lb: string | null;
  lp: string | null;
  resolutionStatus: LogisticsAnalysisResolutionStatus | null;
  confidence: LogisticsAnalysisConfidence | null;
  needsReview: boolean;
  lastMessageAt: number | null;
  dataTime: number;
}

export interface LogisticsAnalysisListResult {
  items: LogisticsAnalysisListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface LogisticsAnalysisSummary {
  totalTopics: number;
  capturedTopics: number;
  capturePending: number;
  captureRunning: number;
  capturePartial: number;
  captureFailed: number;
  captureConflict: number;
  labeledTopics: number;
  labelPending: number;
  labelRunning: number;
  labelFailed: number;
  messages: number;
  resolved: number;
  inProgress: number;
  unknown: number;
  needsReview: number;
  labelCoverage: {
    requestedRevision: string;
    currentRevisionTopics: number;
    crossRevisionManualTopics: number;
    previousMachineRevisionTopics: number;
    unlabeledTopics: number;
  };
  lastDataTime: number | null;
  categories: LogisticsAnalysisCategorySummary[];
}

export interface LogisticsAnalysisCategorySummary {
  taskType: string;
  name: string;
  topicCount: number;
  resolvedCount: number;
  inProgressCount: number;
  unknownCount: number;
  resolutionRate: number | null;
}

export interface LogisticsAnalysisTrendPoint {
  day: string;
  totalTopics: number;
  capturedTopics: number;
  labeledTopics: number;
  resolved: number;
  inProgress: number;
  unknown: number;
}

export interface LogisticsAnalysisDistributionItem {
  key: string;
  count: number;
}

export interface LogisticsAnalysisDistributions {
  lb: LogisticsAnalysisDistributionItem[];
  lp: LogisticsAnalysisDistributionItem[];
  resolution: LogisticsAnalysisDistributionItem[];
  captureStatus: LogisticsAnalysisDistributionItem[];
  labelStatus: LogisticsAnalysisDistributionItem[];
}

export interface LogisticsAnalysisDetail extends LogisticsAnalysisListItem {
  chatName: string | null;
  larkMessageUrl: string | null;
  initiatorId: string | null;
  initiatorName: string | null;
  captureError: string | null;
  contentHash: string | null;
  captureVersion: number;
  labelerRevision: string | null;
  labelReason: string | null;
  messages: Array<{
    platformMessageId: string | null;
    role: LogisticsAnalysisRole;
    senderName: string | null;
    content: string;
    occurredAt: number | null;
    responseKind: 'final' | null;
    source: LogisticsAnalysisMessageSource;
  }>;
}

type SqlValue = string | number | null;
type QueryRow = Record<string, unknown>;

const TABLES = new Set([
  'sessions', 'messages', 'labels', 'label_runs',
  'logistics_review_batches', 'logistics_review_topics',
]);
const REQUIRED_TABLES = new Set(['sessions', 'messages', 'labels', 'label_runs']);
const CAPTURE_STATUSES = new Set<LogisticsAnalysisCaptureStatus>([
  'pending', 'running', 'captured', 'partial', 'failed', 'conflict',
]);
const LABEL_STATUSES = new Set<LogisticsAnalysisLabelStatus>([
  'not_ready', 'pending', 'running', 'failed', 'labeled',
]);
const SOURCES = new Set<LogisticsAnalysisMessageSource>([
  'lark_history', 'botmux_send_marker', 'codex_rollout', 'legacy',
]);
const BUSINESS_LABELS = new Set(['LB01', 'LB02', 'LB03', 'LB04', 'LB05', 'LB06', 'LB99']);
const PROBLEM_LABELS = new Set(['LP01', 'LP02', 'LP03', 'LP04', 'LP05', 'LP06', 'LP99']);
const PROBLEM_LABEL_NAMES: Record<string, string> = {
  LP01: '前端埋点查询',
  LP02: '业务数据查询',
  LP03: '线上问题排查',
  LP04: '业务功能咨询',
  LP05: '商家反馈分析',
  LP06: '研发基建',
  LP99: '其他',
};

function manualSourceSql(alias: string): string {
  return `CASE WHEN json_valid(${alias}.label_reason) THEN json_extract(${alias}.label_reason,'$.source') END`;
}

function historicalManualRevisionSql(alias: string): string {
  return `(${alias}.labeler_revision GLOB 'manual-doc:*'
    OR ${alias}.labeler_revision GLOB 'manual-approval:*'
    OR ${alias}.labeler_revision GLOB 'pre-manual-doc:*'
    OR ${alias}.labeler_revision GLOB 'pre-manual-approval:*')`;
}

function validManualLabelSql(alias: string): string {
  const canonicalRevision = `(length(${alias}.labeler_revision)=64
    AND ${alias}.labeler_revision NOT GLOB '*[^a-f0-9]*')`;
  const reason = `CASE WHEN json_valid(${alias}.label_reason) THEN ${alias}.label_reason ELSE '{}' END`;
  return `(${alias}.needs_review=0
    AND ${alias}.lb IN (${[...BUSINESS_LABELS].map(id => `'${id}'`).join(',')})
    AND ${alias}.lp IN (${[...PROBLEM_LABELS].map(id => `'${id}'`).join(',')})
    AND ${alias}.resolution_status IN ('resolved','in_progress')
    AND (
      (${manualSourceSql(alias)}='manual_doc_review'
        AND (${alias}.labeler_revision GLOB 'manual-doc:*' OR ${canonicalRevision}))
      OR (${manualSourceSql(alias)}='manual_taxonomy_approval'
        AND ${alias}.lp='LP06'
        AND json_extract(${reason},'$.canonicalLp')=${alias}.lp
        AND json_extract(${reason},'$.canonicalResolutionStatus')=${alias}.resolution_status
        AND json_extract(${reason},'$.approvalRevision') GLOB 'manual-approval:lp06:*'
        AND (${alias}.labeler_revision=json_extract(${reason},'$.approvalRevision') OR ${canonicalRevision}))
    ))`;
}

function machineLabelSql(alias: string): string {
  return `(NOT ${historicalManualRevisionSql(alias)}
    AND COALESCE(${manualSourceSql(alias)},'') NOT IN ('manual_doc_review','manual_taxonomy_approval'))`;
}

function required(value: string | null | undefined, name: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) throw new Error(`analysis_${name}_required`);
  return normalized;
}

function optionalText(value: string | null | undefined, max: number, redact = false): string | null {
  if (value === undefined || value === null) return null;
  const normalized = redact ? sanitizeLogisticsMessageText(value) : value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return Array.from(normalized).slice(0, max).join('') || null;
}

function timestamp(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`analysis_${name}_invalid`);
  return value;
}

function messageContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function computeLogisticsAnalysisContentHash(
  messages: ReadonlyArray<Pick<LogisticsAnalysisMessage, 'role' | 'content'>>,
): string | undefined {
  if (messages.length === 0) return undefined;
  return createHash('sha256')
    .update(JSON.stringify(messages.map(message => ({ role: message.role, content: message.content }))))
    .digest('hex');
}

export function buildLogisticsAnalysisMessageKey(
  sessionKey: string,
  platformMessageId: string | null | undefined,
  fallback: { role: LogisticsAnalysisRole; content: string; occurredAt?: number },
): string {
  const key = platformMessageId?.trim()
    ? `${sessionKey}\u0000platform\u0000${platformMessageId.trim()}`
    : `${sessionKey}\u0000fallback\u0000${fallback.role}\u0000${fallback.occurredAt ?? ''}\u0000${fallback.content}`;
  return `msg_${createHash('sha256').update(key).digest('hex')}`;
}

export function logisticsMessageSourceRank(source: LogisticsAnalysisMessageSource): number {
  if (source === 'codex_rollout') return 3;
  if (source === 'botmux_send_marker') return 2;
  if (source === 'lark_history') return 1;
  return 0;
}

export function isTrustedLogisticsRecoveryMessage(input: {
  role: LogisticsAnalysisRole;
  source: LogisticsAnalysisMessageSource;
  responseKind?: 'final';
  content: string;
}): boolean {
  return input.role === 'assistant'
    && input.responseKind === 'final'
    && (input.source === 'codex_rollout' || input.source === 'botmux_send_marker')
    && !isLogisticsPlaceholderContent(input.content);
}

export function isLogisticsPlaceholderContent(content: string): boolean {
  return /^(?:BOTMUX_NOTHING_TO_SEND|\[图片\]请升级至最新版本客户端，以查看内容|\[卡片:[\s\S]*\]|工作中[\s\S]*|等待输入[\s\S]*|显示输出[\s\S]*|打开(?:可操作 )?Web 终端[\s\S]*|Ask Codex[\s\S]*)$/i.test(
    content.trim(),
  );
}

export function canPreferLogisticsRecoveryMessage(
  incoming: {
    role: LogisticsAnalysisRole;
    source: LogisticsAnalysisMessageSource;
    responseKind?: 'final';
    content: string;
  },
  existing: {
    role: LogisticsAnalysisRole;
    source: LogisticsAnalysisMessageSource;
    responseKind?: 'final';
    content: string;
  },
): boolean {
  return isTrustedLogisticsRecoveryMessage(incoming)
    && isLogisticsPlaceholderContent(existing.content)
    && !isLogisticsPlaceholderContent(incoming.content);
}

function valueEqual(left: unknown, right: unknown): boolean {
  return (left ?? null) === (right ?? null);
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function stringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function booleanValue(value: unknown): boolean {
  return Number(value ?? 0) === 1;
}

function parseDateBoundary(value: string | number | undefined, end: boolean): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('analysis_invalid_date');
    return value;
  }
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = Date.parse(dayOnly ? `${value}T00:00:00+08:00` : value);
  if (!Number.isFinite(parsed)) throw new Error(`analysis_invalid_date:${value}`);
  return dayOnly && end ? parsed + 24 * 60 * 60_000 : parsed;
}

function dayInShanghai(value: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const map = new Map(parts.map(part => [part.type, part.value]));
  return `${map.get('year')}-${map.get('month')}-${map.get('day')}`;
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? LOGISTICS_ANALYSIS_DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LOGISTICS_ANALYSIS_MAX_LIST_LIMIT) {
    throw new Error(`analysis_invalid_limit:${limit}`);
  }
  return limit;
}

function normalizeOffset(value: number | undefined): number {
  const offset = value ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`analysis_invalid_offset:${offset}`);
  return offset;
}

function shouldAdvanceCaptureVersion(
  previous: LogisticsAnalysisCaptureStatus,
  next: LogisticsAnalysisCaptureStatus,
): boolean {
  if (previous === next) return false;
  if (next === 'conflict' || previous === 'conflict') return true;
  return (previous === 'partial' && next === 'captured')
    || (previous === 'captured' && next === 'partial');
}

export class LogisticsAnalysisStore {
  readonly path: string;
  private readonly db: DatabaseSyncType;
  private readonly writable: boolean;
  private readonly hasManualResolutionStatus: boolean;

  constructor(options: LogisticsAnalysisStoreOptions) {
    this.path = resolve(options.path ?? join(options.dataDir, 'logistics-analysis.sqlite'));
    this.writable = !options.readOnly;
    if (this.writable) mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    this.db = new DatabaseSync(this.path, options.readOnly ? { readOnly: true } : {});
    this.db.exec('PRAGMA busy_timeout=5000;');
    this.db.exec('PRAGMA foreign_keys=ON;');
    if (this.writable) this.ensureSchema();
    else this.verifySchema();
    this.hasManualResolutionStatus = this.db.prepare('PRAGMA table_info(sessions)').all()
      .some(row => row.name === 'manual_resolution_status');
    this.secureFiles();
  }

  private manualInvalidSql(alias: string): string {
    return this.hasManualResolutionStatus ? `COALESCE(${alias}.manual_resolution_status='invalid',0)` : '0';
  }

  close(): void {
    this.secureFiles();
    this.db.close();
    this.secureFiles();
  }

  private secureFiles(): void {
    if (!this.writable) return;
    for (const file of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      if (!existsSync(file)) continue;
      try { chmodSync(file, 0o600); } catch { /* directory permissions remain authoritative */ }
    }
  }

  private assertWritable(): void {
    if (!this.writable) throw new Error('analysis_store_read_only');
  }

  private transaction<T>(fn: () => T): T {
    this.assertWritable();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      this.secureFiles();
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch { /* preserve original error */ }
      throw error;
    }
  }

  private readTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch { /* preserve original error */ }
      throw error;
    }
  }

  private ensureSchema(): void {
    const existing = (this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all() as Array<{ name: string }>).map(row => row.name);
    const unsupported = existing.filter(name => !TABLES.has(name));
    if (unsupported.length) throw new Error(`analysis_database_not_four_table:${unsupported.join(',')}`);
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version?: number }).user_version ?? 0);
    if (version > LOGISTICS_ANALYSIS_SCHEMA_VERSION) {
      throw new Error(`analysis_schema_version_unsupported:${version}`);
    }
    const labelsSql = (this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='labels'",
    ).get() as { sql?: string } | undefined)?.sql ?? '';
    if (labelsSql.includes('session_key TEXT PRIMARY KEY')) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE labels RENAME TO labels_v2;
        CREATE TABLE labels (
          session_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
          content_hash TEXT NOT NULL,
          labeler_revision TEXT NOT NULL,
          labeled_at INTEGER NOT NULL,
          lb TEXT NOT NULL,
          lp TEXT NOT NULL,
          resolution_status TEXT NOT NULL CHECK(resolution_status IN ('resolved','in_progress','unknown')),
          confidence TEXT NOT NULL CHECK(confidence IN ('high','medium','low')),
          needs_review INTEGER NOT NULL CHECK(needs_review IN (0,1)),
          label_reason TEXT,
          capture_version INTEGER NOT NULL,
          PRIMARY KEY(session_key,content_hash,capture_version,labeler_revision)
        );
        INSERT INTO labels SELECT * FROM labels_v2;
        DROP TABLE labels_v2;
        COMMIT;
      `);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_key TEXT PRIMARY KEY,
        botmux_session_id TEXT,
        bot_id TEXT NOT NULL,
        bot_name TEXT,
        cli_session_id TEXT,
        chat_id TEXT NOT NULL,
        chat_name TEXT,
        scope TEXT NOT NULL CHECK(scope IN ('thread','chat','meeting','special')),
        root_message_id TEXT,
        lark_message_url TEXT,
        title TEXT,
        initiator_id TEXT,
        initiator_name TEXT,
        session_status TEXT NOT NULL CHECK(session_status IN ('active','closed','unknown')),
        created_at INTEGER NOT NULL,
        last_message_at INTEGER,
        capture_status TEXT NOT NULL CHECK(capture_status IN ('pending','running','captured','partial','failed','conflict')),
        capture_error TEXT,
        content_hash TEXT,
        capture_version INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_bot_time ON sessions(bot_id,updated_at,session_key);
      CREATE INDEX IF NOT EXISTS sessions_capture ON sessions(capture_status,updated_at,session_key);
      CREATE TABLE IF NOT EXISTS messages (
        message_key TEXT PRIMARY KEY,
        session_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
        platform_message_id TEXT,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        sender_id TEXT,
        sender_name TEXT,
        content TEXT NOT NULL,
        occurred_at INTEGER,
        response_kind TEXT CHECK(response_kind IS NULL OR response_kind='final'),
        source TEXT NOT NULL CHECK(source IN ('lark_history','botmux_send_marker','codex_rollout','legacy')),
        content_hash TEXT NOT NULL,
        captured_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS messages_platform
        ON messages(session_key,platform_message_id)
        WHERE platform_message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS messages_session_time ON messages(session_key,occurred_at,message_key);
      CREATE TABLE IF NOT EXISTS labels (
        session_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        labeler_revision TEXT NOT NULL,
        labeled_at INTEGER NOT NULL,
        lb TEXT NOT NULL,
        lp TEXT NOT NULL,
        resolution_status TEXT NOT NULL CHECK(resolution_status IN ('resolved','in_progress','unknown')),
        confidence TEXT NOT NULL CHECK(confidence IN ('high','medium','low')),
        needs_review INTEGER NOT NULL CHECK(needs_review IN (0,1)),
        label_reason TEXT,
        capture_version INTEGER NOT NULL,
        PRIMARY KEY(session_key,content_hash,capture_version,labeler_revision)
      );
      CREATE INDEX IF NOT EXISTS labels_revision ON labels(labeler_revision,content_hash);
      CREATE TABLE IF NOT EXISTS label_runs (
        run_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        labeler_revision TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','expired','skipped')),
        error TEXT,
        attempt INTEGER NOT NULL CHECK(attempt BETWEEN 0 AND 3),
        capture_version INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        UNIQUE(session_key,content_hash,labeler_revision,attempt)
      );
      CREATE INDEX IF NOT EXISTS label_runs_version ON label_runs(session_key,content_hash,labeler_revision,attempt);
    `);
    this.db.exec(`PRAGMA user_version=${LOGISTICS_ANALYSIS_SCHEMA_VERSION};`);
  }

  private verifySchema(): void {
    const existing = (this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all() as Array<{ name: string }>).map(row => row.name);
    const unsupported = existing.filter(name => !TABLES.has(name));
    if (unsupported.length || [...REQUIRED_TABLES].some(name => !existing.includes(name))) {
      throw new Error(`analysis_database_not_four_table:${unsupported.join(',') || 'missing_table'}`);
    }
  }

  syncSessions(rows: ReadonlyArray<LogisticsAnalysisSessionInput>): LogisticsAnalysisSyncResult {
    const excludedByReason: Record<LogisticsTopicExclusionReason, number> = {
      special_session: 0,
      chat_scope: 0,
      non_thread_scope: 0,
      missing_root: 0,
    };
    const included = rows.filter(row => {
      const reason = classifyLogisticsTopic({
        scope: row.scope,
        rootMessageId: row.rootMessageId,
        specialSession: row.scope === 'special',
      });
      if (reason) excludedByReason[reason] += 1;
      return !reason;
    });
    const write = this.transaction(() => {
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      for (const row of included) {
        const outcome = this.upsertSessionInside(row);
        if (outcome === 'inserted') inserted += 1;
        else if (outcome === 'updated') updated += 1;
        else unchanged += 1;
      }
      return { inserted, updated, unchanged };
    });
    return {
      total: rows.length,
      included: included.length,
      ...write,
      excluded: rows.length - included.length,
      excludedByReason,
    };
  }

  private normalizedSession(row: LogisticsAnalysisSessionInput): {
    sessionKey: string;
    botmuxSessionId: string | null;
    cliSessionId: string | null;
    botId: string;
    botName: string | null;
    chatId: string;
    chatName: string | null;
    rootMessageId: string;
    larkMessageUrl: string | null;
    title: string | null;
    initiatorId: string | null;
    initiatorName: string | null;
    sessionStatus: LogisticsAnalysisSessionStatus;
    createdAt: number;
    lastMessageAt: number | null;
    captureStatus: LogisticsAnalysisCaptureStatus;
    captureError: string | null;
    contentHash: string | null;
    updatedAt: number;
    hasCaptureStatus: boolean;
  } {
    const botId = required(row.botId, 'bot_id');
    const chatId = required(row.chatId, 'chat_id');
    const rootMessageId = required(row.rootMessageId, 'root_message_id');
    const sessionKey = buildLogisticsTopicKey({ botId, chatId, rootMessageId });
    if (row.sessionKey && row.sessionKey !== sessionKey) throw new Error('analysis_session_key_mismatch');
    const createdAt = timestamp(row.createdAt, 'created_at');
    if (createdAt === undefined) throw new Error('analysis_created_at_required');
    const lastMessageAt = timestamp(row.lastMessageAt, 'last_message_at') ?? null;
    const updatedAt = timestamp(row.updatedAt, 'updated_at')
      ?? Math.max(createdAt, lastMessageAt ?? 0);
    const captureStatus = row.captureStatus ?? 'pending';
    if (!CAPTURE_STATUSES.has(captureStatus)) throw new Error(`analysis_capture_status_invalid:${captureStatus}`);
    return {
      sessionKey,
      botmuxSessionId: optionalText(row.botmuxSessionId, 256),
      cliSessionId: optionalText(row.cliSessionId, 256),
      botId,
      botName: optionalText(row.botName, 200, true),
      chatId,
      chatName: optionalText(row.chatName, 200, true),
      rootMessageId,
      larkMessageUrl: optionalText(row.larkMessageUrl, 2_048),
      title: optionalText(row.title, 200, true),
      initiatorId: optionalText(row.initiatorId, 256),
      initiatorName: optionalText(row.initiatorName, 200, true),
      sessionStatus: row.sessionStatus ?? 'unknown',
      createdAt,
      lastMessageAt,
      captureStatus,
      captureError: optionalText(row.captureError, 500, true),
      contentHash: optionalText(row.contentHash, 128),
      updatedAt,
      hasCaptureStatus: row.captureStatus !== undefined,
    };
  }

  private upsertSessionInside(row: LogisticsAnalysisSessionInput): 'inserted' | 'updated' | 'unchanged' {
    const normalized = this.normalizedSession(row);
    const existing = this.db.prepare('SELECT * FROM sessions WHERE session_key=?').get(normalized.sessionKey) as QueryRow | undefined;
    if (!existing) {
      this.db.prepare(`
        INSERT INTO sessions (
          session_key,botmux_session_id,bot_id,bot_name,cli_session_id,chat_id,chat_name,scope,
          root_message_id,lark_message_url,title,initiator_id,initiator_name,session_status,
          created_at,last_message_at,capture_status,capture_error,content_hash,capture_version,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        normalized.sessionKey, normalized.botmuxSessionId, normalized.botId, normalized.botName,
        normalized.cliSessionId, normalized.chatId, normalized.chatName, 'thread', normalized.rootMessageId,
        normalized.larkMessageUrl, normalized.title, normalized.initiatorId, normalized.initiatorName,
        normalized.sessionStatus, normalized.createdAt, normalized.lastMessageAt, normalized.captureStatus,
        normalized.captureError, normalized.contentHash, 0, normalized.updatedAt,
      );
      return 'inserted';
    }
    const existingUpdatedAt = numberOrNull(existing.updated_at) ?? 0;
    const isLatest = normalized.updatedAt >= existingUpdatedAt;
    const existingStatus = String(existing.capture_status) as LogisticsAnalysisCaptureStatus;
    const status = normalized.hasCaptureStatus
      && !(normalized.captureStatus === 'pending'
        && ['captured', 'partial', 'conflict'].includes(existingStatus))
      ? normalized.captureStatus
      : existingStatus;
    const statusChanged = status !== existingStatus;
    const captureVersion = Number(existing.capture_version ?? 0)
      + (statusChanged && shouldAdvanceCaptureVersion(existingStatus, status) ? 1 : 0);
    const next: Record<string, SqlValue> = {
      botmux_session_id: isLatest && normalized.botmuxSessionId !== null
        ? normalized.botmuxSessionId : stringOrNull(existing.botmux_session_id),
      bot_id: normalized.botId,
      bot_name: normalized.botName ?? stringOrNull(existing.bot_name),
      cli_session_id: isLatest && normalized.cliSessionId !== null
        ? normalized.cliSessionId : stringOrNull(existing.cli_session_id),
      chat_id: normalized.chatId,
      chat_name: normalized.chatName ?? stringOrNull(existing.chat_name),
      root_message_id: normalized.rootMessageId,
      lark_message_url: normalized.larkMessageUrl ?? stringOrNull(existing.lark_message_url),
      title: normalized.title ?? stringOrNull(existing.title),
      initiator_id: normalized.initiatorId ?? stringOrNull(existing.initiator_id),
      initiator_name: normalized.initiatorName ?? stringOrNull(existing.initiator_name),
      session_status: normalized.sessionStatus,
      created_at: Math.min(normalized.createdAt, numberOrNull(existing.created_at) ?? normalized.createdAt),
      last_message_at: Math.max(normalized.lastMessageAt ?? 0, numberOrNull(existing.last_message_at) ?? 0) || null,
      capture_status: status,
      capture_error: normalized.captureError ?? (status === 'captured' ? null : stringOrNull(existing.capture_error)),
      content_hash: normalized.contentHash ?? stringOrNull(existing.content_hash),
      capture_version: captureVersion,
      updated_at: statusChanged && shouldAdvanceCaptureVersion(existingStatus, status)
        ? Math.max(normalized.updatedAt, existingUpdatedAt + 1) : Math.max(normalized.updatedAt, existingUpdatedAt),
    };
    const changed = Object.entries(next).some(([key, value]) => !valueEqual(value, existing[key]));
    if (!changed) return 'unchanged';
    this.db.prepare(`
      UPDATE sessions SET
        botmux_session_id=?,bot_id=?,bot_name=?,cli_session_id=?,chat_id=?,chat_name=?,root_message_id=?,
        lark_message_url=?,title=?,initiator_id=?,initiator_name=?,session_status=?,created_at=?,
        last_message_at=?,capture_status=?,capture_error=?,content_hash=?,capture_version=?,updated_at=?
      WHERE session_key=?
    `).run(
      next.botmux_session_id, next.bot_id, next.bot_name, next.cli_session_id, next.chat_id,
      next.chat_name, next.root_message_id, next.lark_message_url, next.title, next.initiator_id,
      next.initiator_name, next.session_status, next.created_at, next.last_message_at, next.capture_status,
      next.capture_error, next.content_hash, next.capture_version, next.updated_at, normalized.sessionKey,
    );
    return 'updated';
  }

  getSession(sessionKey: string): LogisticsAnalysisSession | undefined {
    const normalized = required(sessionKey, 'session_key');
    return this.readTransaction(() => {
      const row = this.db.prepare('SELECT * FROM sessions WHERE session_key=?').get(normalized) as QueryRow | undefined;
      return row ? this.sessionFromRow(row) : undefined;
    });
  }

  upsertMessages(
    messages: ReadonlyArray<LogisticsAnalysisMessageInput>,
    capturedAt = Date.now(),
  ): LogisticsAnalysisMessageWriteResult {
    timestamp(capturedAt, 'captured_at');
    return this.transaction(() => {
      const result: LogisticsAnalysisMessageWriteResult = {
        total: messages.length,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        missingPlatformMessageIds: 0,
        diagnostics: [],
        conflicts: [],
      };
      const touched = new Set<string>();
      for (const input of messages) {
        const sessionKey = required(input.sessionKey, 'session_key');
        const session = this.db.prepare('SELECT session_key FROM sessions WHERE session_key=?').get(sessionKey);
        if (!session) throw new Error(`analysis_session_not_found:${sessionKey}`);
        const normalized = this.normalizedMessage(input);
        if (!normalized.platformMessageId) {
          result.missingPlatformMessageIds += 1;
          result.diagnostics.push({
            type: 'missing_platform_message_id',
            sessionKey,
            messageKey: normalized.messageKey,
            contentHash: normalized.contentHash,
          });
        }
        const outcome = this.upsertMessageInside(normalized, capturedAt, result.conflicts);
        result[outcome] += 1;
        touched.add(sessionKey);
      }
      for (const sessionKey of touched) this.refreshSessionContentInside(sessionKey, capturedAt);
      return result;
    });
  }

  private normalizedMessage(input: LogisticsAnalysisMessageInput): LogisticsAnalysisMessage {
    if (!SOURCES.has(input.source)) throw new Error(`analysis_message_source_invalid:${input.source}`);
    const sessionKey = required(input.sessionKey, 'session_key');
    const content = sanitizeLogisticsMessageText(input.content);
    if (!content) throw new Error('analysis_message_content_empty');
    const occurredAt = timestamp(input.occurredAt, 'occurred_at');
    const platformMessageId = optionalText(input.platformMessageId, 512);
    const contentHash = messageContentHash(content);
    const messageKey = input.messageKey
      ? required(input.messageKey, 'message_key')
      : platformMessageId
      ? buildLogisticsAnalysisMessageKey(sessionKey, platformMessageId, {
        role: input.role,
        content,
        ...(occurredAt === undefined ? {} : { occurredAt }),
      })
      : `msg_${randomUUID().replace(/-/g, '')}`;
    return {
      messageKey,
      sessionKey,
      platformMessageId,
      role: input.role,
      senderId: optionalText(input.senderId, 256) ?? undefined,
      senderName: optionalText(input.senderName, 200, true) ?? undefined,
      content,
      ...(occurredAt === undefined ? {} : { occurredAt }),
      ...(input.responseKind ? { responseKind: input.responseKind } : {}),
      source: input.source,
      contentHash,
    };
  }

  private upsertMessageInside(
    message: LogisticsAnalysisMessage,
    capturedAt: number,
    conflicts: LogisticsAnalysisMessageConflict[],
  ): 'inserted' | 'updated' | 'unchanged' {
    const existing = (message.platformMessageId
      ? this.db.prepare(`
        SELECT * FROM messages WHERE session_key=? AND platform_message_id=?
      `).get(message.sessionKey, message.platformMessageId)
      : this.db.prepare('SELECT * FROM messages WHERE message_key=?').get(message.messageKey)) as QueryRow | undefined;
    if (!existing) {
      this.db.prepare(`
        INSERT INTO messages (
          message_key,session_key,platform_message_id,role,sender_id,sender_name,content,
          occurred_at,response_kind,source,content_hash,captured_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        message.messageKey, message.sessionKey, message.platformMessageId ?? null, message.role,
        message.senderId ?? null, message.senderName ?? null, message.content, message.occurredAt ?? null,
        message.responseKind ?? null, message.source, message.contentHash, capturedAt,
      );
      return 'inserted';
    }
    const existingSource = String(existing.source) as LogisticsAnalysisMessageSource;
    const existingHash = String(existing.content_hash);
    if (existingHash !== message.contentHash) {
      const existingInput = {
        role: String(existing.role) as LogisticsAnalysisRole,
        source: existingSource,
        responseKind: existing.response_kind === 'final' ? 'final' : undefined,
        content: String(existing.content),
      } as const;
      const incomingInput = {
        role: message.role,
        source: message.source,
        ...(message.responseKind ? { responseKind: message.responseKind } : {}),
        content: message.content,
      } as const;
      const incomingCanReplace = canPreferLogisticsRecoveryMessage(incomingInput, existingInput);
      const existingCanReplace = canPreferLogisticsRecoveryMessage(existingInput, incomingInput);
      const conflict: LogisticsAnalysisMessageConflict = {
        sessionKey: message.sessionKey,
        platformMessageId: required(message.platformMessageId, 'platform_message_id'),
        existingContentHash: existingHash,
        incomingContentHash: message.contentHash,
        existingSource,
        incomingSource: message.source,
        resolution: incomingCanReplace
          ? 'replaced_by_trusted_recovery'
          : existingCanReplace
          ? 'kept_trusted_recovery'
          : 'unresolved',
      };
      conflicts.push(conflict);
      if (conflict.resolution === 'replaced_by_trusted_recovery') {
        this.db.prepare(`
          UPDATE messages SET
            message_key=?,role=?,sender_id=COALESCE(?,sender_id),sender_name=COALESCE(?,sender_name),
            content=?,occurred_at=COALESCE(?,occurred_at),response_kind=COALESCE(?,response_kind),
            source=?,content_hash=?,captured_at=MAX(captured_at,?)
          WHERE message_key=?
        `).run(
          message.messageKey, message.role, message.senderId ?? null, message.senderName ?? null,
          message.content, message.occurredAt ?? null, message.responseKind ?? null, message.source,
          message.contentHash, capturedAt, String(existing.message_key),
        );
        return 'updated';
      }
      return 'unchanged';
    }
    const nextSource = logisticsMessageSourceRank(message.source) > logisticsMessageSourceRank(existingSource)
      ? message.source : existingSource;
    const next: Record<string, SqlValue> = {
      sender_id: message.senderId ?? stringOrNull(existing.sender_id),
      sender_name: message.senderName ?? stringOrNull(existing.sender_name),
      occurred_at: numberOrNull(existing.occurred_at) ?? message.occurredAt ?? null,
      response_kind: message.responseKind ?? stringOrNull(existing.response_kind),
      source: nextSource,
      captured_at: Math.max(capturedAt, numberOrNull(existing.captured_at) ?? capturedAt),
    };
    const changed = Object.entries(next).some(([key, value]) => !valueEqual(value, existing[key]));
    if (!changed) return 'unchanged';
    this.db.prepare(`
      UPDATE messages SET
        sender_id=?,sender_name=?,occurred_at=?,response_kind=?,source=?,captured_at=?
      WHERE message_key=?
    `).run(
      next.sender_id, next.sender_name, next.occurred_at, next.response_kind, next.source,
      next.captured_at, String(existing.message_key),
    );
    return 'updated';
  }

  private refreshSessionContentInside(sessionKey: string, at: number): {
    contentHash?: string;
    invalidatedLabels: number;
    changed: boolean;
    captureVersion: number;
  } {
    const rows = this.db.prepare(`
      SELECT role,content FROM messages WHERE session_key=?
      ORDER BY occurred_at IS NULL,occurred_at,message_key
    `).all(sessionKey) as Array<{ role: LogisticsAnalysisRole; content: string }>;
    const nextHash = computeLogisticsAnalysisContentHash(rows);
    const existing = this.db.prepare(
      'SELECT content_hash,last_message_at,updated_at,capture_version FROM sessions WHERE session_key=?',
    ).get(sessionKey) as QueryRow | undefined;
    if (!existing) throw new Error(`analysis_session_not_found:${sessionKey}`);
    const oldHash = stringOrNull(existing.content_hash);
    const changed = oldHash !== (nextHash ?? null);
    const oldCaptureVersion = Number(existing.capture_version ?? 0);
    const captureVersion = changed ? oldCaptureVersion + 1 : oldCaptureVersion;
    let invalidatedLabels = 0;
    if (changed) {
      const preserve = `(${historicalManualRevisionSql('labels')} OR COALESCE(${validManualLabelSql('labels')},0))`;
      const deleteResult = nextHash
        ? this.db.prepare(`DELETE FROM labels WHERE session_key=? AND content_hash<>? AND NOT ${preserve}`)
          .run(sessionKey, nextHash)
        : this.db.prepare(`DELETE FROM labels WHERE session_key=? AND NOT ${preserve}`).run(sessionKey);
      invalidatedLabels = Number(deleteResult.changes ?? 0);
    }
    const lastMessageAt = this.db.prepare(
      'SELECT MAX(occurred_at) last_message_at FROM messages WHERE session_key=?',
    ).get(sessionKey) as { last_message_at?: number | null };
    const observedLastMessageAt = numberOrNull(lastMessageAt.last_message_at);
    const existingLastMessageAt = numberOrNull(existing.last_message_at);
    const nextLastMessageAt = observedLastMessageAt === null
      ? existingLastMessageAt
      : existingLastMessageAt === null
      ? observedLastMessageAt
      : Math.max(existingLastMessageAt, observedLastMessageAt);
    const updatedAt = changed
      ? Math.max(at, Number(existing.updated_at ?? 0) + 1)
      : Math.max(at, Number(existing.updated_at ?? 0));
    this.db.prepare(`
      UPDATE sessions SET
        content_hash=?,last_message_at=?,capture_version=?,updated_at=?
      WHERE session_key=?
    `).run(nextHash ?? null, nextLastMessageAt, captureVersion, updatedAt, sessionKey);
    return {
      ...(nextHash ? { contentHash: nextHash } : {}),
      invalidatedLabels,
      changed,
      captureVersion,
    };
  }

  markCaptureResult(input: {
    sessionKey: string;
    status: LogisticsAnalysisCaptureStatus;
    error?: string;
    contentHash?: string;
    updatedAt?: number;
  }): LogisticsAnalysisCaptureResult {
    if (!CAPTURE_STATUSES.has(input.status)) throw new Error(`analysis_capture_status_invalid:${input.status}`);
    const at = timestamp(input.updatedAt ?? Date.now(), 'updated_at')!;
    return this.transaction(() => {
      const existing = this.db.prepare(
        'SELECT session_key,capture_status,capture_version,updated_at FROM sessions WHERE session_key=?',
      ).get(input.sessionKey) as QueryRow | undefined;
      if (!existing) throw new Error(`analysis_session_not_found:${input.sessionKey}`);
      const refreshed = this.refreshSessionContentInside(input.sessionKey, at);
      if (input.contentHash && input.contentHash !== refreshed.contentHash) {
        throw new Error('analysis_content_hash_mismatch');
      }
      const statusChanged = String(existing.capture_status) !== input.status;
      const advancesVersion = statusChanged && shouldAdvanceCaptureVersion(
        String(existing.capture_status) as LogisticsAnalysisCaptureStatus,
        input.status,
      );
      const captureVersion = refreshed.captureVersion + (advancesVersion ? 1 : 0);
      const updatedAt = advancesVersion
        ? Math.max(at, Number(existing.updated_at ?? 0) + 1)
        : Math.max(at, Number(existing.updated_at ?? 0));
      this.db.prepare(`
        UPDATE sessions SET capture_status=?,capture_error=?,capture_version=?,updated_at=?
        WHERE session_key=?
      `).run(
        input.status,
        optionalText(input.error, 500, true),
        captureVersion,
        updatedAt,
        input.sessionKey,
      );
      return {
        sessionKey: input.sessionKey,
        ...(refreshed.contentHash ? { contentHash: refreshed.contentHash } : {}),
        captureStatus: input.status,
        invalidatedLabels: refreshed.invalidatedLabels,
      };
    });
  }

  getMessages(sessionKey: string): LogisticsAnalysisMessage[] {
    return this.readTransaction(() => this.messagesInside(required(sessionKey, 'session_key')));
  }

  private messagesInside(sessionKey: string): LogisticsAnalysisMessage[] {
    const rows = this.db.prepare(`
      SELECT message_key,session_key,platform_message_id,role,sender_id,sender_name,content,
        occurred_at,response_kind,source,content_hash
      FROM messages WHERE session_key=? ORDER BY occurred_at IS NULL,occurred_at,message_key
    `).all(sessionKey) as QueryRow[];
    return rows.map(row => this.messageFromRow(row));
  }

  listPendingCapture(filters: LogisticsAnalysisPendingCaptureFilters = {}): LogisticsAnalysisSession[] {
    const limit = normalizeLimit(filters.limit);
    const offset = normalizeOffset(filters.offset);
    return this.readTransaction(() => {
      const params: SqlValue[] = [];
      const clauses = ["capture_status IN ('pending','running','partial','failed','conflict')"];
      if (filters.botId) { clauses.push('bot_id=?'); params.push(filters.botId); }
      params.push(limit, offset);
      const rows = this.db.prepare(`
        SELECT * FROM sessions WHERE ${clauses.join(' AND ')}
        ORDER BY updated_at,session_key LIMIT ? OFFSET ?
      `).all(...params) as QueryRow[];
      return rows.map(row => this.sessionFromRow(row));
    });
  }

  listPendingLabels(filters: LogisticsAnalysisPendingLabelFilters): Array<LogisticsAnalysisSession & { messages: LogisticsAnalysisMessage[] }> {
    const revision = required(filters.labelerRevision, 'labeler_revision');
    const limit = normalizeLimit(filters.limit);
    const offset = normalizeOffset(filters.offset);
    return this.readTransaction(() => {
      const params: SqlValue[] = filters.incrementalLabels ? [] : [revision];
      const covered = filters.incrementalLabels ? machineLabelSql('l') : 'l.labeler_revision=?';
      const clauses = [
        "s.capture_status='captured'",
        `NOT ${this.manualInvalidSql('s')}`,
        's.content_hash IS NOT NULL',
        'EXISTS (SELECT 1 FROM messages um WHERE um.session_key=s.session_key AND um.role=\'user\')',
        `NOT EXISTS (SELECT 1 FROM labels l WHERE l.session_key=s.session_key
          AND l.content_hash=s.content_hash AND l.capture_version=s.capture_version
          AND (${covered} OR ${validManualLabelSql('l')}))`,
      ];
      if (filters.botId) { clauses.push('s.bot_id=?'); params.push(filters.botId); }
      params.push(limit, offset);
      const rows = this.db.prepare(`
        SELECT s.* FROM sessions s WHERE ${clauses.join(' AND ')}
        ORDER BY s.updated_at,s.session_key LIMIT ? OFFSET ?
      `).all(...params) as QueryRow[];
      return rows.map(row => ({ ...this.sessionFromRow(row), messages: this.messagesInside(String(row.session_key)) }));
    });
  }

  private validManualLabelInside(sessionKey: string, contentHash: string, captureVersion: number): QueryRow | undefined {
    return this.db.prepare(`SELECT * FROM labels l WHERE l.session_key=? AND l.content_hash=?
      AND l.capture_version=? AND ${validManualLabelSql('l')}
      ORDER BY (${manualSourceSql('l')}='manual_taxonomy_approval') DESC,l.labeled_at DESC,l.labeler_revision DESC
      LIMIT 1`).get(sessionKey, contentHash, captureVersion) as QueryRow | undefined;
  }

  labelRunState(sessionKey: string, contentHash: string, labelerRevision: string): LogisticsAnalysisLabelRunState {
    const key = required(sessionKey, 'session_key');
    const hash = required(contentHash, 'content_hash');
    const revision = required(labelerRevision, 'labeler_revision');
    return this.readTransaction(() => {
      const session = this.db.prepare(
        `SELECT content_hash,capture_version,${this.manualInvalidSql('sessions')} AS manual_invalid FROM sessions WHERE session_key=?`,
      ).get(key) as QueryRow | undefined;
      if (!session) throw new Error(`analysis_session_not_found:${key}`);
      if (stringOrNull(session.content_hash) !== hash) throw new Error('analysis_label_content_stale');
      const captureVersion = Number(session.capture_version ?? 0);
      const label = this.validManualLabelInside(key, hash, captureVersion) ?? this.db.prepare(`
        SELECT 1 FROM labels
        WHERE session_key=? AND content_hash=? AND labeler_revision=? AND capture_version=?
      `).get(key, hash, revision, captureVersion);
      const row = this.db.prepare(`
        SELECT COALESCE(MAX(attempt),0) attempts,
          (SELECT status FROM label_runs
            WHERE session_key=? AND content_hash=? AND labeler_revision=?
            ORDER BY attempt DESC,started_at DESC,run_id DESC LIMIT 1) latest_status
        FROM label_runs
        WHERE session_key=? AND content_hash=? AND labeler_revision=?
      `).get(key, hash, revision, key, hash, revision) as QueryRow;
      const attempts = Number(row.attempts ?? 0);
      return {
        completed: !!label || booleanValue(session.manual_invalid),
        attempts,
        nextAttempt: attempts + 1,
        remainingAttempts: Math.max(0, LOGISTICS_ANALYSIS_MAX_LABEL_ATTEMPTS - attempts),
        ...(row.latest_status ? { latestStatus: String(row.latest_status) as LogisticsAnalysisLabelRunStatus } : {}),
      };
    });
  }

  registerLabelRun(input: LogisticsAnalysisLabelRunRegistration): LogisticsAnalysisLabelRunRegistrationResult {
    const sessionKey = required(input.sessionKey, 'session_key');
    const contentHash = required(input.contentHash, 'content_hash');
    const labelerRevision = required(input.labelerRevision, 'labeler_revision');
    const now = timestamp(input.now ?? Date.now(), 'started_at')!;
    return this.transaction(() => {
        const session = this.db.prepare(
          `SELECT content_hash,capture_version,capture_status,${this.manualInvalidSql('sessions')} AS manual_invalid FROM sessions WHERE session_key=?`,
        ).get(sessionKey) as QueryRow | undefined;
        if (!session) throw new Error(`analysis_session_not_found:${sessionKey}`);
      const captureVersion = Number(session.capture_version ?? 0);
      if (stringOrNull(session.content_hash) !== contentHash) throw new Error('analysis_label_content_stale');
      if (String(session.capture_status) !== 'captured') throw new Error('analysis_label_capture_not_ready');
      const existingLabel = this.validManualLabelInside(sessionKey, contentHash, captureVersion) ?? this.db.prepare(`
        SELECT 1 FROM labels
        WHERE session_key=? AND content_hash=? AND labeler_revision=? AND capture_version=?
      `).get(sessionKey, contentHash, labelerRevision, captureVersion);
      if (existingLabel || booleanValue(session.manual_invalid)) {
        const runId = `run_skip_${createHash('sha256').update(`${sessionKey}\u0000${contentHash}\u0000${labelerRevision}`).digest('hex')}`;
        this.db.prepare(`
          INSERT OR IGNORE INTO label_runs
            (run_id,session_key,content_hash,labeler_revision,model,status,error,attempt,capture_version,started_at,completed_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `).run(runId, sessionKey, contentHash, labelerRevision, input.model ?? null, 'skipped', null, 0, captureVersion, now, now);
        return {
          runId,
          attempt: 0,
          status: 'skipped',
          outcome: 'skipped',
          alreadyLabeled: true,
          remainingAttempts: 0,
        };
      }
      const running = this.db.prepare(`
        SELECT run_id,attempt FROM label_runs
        WHERE session_key=? AND content_hash=? AND labeler_revision=? AND capture_version=? AND status='running'
        ORDER BY attempt DESC LIMIT 1
      `).get(sessionKey, contentHash, labelerRevision, captureVersion) as QueryRow | undefined;
      if (running) {
        return {
          runId: String(running.run_id),
          attempt: Number(running.attempt),
          status: 'running',
          outcome: 'reused',
          alreadyLabeled: false,
          remainingAttempts: Math.max(0, LOGISTICS_ANALYSIS_MAX_LABEL_ATTEMPTS - Number(running.attempt)),
        };
      }
      this.db.prepare(`
        UPDATE label_runs SET status='expired',error='capture_version_changed',completed_at=?
        WHERE session_key=? AND content_hash=? AND labeler_revision=? AND status='running'
          AND capture_version<>?
      `).run(now, sessionKey, contentHash, labelerRevision, captureVersion);
      const last = this.db.prepare(`
        SELECT COALESCE(MAX(attempt),0) max_attempt FROM label_runs
        WHERE session_key=? AND content_hash=? AND labeler_revision=?
      `).get(sessionKey, contentHash, labelerRevision) as QueryRow;
      const attempt = Number(last.max_attempt ?? 0) + 1;
      if (attempt > LOGISTICS_ANALYSIS_MAX_LABEL_ATTEMPTS) throw new Error('analysis_label_attempt_limit');
      const runId = input.runId ? required(input.runId, 'run_id') : `run_${randomUUID().replace(/-/g, '')}`;
      this.db.prepare(`
        INSERT INTO label_runs
          (run_id,session_key,content_hash,labeler_revision,model,status,error,attempt,capture_version,started_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,NULL)
      `).run(runId, sessionKey, contentHash, labelerRevision, optionalText(input.model, 200), 'running', null, attempt, captureVersion, now);
      return {
        runId,
        attempt,
        status: 'running',
        outcome: 'created',
        alreadyLabeled: false,
        remainingAttempts: LOGISTICS_ANALYSIS_MAX_LABEL_ATTEMPTS - attempt,
      };
    });
  }

  commitLabel(input: LogisticsAnalysisLabelCommitInput): LogisticsAnalysisLabelCommitResult {
    const sessionKey = required(input.sessionKey, 'session_key');
    const contentHash = required(input.contentHash, 'content_hash');
    const labelerRevision = required(input.labelerRevision, 'labeler_revision');
    const runId = required(input.runId, 'run_id');
    const labeledAt = timestamp(input.labeledAt ?? Date.now(), 'labeled_at')!;
    if (!BUSINESS_LABELS.has(input.lb)) throw new Error(`analysis_lb_invalid:${input.lb}`);
    if (!PROBLEM_LABELS.has(input.lp)) throw new Error(`analysis_lp_invalid:${input.lp}`);
    if (!['resolved', 'in_progress', 'unknown'].includes(input.resolutionStatus)) {
      throw new Error(`analysis_resolution_invalid:${input.resolutionStatus}`);
    }
    if (!['high', 'medium', 'low'].includes(input.confidence)) {
      throw new Error(`analysis_confidence_invalid:${input.confidence}`);
    }
    const result = this.transaction(() => {
      const run = this.db.prepare('SELECT * FROM label_runs WHERE run_id=?').get(runId) as QueryRow | undefined;
      if (!run) throw new Error('analysis_label_run_not_found');
      if (String(run.session_key) !== sessionKey
        || String(run.content_hash) !== contentHash
        || String(run.labeler_revision) !== labelerRevision) {
        throw new Error('analysis_label_run_version_mismatch');
      }
      if (String(run.status) !== 'running') throw new Error('analysis_label_run_not_running');
      const session = this.db.prepare(
        `SELECT content_hash,capture_version,capture_status,${this.manualInvalidSql('sessions')} AS manual_invalid FROM sessions WHERE session_key=?`,
      ).get(sessionKey) as QueryRow | undefined;
      if (!session) throw new Error(`analysis_session_not_found:${sessionKey}`);
      const captureVersion = Number(session.capture_version ?? 0);
      if (stringOrNull(session.content_hash) !== contentHash
        || Number(run.capture_version) !== captureVersion
        || String(session.capture_status) !== 'captured') {
        this.db.prepare(`
          UPDATE label_runs SET status='expired',error=?,completed_at=? WHERE run_id=?
        `).run('content_changed_before_commit', labeledAt, runId);
        return { stale: true as const };
      }
      if (booleanValue(session.manual_invalid) || this.validManualLabelInside(sessionKey, contentHash, captureVersion)) {
        this.db.prepare(`UPDATE label_runs SET status='skipped',error='manual_label_protected',completed_at=?
          WHERE run_id=?`).run(labeledAt, runId);
        return { stale: false as const, manualProtected: true };
      }
      this.db.prepare(`
        INSERT INTO labels (
          session_key,content_hash,labeler_revision,labeled_at,lb,lp,resolution_status,
          confidence,needs_review,label_reason,capture_version
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(session_key,content_hash,capture_version,labeler_revision) DO UPDATE SET
          labeled_at=excluded.labeled_at,lb=excluded.lb,lp=excluded.lp,
          resolution_status=excluded.resolution_status,confidence=excluded.confidence,
          needs_review=excluded.needs_review,label_reason=excluded.label_reason,
          capture_version=excluded.capture_version
      `).run(
        sessionKey, contentHash, labelerRevision, labeledAt, input.lb, input.lp,
        input.resolutionStatus, input.confidence, input.needsReview ? 1 : 0,
        optionalText(input.labelReason, 500, true), captureVersion,
      );
      this.db.prepare(`
        UPDATE label_runs SET status='succeeded',error=NULL,completed_at=? WHERE run_id=?
      `).run(labeledAt, runId);
      return { stale: false as const };
    });
    if (result.stale) throw new Error('analysis_label_content_stale');
    if (result.manualProtected) throw new Error('analysis_manual_label_protected');
    return { sessionKey, contentHash, labelerRevision, labeledAt };
  }

  failLabelRun(input: LogisticsAnalysisLabelRunFailureInput): void {
    const runId = required(input.runId, 'run_id');
    const completedAt = timestamp(input.completedAt ?? Date.now(), 'completed_at')!;
    const error = optionalText(input.error, 500, true);
    if (!error) throw new Error('analysis_label_error_required');
    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE label_runs SET status='failed',error=?,completed_at=?
        WHERE run_id=? AND status='running'
      `).run(error, completedAt, runId);
      if (Number(result.changes ?? 0) !== 1) throw new Error('analysis_label_run_not_running');
    });
  }

  expireLabelRun(input: LogisticsAnalysisLabelRunExpirationInput): void {
    const runId = required(input.runId, 'run_id');
    const completedAt = timestamp(input.completedAt ?? Date.now(), 'completed_at')!;
    const reason = optionalText(input.reason, 500, true);
    if (!reason) throw new Error('analysis_label_expiration_reason_required');
    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE label_runs SET status='expired',error=?,completed_at=?
        WHERE run_id=? AND status='running'
      `).run(reason, completedAt, runId);
      if (Number(result.changes ?? 0) !== 1) throw new Error('analysis_label_run_not_running');
    });
  }

  cleanupOldLabelRuns(input: { now?: number; retentionMs?: number } = {}): LogisticsAnalysisCleanupResult {
    const now = timestamp(input.now ?? Date.now(), 'cleanup_now')!;
    const retentionMs = input.retentionMs ?? LOGISTICS_ANALYSIS_LABEL_RUN_RETENTION_MS;
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) throw new Error('analysis_retention_invalid');
    const cutoff = now - retentionMs;
    const deleted = this.transaction(() => {
      const result = this.db.prepare(`
        DELETE FROM label_runs
        WHERE started_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM sessions s
            WHERE s.session_key=label_runs.session_key
              AND s.content_hash=label_runs.content_hash
          )
      `).run(cutoff);
      return Number(result.changes ?? 0);
    });
    return { cutoff, deleted };
  }

  recoverStaleLabelRuns(input: { now?: number; staleAfterMs: number }): { expired: number } {
    const now = timestamp(input.now ?? Date.now(), 'recovery_now')!;
    if (!Number.isSafeInteger(input.staleAfterMs) || input.staleAfterMs < 0) {
      throw new Error('analysis_stale_after_invalid');
    }
    const cutoff = now - input.staleAfterMs;
    const expired = this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE label_runs SET status='expired',error='orphaned_running_recovered',completed_at=?
        WHERE status='running' AND started_at < ?
      `).run(now, cutoff);
      return Number(result.changes ?? 0);
    });
    return { expired };
  }

  private buildRowsQuery(filters: LogisticsAnalysisFilters): { sql: string; params: SqlValue[] } {
    const params: SqlValue[] = [];
    const labelerRevision = required(filters.labelerRevision, 'labeler_revision');
    const runJoin = ' AND r2.labeler_revision=?';
    params.push(labelerRevision);
    params.push(labelerRevision);
    params.push(labelerRevision);
    const clauses = ["s.scope='thread'", `NOT ${this.manualInvalidSql('s')}`];
    const from = parseDateBoundary(filters.from, false);
    const to = parseDateBoundary(filters.to, true);
    if (from !== undefined && to !== undefined && to <= from) throw new Error('analysis_invalid_date_range');
    if (from !== undefined && to !== undefined && to - from > 366 * 24 * 60 * 60_000) {
      throw new Error('analysis_range_too_large');
    }
    if (from !== undefined) { clauses.push('COALESCE(s.last_message_at,s.created_at)>=?'); params.push(from); }
    if (to !== undefined) { clauses.push('COALESCE(s.last_message_at,s.created_at)<?'); params.push(to); }
    if (filters.botId) { clauses.push('s.bot_id=?'); params.push(filters.botId); }
    if (filters.scope) { clauses.push('s.scope=?'); params.push(filters.scope); }
    if (filters.sessionStatus) { clauses.push('s.session_status=?'); params.push(filters.sessionStatus); }
    if (filters.captureStatus) { clauses.push('s.capture_status=?'); params.push(filters.captureStatus); }
    const outer: string[] = [];
    if (filters.labelStatus) {
      if (!LABEL_STATUSES.has(filters.labelStatus)) throw new Error(`analysis_label_status_invalid:${filters.labelStatus}`);
      outer.push('q.label_status=?'); params.push(filters.labelStatus);
    }
    if (filters.lb) { outer.push('q.lb=?'); params.push(filters.lb); }
    if (filters.lp) { outer.push('q.lp=?'); params.push(filters.lp); }
    if (filters.resolutionStatus) { outer.push('q.resolution_status=?'); params.push(filters.resolutionStatus); }
    if (filters.needsReview !== undefined) { outer.push('q.needs_review=?'); params.push(filters.needsReview ? 1 : 0); }
    const sql = `
      SELECT * FROM (
        SELECT
          s.session_key,s.botmux_session_id,s.bot_id,s.bot_name,s.cli_session_id,s.chat_id,s.chat_name,
          s.scope,s.root_message_id,s.lark_message_url,s.title,s.initiator_id,s.initiator_name,
          s.session_status,s.created_at,s.last_message_at,s.capture_status,s.capture_error,
          s.content_hash,s.capture_version,s.updated_at,
          l.labeler_revision AS labeler_revision,l.lb AS lb,l.lp AS lp,
          l.resolution_status AS resolution_status,l.confidence AS confidence,
          l.needs_review AS needs_review,l.label_reason AS label_reason,
          EXISTS (SELECT 1 FROM labels old WHERE old.session_key=s.session_key
            AND old.content_hash=s.content_hash AND old.capture_version=s.capture_version
            AND old.labeler_revision<>? AND ${machineLabelSql('old')}) AS previous_machine_label,
          lr.status AS latest_run_status,
          (SELECT COUNT(*) FROM messages m WHERE m.session_key=s.session_key) AS message_count,
          CASE
            WHEN s.capture_status<>'captured' OR s.content_hash IS NULL THEN 'not_ready'
            WHEN l.session_key IS NOT NULL THEN 'labeled'
            WHEN lr.status='running' THEN 'running'
            WHEN lr.status IN ('failed','expired') THEN 'failed'
            ELSE 'pending'
          END AS label_status
        FROM sessions s
        LEFT JOIN labels l
          ON l.session_key=s.session_key AND s.content_hash IS NOT NULL
          AND l.content_hash=s.content_hash AND l.capture_version=s.capture_version
          AND l.labeler_revision=(SELECT chosen.labeler_revision FROM labels chosen
            WHERE chosen.session_key=s.session_key AND chosen.content_hash=s.content_hash
              AND chosen.capture_version=s.capture_version
              AND (chosen.labeler_revision=? OR ${validManualLabelSql('chosen')})
            ORDER BY ${validManualLabelSql('chosen')} DESC,
              (${manualSourceSql('chosen')}='manual_taxonomy_approval') DESC,
              chosen.labeled_at DESC,chosen.labeler_revision DESC LIMIT 1)
        LEFT JOIN label_runs lr ON lr.run_id=(
          SELECT r2.run_id FROM label_runs r2
          WHERE r2.session_key=s.session_key AND r2.content_hash=s.content_hash
            AND r2.capture_version=s.capture_version${runJoin}
          ORDER BY r2.attempt DESC,r2.started_at DESC,r2.run_id DESC LIMIT 1
        )
        WHERE ${clauses.join(' AND ')}
      ) q
      ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}
    `;
    return { sql, params };
  }

  private queryRows(filters: LogisticsAnalysisFilters): QueryRow[] {
    const query = this.buildRowsQuery(filters);
    return this.db.prepare(query.sql).all(...query.params) as QueryRow[];
  }

  summary(filters: LogisticsAnalysisFilters): LogisticsAnalysisSummary {
    return this.readTransaction(() => {
      const rows = this.queryRows(filters);
      const count = (predicate: (row: QueryRow) => boolean) => rows.filter(predicate).length;
      const labeled = count(row => String(row.label_status) === 'labeled');
      const resolved = count(row => String(row.label_status) === 'labeled' && row.resolution_status === 'resolved');
      const categories = Object.entries(PROBLEM_LABEL_NAMES).map(([taskType, name]) => {
        const categoryRows = rows.filter(row => String(row.label_status) === 'labeled' && row.lp === taskType);
        const resolvedCount = categoryRows.filter(row => row.resolution_status === 'resolved').length;
        return {
          taskType,
          name,
          topicCount: categoryRows.length,
          resolvedCount,
          inProgressCount: categoryRows.filter(row => row.resolution_status === 'in_progress').length,
          unknownCount: categoryRows.filter(row => row.resolution_status === 'unknown').length,
          resolutionRate: categoryRows.length ? resolvedCount / categoryRows.length : null,
        };
      });
      return {
        totalTopics: rows.length,
        capturedTopics: count(row => row.capture_status === 'captured'),
        capturePending: count(row => row.capture_status === 'pending'),
        captureRunning: count(row => row.capture_status === 'running'),
        capturePartial: count(row => row.capture_status === 'partial'),
        captureFailed: count(row => row.capture_status === 'failed'),
        captureConflict: count(row => row.capture_status === 'conflict'),
        labeledTopics: labeled,
        labelPending: count(row => row.label_status === 'pending'),
        labelRunning: count(row => row.label_status === 'running'),
        labelFailed: count(row => row.label_status === 'failed'),
        messages: rows.reduce((sum, row) => sum + Number(row.message_count ?? 0), 0),
        resolved,
        inProgress: count(row => String(row.label_status) === 'labeled' && row.resolution_status === 'in_progress'),
        unknown: count(row => String(row.label_status) === 'labeled' && row.resolution_status === 'unknown'),
        needsReview: count(row => String(row.label_status) === 'labeled' && booleanValue(row.needs_review)),
        labelCoverage: {
          requestedRevision: filters.labelerRevision,
          currentRevisionTopics: count(row => row.label_status === 'labeled' && row.labeler_revision === filters.labelerRevision),
          crossRevisionManualTopics: count(row => row.label_status === 'labeled' && row.labeler_revision !== filters.labelerRevision),
          previousMachineRevisionTopics: count(row => ['pending','running','failed'].includes(String(row.label_status)) && Number(row.previous_machine_label) === 1),
          unlabeledTopics: count(row => ['pending','running','failed'].includes(String(row.label_status)) && Number(row.previous_machine_label) !== 1),
        },
        lastDataTime: rows.reduce<number | null>((latest, row) => {
          const value = numberOrNull(row.updated_at);
          return value === null ? latest : latest === null ? value : Math.max(latest, value);
        }, null),
        categories,
      };
    });
  }

  trend(filters: LogisticsAnalysisFilters): LogisticsAnalysisTrendPoint[] {
    return this.readTransaction(() => {
      const buckets = new Map<string, LogisticsAnalysisTrendPoint>();
      for (const row of this.queryRows(filters)) {
        const time = numberOrNull(row.last_message_at) ?? Number(row.created_at);
        const day = dayInShanghai(time);
        const point = buckets.get(day) ?? {
          day,
          totalTopics: 0,
          capturedTopics: 0,
          labeledTopics: 0,
          resolved: 0,
          inProgress: 0,
          unknown: 0,
        };
        point.totalTopics += 1;
        if (row.capture_status === 'captured') point.capturedTopics += 1;
        if (row.label_status === 'labeled') {
          point.labeledTopics += 1;
          if (row.resolution_status === 'resolved') point.resolved += 1;
          if (row.resolution_status === 'in_progress') point.inProgress += 1;
          if (row.resolution_status === 'unknown') point.unknown += 1;
        }
        buckets.set(day, point);
      }
      return [...buckets.values()].sort((left, right) => left.day.localeCompare(right.day));
    });
  }

  distributions(filters: LogisticsAnalysisFilters): LogisticsAnalysisDistributions {
    return this.readTransaction(() => {
      const rows = this.queryRows(filters);
      const collect = (values: string[]): LogisticsAnalysisDistributionItem[] => {
        const counts = new Map<string, number>();
        for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
        return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((left, right) => (
          right.count - left.count || left.key.localeCompare(right.key)
        ));
      };
      return {
        lb: collect(rows.map(row => String(row.label_status) === 'labeled' ? String(row.lb) : 'unlabeled')),
        lp: collect(rows.map(row => String(row.label_status) === 'labeled' ? String(row.lp) : 'unlabeled')),
        resolution: collect(rows.map(row => String(row.label_status) === 'labeled'
          ? String(row.resolution_status) : 'unlabeled')),
        captureStatus: collect(rows.map(row => String(row.capture_status))),
        labelStatus: collect(rows.map(row => String(row.label_status))),
      };
    });
  }

  list(
    filters: LogisticsAnalysisFilters,
    page: { limit?: number; offset?: number } = {},
  ): LogisticsAnalysisListResult {
    const limit = normalizeLimit(page.limit);
    const offset = normalizeOffset(page.offset);
    return this.readTransaction(() => {
      const rows = this.queryRows(filters);
      return {
        items: rows.slice(offset, offset + limit).map(row => this.listItemFromRow(row)),
        total: rows.length,
        limit,
        offset,
      };
    });
  }

  detail(topicPublicId: string, options: { labelerRevision: string }): LogisticsAnalysisDetail | undefined {
    const publicId = required(topicPublicId, 'topic_public_id');
    return this.readTransaction(() => {
      const rows = this.queryRows({ labelerRevision: options.labelerRevision });
      const row = rows.find(item => buildLogisticsTopicPublicId(String(item.session_key)) === publicId);
      if (!row) return undefined;
      const messages = this.messagesInside(String(row.session_key));
      return {
        ...this.listItemFromRow(row),
        chatName: stringOrNull(row.chat_name),
        larkMessageUrl: stringOrNull(row.lark_message_url),
        initiatorId: stringOrNull(row.initiator_id),
        initiatorName: stringOrNull(row.initiator_name),
        captureError: stringOrNull(row.capture_error),
        contentHash: stringOrNull(row.content_hash),
        captureVersion: Number(row.capture_version ?? 0),
        labelerRevision: String(row.label_status) === 'labeled' ? stringOrNull(row.labeler_revision) : null,
        labelReason: String(row.label_status) === 'labeled' ? stringOrNull(row.label_reason) : null,
        messages: messages.map(message => ({
          platformMessageId: message.platformMessageId ?? null,
          role: message.role,
          senderName: message.senderName ?? null,
          content: message.content,
          occurredAt: message.occurredAt ?? null,
          responseKind: message.responseKind ?? null,
          source: message.source,
        })),
      };
    });
  }

  private sessionFromRow(row: QueryRow): LogisticsAnalysisSession {
    return {
      sessionKey: String(row.session_key),
      publicId: buildLogisticsTopicPublicId(String(row.session_key)),
      botmuxSessionId: stringOrNull(row.botmux_session_id) ?? undefined,
      cliSessionId: stringOrNull(row.cli_session_id) ?? undefined,
      botId: String(row.bot_id),
      botName: stringOrNull(row.bot_name) ?? undefined,
      chatId: String(row.chat_id),
      chatName: stringOrNull(row.chat_name) ?? undefined,
      scope: 'thread',
      rootMessageId: String(row.root_message_id),
      larkMessageUrl: stringOrNull(row.lark_message_url),
      title: stringOrNull(row.title) ?? undefined,
      initiatorId: stringOrNull(row.initiator_id) ?? undefined,
      initiatorName: stringOrNull(row.initiator_name) ?? undefined,
      sessionStatus: String(row.session_status) as LogisticsAnalysisSessionStatus,
      createdAt: Number(row.created_at),
      lastMessageAt: numberOrNull(row.last_message_at) ?? undefined,
      captureStatus: String(row.capture_status) as LogisticsAnalysisCaptureStatus,
      captureVersion: Number(row.capture_version ?? 0),
      captureError: stringOrNull(row.capture_error) ?? undefined,
      contentHash: stringOrNull(row.content_hash) ?? undefined,
      updatedAt: Number(row.updated_at),
    };
  }

  private messageFromRow(row: QueryRow): LogisticsAnalysisMessage {
    return {
      messageKey: String(row.message_key),
      sessionKey: String(row.session_key),
      platformMessageId: stringOrNull(row.platform_message_id),
      role: String(row.role) as LogisticsAnalysisRole,
      senderId: stringOrNull(row.sender_id) ?? undefined,
      senderName: stringOrNull(row.sender_name) ?? undefined,
      content: String(row.content),
      occurredAt: numberOrNull(row.occurred_at) ?? undefined,
      ...(row.response_kind ? { responseKind: 'final' as const } : {}),
      source: String(row.source) as LogisticsAnalysisMessageSource,
      contentHash: String(row.content_hash),
    };
  }

  private listItemFromRow(row: QueryRow): LogisticsAnalysisListItem {
    return {
      topicPublicId: buildLogisticsTopicPublicId(String(row.session_key)),
      title: stringOrNull(row.title),
      botId: String(row.bot_id),
      botName: stringOrNull(row.bot_name),
      scope: 'thread',
      captureStatus: String(row.capture_status) as LogisticsAnalysisCaptureStatus,
      labelStatus: String(row.label_status) as LogisticsAnalysisLabelStatus,
      lb: String(row.label_status) === 'labeled' ? stringOrNull(row.lb) : null,
      lp: String(row.label_status) === 'labeled' ? stringOrNull(row.lp) : null,
      resolutionStatus: String(row.label_status) === 'labeled'
        ? String(row.resolution_status) as LogisticsAnalysisResolutionStatus : null,
      confidence: String(row.label_status) === 'labeled'
        ? String(row.confidence) as LogisticsAnalysisConfidence : null,
      needsReview: String(row.label_status) === 'labeled' && booleanValue(row.needs_review),
      lastMessageAt: numberOrNull(row.last_message_at),
      dataTime: Number(row.updated_at),
    };
  }
}

export function openLogisticsAnalysisStore(options: LogisticsAnalysisStoreOptions): LogisticsAnalysisStore {
  return new LogisticsAnalysisStore(options);
}
