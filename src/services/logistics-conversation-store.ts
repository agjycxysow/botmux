import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

import type { FeedbackSurveyRecord } from './feedback-survey.js';
import { buildLogisticsSessionSnapshot } from './logistics-session-capture.js';
import type {
  LogisticsEvidenceAnchor,
  LogisticsModelTagging,
  LogisticsSessionMasterRecord,
} from './logistics-session-master.js';

const require = createRequire(import.meta.url);

const SCHEMA_VERSION = 5;
const DEFAULT_FILE = 'botmux-conversations.sqlite';

export interface LogisticsConversationStoreOptions {
  dataDir: string;
  path?: string;
  readOnly?: boolean;
}

export type LogisticsBackfillStatus =
  | 'pending'
  | 'processing'
  | 'captured'
  | 'missing_turn'
  | 'missing_answer'
  | 'history_failed'
  | 'skipped';

export interface LogisticsCapturedMessageInput {
  larkAppId: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  senderId?: string;
  senderName?: string;
  senderAvatarUrl?: string;
  platformMessageId?: string;
  occurredAt?: number;
  turnId?: string;
  triggerMessageId?: string;
  responseKind?: 'final';
  source: 'lark_history' | 'botmux_send_marker' | 'snapshot_projection' | 'legacy_snapshot';
}

export interface LogisticsCapturedMessageWriteResult {
  total: number;
  inserted: number;
  updated: number;
}

export interface LogisticsIdentityBackfillWriteResult {
  total: number;
  matched: number;
  updated: number;
}

export interface LogisticsIdentityCoverage {
  conversations: number;
  initiators: number;
  initiatorNames: number;
  messages: number;
  messageSenders: number;
  messageSenderNames: number;
  userMessages: number;
  userMessageSenders: number;
  participants: number;
  participantNames: number;
}

export interface LogisticsLabelRunState {
  completed: boolean;
  nextAttempt: number;
}

export interface LogisticsSessionCatalogInput {
  larkAppId: string;
  sessionId: string;
  chatId: string;
  rootMessageId: string;
  scope: 'thread' | 'chat';
  sessionStatus: 'active' | 'closed' | 'unknown';
  title?: string;
  createdAt: number;
  lastMessageAt?: number;
  closedAt?: number;
  backfillStatus?: LogisticsBackfillStatus;
  backfillError?: string;
  specialSession?: boolean;
}

export interface LogisticsConversationFilters {
  from?: string;
  to?: string;
  larkAppId?: string;
  businessCategory?: string;
  problemType?: string;
  resolutionStatus?: string;
  needsReview?: boolean;
  dataStatus?: LogisticsBackfillStatus;
}

export interface LogisticsConversationSummary {
  totalSessions: number;
  conversations: number;
  snapshotted: number;
  labeled: number;
  pendingBackfill: number;
  failedBackfill: number;
  analysisCoverage: number;
  labelCoverage: number;
  surveyRecords: number;
  answeredSurveys: number;
  messages: number;
  resolved: number;
  inProgress: number;
  unknown: number;
  needsReview: number;
  rated: number;
  averageRating: number | null;
  resolutionRate: number;
}

export interface LogisticsConversationListItem {
  sessionPublicId: string;
  conversationId?: string;
  larkAppId: string;
  sessionStatus: string;
  scope: string;
  dataStatus: LogisticsBackfillStatus;
  title?: string;
  captureState?: string;
  taggingState: string;
  businessCategory?: string;
  problemType?: string;
  resolutionStatus?: string;
  overallConfidence?: string;
  needsReview: boolean;
  reviewReason?: string;
  rating?: number;
  ratingCount: number;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface LogisticsProjectBaseSourceRow {
  conversationKey: string;
  sessionPublicId: string;
  larkAppId: string;
  initiatorName?: string;
  title?: string;
  conversationAt: number;
  dataStatus: LogisticsBackfillStatus;
  captureState?: string;
  taggingState: string;
  businessCategory?: string;
  problemType?: string;
  resolutionStatus?: string;
  overallConfidence?: string;
  needsReview: boolean;
  reviewReason?: string;
  harnessRevision?: string;
  businessReasonCode?: string;
  problemReasonCode?: string;
  resolutionReasonCode?: string;
  rating?: number;
  surveyStatus?: string;
  updatedAt: number;
}

export interface LogisticsConversationDetail extends LogisticsConversationListItem {
  transcript?: string;
  transcriptHash?: string;
  harnessRevision?: string;
  businessReasonCode?: string;
  problemReasonCode?: string;
  resolutionReasonCode?: string;
  evidenceAnchors: LogisticsEvidenceAnchor[];
  manualReviewStatus: string;
  messages: Array<{ role: string; content: string; createdAt?: number }>;
  snapshots: Array<{
    captureState: string;
    messageCount: number;
    createdAt: number;
    harnessRevision?: string;
  }>;
}

type SqlParams = Array<string | number>;

function sqlitePath(options: LogisticsConversationStoreOptions): string {
  return options.path ? resolve(options.path) : join(options.dataDir, DEFAULT_FILE);
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function bool(value: unknown): boolean {
  return Number(value ?? 0) === 1;
}

function publicId(masterKey: string): string {
  return `conv_${createHash('sha256').update(masterKey).digest('hex').slice(0, 32)}`;
}

function safeMetadata(value: string | undefined, maxChars: number): string | null {
  if (!value) return null;
  const sanitized = value
    .replace(/\bou_[A-Za-z0-9_]+\b/g, '[成员]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱]')
    .replace(/\b1[3-9]\d{9}\b/g, '[手机号]')
    .replace(/\b\d{8,}\b/g, '[编号]')
    .replace(/(?:https?|ftp):\/\/\S+/gi, '[链接]')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(sanitized).slice(0, maxChars).join('') || null;
}

function identityText(value: string | undefined, maxChars: number): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return Array.from(normalized).slice(0, maxChars).join('') || null;
}

function toIsoBoundary(value: string | undefined, end: boolean): number | undefined {
  if (!value) return undefined;
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = Date.parse(dayOnly ? `${value}T00:00:00+08:00` : value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid_date:${value}`);
  return dayOnly && end ? parsed + 24 * 60 * 60_000 : parsed;
}

function where(filters: LogisticsConversationFilters, conversationAlias = 'c', catalogAlias = 'sc'): { sql: string; params: SqlParams } {
  const clauses: string[] = [];
  const params: SqlParams = [];
  const from = toIsoBoundary(filters.from, false);
  const to = toIsoBoundary(filters.to, true);
  if (from !== undefined && to !== undefined && to - from > 366 * 24 * 60 * 60_000) {
    throw new Error('analytics_range_too_large');
  }
  const timeColumn = `COALESCE(${catalogAlias}.last_message_at,${catalogAlias}.closed_at,${catalogAlias}.created_at,${conversationAlias}.updated_at)`;
  if (from !== undefined) { clauses.push(`${timeColumn}>=?`); params.push(from); }
  if (to !== undefined) { clauses.push(`${timeColumn}<?`); params.push(to); }
  const columns: Array<[string | undefined, string]> = [
    [filters.larkAppId, `${catalogAlias}.lark_app_id`],
    [filters.businessCategory, `${conversationAlias}.business_category`],
    [filters.problemType, `${conversationAlias}.problem_type`],
    [filters.resolutionStatus, `${conversationAlias}.resolution_status`],
    [filters.dataStatus, `${catalogAlias}.backfill_status`],
  ];
  for (const [value, column] of columns) {
    if (value) { clauses.push(`${column}=?`); params.push(value); }
  }
  if (filters.needsReview !== undefined) {
    clauses.push(`${conversationAlias}.needs_review=?`);
    params.push(filters.needsReview ? 1 : 0);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function analyzableConversationCondition(
  conversationAlias = 'c',
  catalogAlias = 'sc',
): string {
  return `${conversationAlias}.master_key IS NOT NULL
    AND ${catalogAlias}.backfill_status='captured'
    AND ${conversationAlias}.transcript LIKE '%用户：%'`;
}

function appendWhereCondition(sql: string, condition: string): string {
  return sql ? `${sql} AND ${condition}` : `WHERE ${condition}`;
}

function sessionPublicId(larkAppId: string, sessionId: string): string {
  return `sess_${createHash('sha256').update(`${larkAppId}:${sessionId}`).digest('hex').slice(0, 32)}`;
}

function capturedMessageId(message: LogisticsCapturedMessageInput): string {
  const stable = message.platformMessageId
    ? `${message.larkAppId}:${message.sessionId}:${message.platformMessageId}`
    : JSON.stringify({
        app: message.larkAppId,
        session: message.sessionId,
        role: message.role,
        occurredAt: message.occurredAt ?? null,
        content: message.content,
      });
  return `msg_${createHash('sha256').update(stable).digest('hex')}`;
}

function capturedMessageContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function capturedMessageSourceRank(source: LogisticsCapturedMessageInput['source']): number {
  if (source === 'botmux_send_marker') return 3;
  if (source === 'lark_history') return 2;
  return 1;
}


export class LogisticsConversationStore {
  readonly path: string;
  private readonly db: DatabaseSyncType;
  private readonly writable: boolean;

  constructor(options: LogisticsConversationStoreOptions) {
    this.path = sqlitePath(options);
    this.writable = !options.readOnly;
    if (!options.readOnly) mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    this.db = new DatabaseSync(this.path, options.readOnly ? { readOnly: true } : {});
    this.db.exec('PRAGMA busy_timeout=5000;');
    this.db.exec('PRAGMA foreign_keys=ON;');
    if (!options.readOnly) {
      this.db.exec('PRAGMA journal_mode=WAL;');
      this.migrate();
      this.secureFiles();
    }
  }

  close(): void {
    this.secureFiles();
    this.db.close();
    this.secureFiles();
  }

  private secureFiles(): void {
    if (!this.writable) return;
    for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      if (!existsSync(path)) continue;
      try { chmodSync(path, 0o600); } catch { /* parent directory permissions remain authoritative */ }
    }
  }

  syncSessionCatalog(rows: LogisticsSessionCatalogInput[]): { total: number; inserted: number } {
    let inserted = 0;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      for (const row of rows) {
        const result = this.insertCatalogRow(row);
        inserted += Number(result.changes ?? 0);
        this.db.prepare(`
          UPDATE session_catalog SET
            chat_id=?,root_message_id=?,scope=?,session_status=?,title=?,created_at=?,
            last_message_at=?,closed_at=?,special_session=?,updated_at=?
          WHERE lark_app_id=? AND session_id=?
        `).run(
          row.chatId, row.rootMessageId, row.scope, row.sessionStatus,
          safeMetadata(row.title, 120), row.createdAt, row.lastMessageAt ?? null,
          row.closedAt ?? null, row.specialSession ? 1 : 0,
          Math.max(row.lastMessageAt ?? 0, row.closedAt ?? 0, row.createdAt),
          row.larkAppId, row.sessionId,
        );
        if (row.backfillStatus) {
          this.markSessionBackfillInside(row.larkAppId, row.sessionId, row.backfillStatus, row.backfillError);
        }
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    return { total: rows.length, inserted };
  }

  markSessionBackfill(
    larkAppId: string,
    sessionId: string,
    status: LogisticsBackfillStatus,
    error?: string,
    conversationId?: string,
  ): void {
    this.markSessionBackfillInside(larkAppId, sessionId, status, error, conversationId);
  }

  upsertCapturedMessages(
    messages: LogisticsCapturedMessageInput[],
    capturedAt = Date.now(),
  ): LogisticsCapturedMessageWriteResult {
    const result: LogisticsCapturedMessageWriteResult = {
      total: messages.length,
      inserted: 0,
      updated: 0,
    };
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const sessionKeys = new Set<string>();
      for (const message of messages) {
        const outcome = this.upsertCapturedMessageInside(message, capturedAt);
        result[outcome] += 1;
        sessionKeys.add(`${message.larkAppId}:${message.sessionId}`);
      }
      for (const sessionKey of sessionKeys) this.refreshConversationInitiatorInside(sessionKey);
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  upsertCapturedMessageIdentities(
    messages: LogisticsCapturedMessageInput[],
    capturedAt = Date.now(),
  ): LogisticsIdentityBackfillWriteResult {
    const result: LogisticsIdentityBackfillWriteResult = {
      total: messages.length,
      matched: 0,
      updated: 0,
    };
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const sessionKeys = new Set<string>();
      for (const message of messages) {
        if (!message.platformMessageId) continue;
        const sessionKey = `${message.larkAppId}:${message.sessionId}`;
        const existing = this.db.prepare(`
          SELECT role,sender_id,sender_name,sender_avatar_url
          FROM conversation_messages
          WHERE session_key=? AND platform_message_id=?
        `).get(sessionKey, message.platformMessageId) as {
          role: 'user' | 'assistant';
          sender_id?: string | null;
          sender_name?: string | null;
          sender_avatar_url?: string | null;
        } | undefined;
        if (!existing) continue;
        result.matched += 1;
        const senderId = identityText(message.senderId, 256);
        const senderName = identityText(message.senderName, 200);
        const senderAvatarUrl = identityText(message.senderAvatarUrl, 2_048);
        const changed = (
          (senderId !== null && senderId !== existing.sender_id)
          || (senderName !== null && senderName !== existing.sender_name)
          || (senderAvatarUrl !== null && senderAvatarUrl !== existing.sender_avatar_url)
        );
        if (changed) {
          this.db.prepare(`
            UPDATE conversation_messages SET
              sender_id=COALESCE(?,sender_id),
              sender_name=COALESCE(?,sender_name),
              sender_avatar_url=COALESCE(?,sender_avatar_url)
            WHERE session_key=? AND platform_message_id=?
          `).run(
            senderId, senderName, senderAvatarUrl, sessionKey, message.platformMessageId,
          );
          result.updated += 1;
        }
        this.upsertParticipantFromMessageInside({
          ...message,
          role: existing.role,
        }, capturedAt);
        sessionKeys.add(sessionKey);
      }
      for (const sessionKey of sessionKeys) this.refreshConversationInitiatorInside(sessionKey);
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  private upsertCapturedMessageInside(
    message: LogisticsCapturedMessageInput,
    capturedAt: number,
  ): 'inserted' | 'updated' {
    const sessionKey = `${message.larkAppId}:${message.sessionId}`;
    const messageId = capturedMessageId(message);
    const contentHash = capturedMessageContentHash(message.content);
    const existing = this.db.prepare(`
      SELECT content_hash,source FROM conversation_messages WHERE message_id=?
    `).get(messageId) as {
      content_hash: string;
      source: LogisticsCapturedMessageInput['source'];
    } | undefined;
    const preserveHigherFidelity = existing
      && capturedMessageSourceRank(existing.source) > capturedMessageSourceRank(message.source);
    const senderId = identityText(message.senderId, 256);
    const senderName = identityText(message.senderName, 200);
    const senderAvatarUrl = identityText(message.senderAvatarUrl, 2_048);
    if (!preserveHigherFidelity) {
      this.db.prepare(`
        INSERT INTO conversation_messages (
          message_id,session_key,platform_message_id,role,content,content_hash,
          sender_id,sender_name,sender_avatar_url,occurred_at,
          turn_id,trigger_message_id,response_kind,source,captured_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(message_id) DO UPDATE SET
          role=excluded.role,content=excluded.content,content_hash=excluded.content_hash,
          sender_id=COALESCE(excluded.sender_id,conversation_messages.sender_id),
          sender_name=COALESCE(excluded.sender_name,conversation_messages.sender_name),
          sender_avatar_url=COALESCE(
            excluded.sender_avatar_url,conversation_messages.sender_avatar_url
          ),
          occurred_at=excluded.occurred_at,turn_id=excluded.turn_id,
          trigger_message_id=excluded.trigger_message_id,response_kind=excluded.response_kind,
          source=excluded.source,captured_at=excluded.captured_at
      `).run(
        messageId, sessionKey, message.platformMessageId ?? null, message.role,
        message.content, contentHash, senderId, senderName, senderAvatarUrl,
        message.occurredAt ?? null, message.turnId ?? null,
        message.triggerMessageId ?? null, message.responseKind ?? null, message.source, capturedAt,
      );
    } else {
      this.db.prepare(`
        UPDATE conversation_messages
        SET sender_id=COALESCE(?,sender_id),sender_name=COALESCE(?,sender_name),
          sender_avatar_url=COALESCE(?,sender_avatar_url),
          occurred_at=COALESCE(occurred_at,?),turn_id=COALESCE(turn_id,?),
          trigger_message_id=COALESCE(trigger_message_id,?),
          response_kind=COALESCE(response_kind,?),captured_at=MAX(captured_at,?)
        WHERE message_id=?
      `).run(
        senderId, senderName, senderAvatarUrl, message.occurredAt ?? null,
        message.turnId ?? null, message.triggerMessageId ?? null,
        message.responseKind ?? null, capturedAt, messageId,
      );
    }
    this.upsertParticipantFromMessageInside(message, capturedAt);
    return existing ? 'updated' : 'inserted';
  }

  private upsertParticipantFromMessageInside(
    message: LogisticsCapturedMessageInput,
    capturedAt: number,
  ): void {
    if (message.role !== 'user') return;
    const userId = identityText(message.senderId, 256);
    if (!userId) return;
    const seenAt = message.occurredAt ?? capturedAt;
    this.db.prepare(`
      INSERT INTO conversation_participants (
        session_key,user_id,user_name,user_avatar_url,first_seen_at,last_seen_at
      ) VALUES (?,?,?,?,?,?)
      ON CONFLICT(session_key,user_id) DO UPDATE SET
        user_name=COALESCE(excluded.user_name,conversation_participants.user_name),
        user_avatar_url=COALESCE(
          excluded.user_avatar_url,conversation_participants.user_avatar_url
        ),
        first_seen_at=MIN(conversation_participants.first_seen_at,excluded.first_seen_at),
        last_seen_at=MAX(conversation_participants.last_seen_at,excluded.last_seen_at)
    `).run(
      `${message.larkAppId}:${message.sessionId}`,
      userId,
      identityText(message.senderName, 200),
      identityText(message.senderAvatarUrl, 2_048),
      seenAt,
      seenAt,
    );
  }

  private refreshConversationInitiatorInside(sessionKey: string): void {
    const first = this.db.prepare(`
      SELECT sender_id
      FROM conversation_messages
      WHERE session_key=? AND role='user' AND sender_id IS NOT NULL AND sender_id<>''
      ORDER BY occurred_at IS NULL,occurred_at,message_id
      LIMIT 1
    `).get(sessionKey) as { sender_id: string } | undefined;
    if (!first) return;
    const participant = this.db.prepare(`
      SELECT user_name,user_avatar_url
      FROM conversation_participants
      WHERE session_key=? AND user_id=?
    `).get(sessionKey, first.sender_id) as {
      user_name?: string | null;
      user_avatar_url?: string | null;
    } | undefined;
    this.db.prepare(`
      UPDATE conversations SET
        initiator_id=?,initiator_name=?,initiator_avatar_url=?
      WHERE lark_app_id || ':' || session_id=?
    `).run(
      first.sender_id,
      participant?.user_name ?? null,
      participant?.user_avatar_url ?? null,
      sessionKey,
    );
  }

  private insertCatalogRow(row: LogisticsSessionCatalogInput): { changes?: number | bigint } {
    const key = `${row.larkAppId}:${row.sessionId}`;
    const updatedAt = Math.max(row.lastMessageAt ?? 0, row.closedAt ?? 0, row.createdAt);
    return this.db.prepare(`
      INSERT OR IGNORE INTO session_catalog (
        session_key,public_id,lark_app_id,session_id,chat_id,root_message_id,scope,
        session_status,title,created_at,last_message_at,closed_at,special_session,
        backfill_status,backfill_error,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      key, sessionPublicId(row.larkAppId, row.sessionId), row.larkAppId, row.sessionId,
      row.chatId, row.rootMessageId, row.scope, row.sessionStatus, safeMetadata(row.title, 120),
      row.createdAt, row.lastMessageAt ?? null, row.closedAt ?? null, row.specialSession ? 1 : 0,
      row.backfillStatus ?? 'pending', safeMetadata(row.backfillError, 500), updatedAt,
    );
  }

  private markSessionBackfillInside(
    larkAppId: string,
    sessionId: string,
    status: LogisticsBackfillStatus,
    error?: string,
    conversationId?: string,
  ): void {
    this.db.prepare(`
      UPDATE session_catalog SET backfill_status=?,backfill_error=?,
        backfill_attempts=backfill_attempts+CASE WHEN ?='processing' THEN 1 ELSE 0 END,
        last_backfill_at=?,conversation_public_id=COALESCE(?,conversation_public_id)
      WHERE lark_app_id=? AND session_id=?
    `).run(
      status, safeMetadata(error, 500), status, Date.now(), conversationId ?? null,
      larkAppId, sessionId,
    );
  }

  private migrate(): void {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as any)?.user_version ?? 0);
    if (version > SCHEMA_VERSION) throw new Error(`logistics_conversation_schema_newer:${version}`);
    if (version === SCHEMA_VERSION) return;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS session_catalog (
          session_key TEXT PRIMARY KEY,
          public_id TEXT NOT NULL UNIQUE,
          lark_app_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          root_message_id TEXT NOT NULL,
          scope TEXT NOT NULL CHECK(scope IN ('thread','chat')),
          session_status TEXT NOT NULL CHECK(session_status IN ('active','closed','unknown')),
          title TEXT,
          created_at INTEGER NOT NULL,
          last_message_at INTEGER,
          closed_at INTEGER,
          special_session INTEGER NOT NULL DEFAULT 0,
          backfill_status TEXT NOT NULL DEFAULT 'pending',
          backfill_error TEXT,
          backfill_attempts INTEGER NOT NULL DEFAULT 0,
          last_backfill_at INTEGER,
          conversation_public_id TEXT,
          updated_at INTEGER NOT NULL,
          UNIQUE(lark_app_id, session_id)
        );
        CREATE INDEX IF NOT EXISTS session_catalog_updated ON session_catalog(updated_at DESC,session_key DESC);
        CREATE INDEX IF NOT EXISTS session_catalog_bot_updated ON session_catalog(lark_app_id,updated_at DESC,session_key DESC);
        CREATE INDEX IF NOT EXISTS session_catalog_backfill ON session_catalog(backfill_status,updated_at DESC);

        CREATE TABLE IF NOT EXISTS conversation_surveys (
          survey_id TEXT PRIMARY KEY,
          lark_app_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          respondent_subject_hash TEXT,
          status TEXT NOT NULL,
          rating INTEGER,
          scheduled_at INTEGER NOT NULL,
          due_at INTEGER NOT NULL,
          sent_at INTEGER,
          answered_at INTEGER,
          failure_reason TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS conversation_surveys_session ON conversation_surveys(lark_app_id,session_id,updated_at DESC);
        CREATE INDEX IF NOT EXISTS conversation_surveys_status ON conversation_surveys(status,updated_at DESC);

        CREATE TABLE IF NOT EXISTS conversations (
          master_key TEXT PRIMARY KEY,
          public_id TEXT NOT NULL UNIQUE,
          lark_app_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          survey_id TEXT,
          chat_id TEXT NOT NULL,
          root_message_id TEXT,
          respondent_subject_hash TEXT,
          initiator_id TEXT,
          initiator_name TEXT,
          initiator_avatar_url TEXT,
          title TEXT,
          recap TEXT,
          answer_message_id TEXT,
          survey_status TEXT,
          rating_state TEXT NOT NULL,
          rating INTEGER,
          rating_count INTEGER NOT NULL DEFAULT 0,
          capture_state TEXT,
          tagging_state TEXT NOT NULL,
          business_category TEXT,
          problem_type TEXT,
          resolution_status TEXT,
          overall_confidence TEXT,
          needs_review INTEGER NOT NULL DEFAULT 0,
          review_reason TEXT,
          transcript TEXT,
          transcript_hash TEXT,
          message_count INTEGER NOT NULL DEFAULT 0,
          harness_revision TEXT,
          business_reason_code TEXT,
          problem_reason_code TEXT,
          resolution_reason_code TEXT,
          evidence_anchors_json TEXT,
          manual_review_status TEXT NOT NULL DEFAULT 'pending',
          model_attempts INTEGER NOT NULL DEFAULT 0,
          model_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(lark_app_id, session_id)
        );
        CREATE INDEX IF NOT EXISTS conversations_updated ON conversations(updated_at, master_key);
        CREATE INDEX IF NOT EXISTS conversations_bot_updated ON conversations(lark_app_id, updated_at, master_key);
        CREATE INDEX IF NOT EXISTS conversations_labels ON conversations(business_category, problem_type, resolution_status, updated_at);
        CREATE INDEX IF NOT EXISTS conversations_review ON conversations(needs_review, updated_at);

        CREATE TABLE IF NOT EXISTS conversation_snapshots (
          snapshot_id TEXT PRIMARY KEY,
          master_key TEXT NOT NULL REFERENCES conversations(master_key) ON DELETE CASCADE,
          transcript_hash TEXT NOT NULL,
          transcript TEXT NOT NULL,
          capture_state TEXT NOT NULL,
          message_count INTEGER NOT NULL,
          harness_revision TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE(master_key, transcript_hash)
        );
        CREATE INDEX IF NOT EXISTS snapshots_master_created ON conversation_snapshots(master_key, created_at DESC);

        CREATE TABLE IF NOT EXISTS label_runs (
          run_id TEXT PRIMARY KEY,
          master_key TEXT NOT NULL REFERENCES conversations(master_key) ON DELETE CASCADE,
          transcript_hash TEXT NOT NULL,
          harness_revision TEXT,
          status TEXT NOT NULL,
          model TEXT,
          attempt INTEGER NOT NULL,
          error TEXT,
          created_at INTEGER NOT NULL,
          completed_at INTEGER,
          UNIQUE(master_key, transcript_hash, harness_revision, attempt)
        );

        CREATE TABLE IF NOT EXISTS conversation_labels (
          label_id TEXT PRIMARY KEY,
          master_key TEXT NOT NULL REFERENCES conversations(master_key) ON DELETE CASCADE,
          transcript_hash TEXT NOT NULL,
          harness_revision TEXT,
          business_category TEXT NOT NULL,
          problem_type TEXT NOT NULL,
          resolution_status TEXT NOT NULL,
          overall_confidence TEXT NOT NULL,
          business_reason_code TEXT,
          problem_reason_code TEXT,
          resolution_reason_code TEXT,
          evidence_anchors_json TEXT,
          needs_review INTEGER NOT NULL,
          review_reason TEXT,
          manual_review_status TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER NOT NULL,
          UNIQUE(master_key, transcript_hash, harness_revision)
        );
      `);
      this.createConversationParticipantsTable();
      if (version < 4) {
        this.migrateConversationMessagesToFacts();
        this.db.exec(`
          UPDATE session_catalog
          SET backfill_status='pending',backfill_error=NULL
          WHERE backfill_status IN ('snapshot_ready','labeled','label_failed');
        `);
      }
      this.createConversationMessagesTable();
      if (version < 5) {
        this.addColumnIfMissing('conversations', 'initiator_id', 'TEXT');
        this.addColumnIfMissing('conversations', 'initiator_name', 'TEXT');
        this.addColumnIfMissing('conversations', 'initiator_avatar_url', 'TEXT');
        this.addColumnIfMissing('conversation_messages', 'sender_id', 'TEXT');
        this.addColumnIfMissing('conversation_messages', 'sender_name', 'TEXT');
        this.addColumnIfMissing('conversation_messages', 'sender_avatar_url', 'TEXT');
      }
      this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION};`);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    const columns = new Set(
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map(item => item.name),
    );
    if (!columns.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
  }

  private createConversationMessagesTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_messages (
        message_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL REFERENCES session_catalog(session_key) ON DELETE CASCADE,
        platform_message_id TEXT,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        sender_id TEXT,
        sender_name TEXT,
        sender_avatar_url TEXT,
        occurred_at INTEGER,
        turn_id TEXT,
        trigger_message_id TEXT,
        response_kind TEXT CHECK(response_kind IS NULL OR response_kind='final'),
        source TEXT NOT NULL,
        captured_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_platform
        ON conversation_messages(session_key,platform_message_id)
        WHERE platform_message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS conversation_messages_session_time
        ON conversation_messages(session_key,occurred_at,message_id);
    `);
  }

  private createConversationParticipantsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_participants (
        session_key TEXT NOT NULL REFERENCES session_catalog(session_key) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        user_name TEXT,
        user_avatar_url TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY(session_key,user_id)
      );
      CREATE INDEX IF NOT EXISTS conversation_participants_session_seen
        ON conversation_participants(session_key,first_seen_at,user_id);
    `);
  }

  private migrateConversationMessagesToFacts(): void {
    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(conversation_messages)').all() as Array<{ name: string }>)
        .map(column => column.name),
    );
    if (!columns.has('snapshot_id')) return;
    this.db.exec('ALTER TABLE conversation_messages RENAME TO conversation_messages_v3;');
    this.createConversationMessagesTable();
    const legacy = this.db.prepare(`
      SELECT m.role,m.content,m.platform_message_id,m.created_at,
        s.created_at snapshot_created_at,c.lark_app_id,c.session_id,c.turn_id,c.answer_message_id
      FROM conversation_messages_v3 m
      JOIN conversation_snapshots s ON s.snapshot_id=m.snapshot_id
      JOIN conversations c ON c.master_key=s.master_key
      ORDER BY s.created_at,m.message_index
    `).all() as Array<{
      role: 'user' | 'assistant';
      content: string;
      platform_message_id?: string | null;
      created_at?: number | null;
      snapshot_created_at: number;
      lark_app_id: string;
      session_id: string;
      turn_id: string;
      answer_message_id?: string | null;
    }>;
    for (const row of legacy) {
      this.upsertCapturedMessageInside({
        larkAppId: row.lark_app_id,
        sessionId: row.session_id,
        role: row.role,
        content: row.content,
        ...(row.platform_message_id ? { platformMessageId: row.platform_message_id } : {}),
        ...(row.created_at !== null && row.created_at !== undefined
          ? { occurredAt: row.created_at }
          : {}),
        turnId: row.turn_id,
        ...(row.role === 'assistant' ? { triggerMessageId: row.turn_id } : {}),
        ...(row.platform_message_id && row.platform_message_id === row.answer_message_id
          ? { responseKind: 'final' as const }
          : {}),
        source: 'legacy_snapshot',
      }, row.snapshot_created_at);
    }
    this.db.exec('DROP TABLE conversation_messages_v3;');
  }

  upsert(record: LogisticsSessionMasterRecord): void {
    const respondentHash = record.respondentOpenId
      ? createHash('sha256').update(record.respondentOpenId).digest('hex')
      : null;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.insertCatalogRow({
        larkAppId: record.larkAppId,
        sessionId: record.sessionId,
        chatId: record.chatId,
        rootMessageId: record.rootMessageId ?? '',
        scope: record.rootMessageId ? 'thread' : 'chat',
        sessionStatus: 'unknown',
        title: record.title,
        createdAt: record.createdAt,
        lastMessageAt: record.updatedAt,
      });
      this.db.prepare(`
        INSERT INTO conversations (
          master_key,public_id,lark_app_id,session_id,turn_id,survey_id,chat_id,root_message_id,
          respondent_subject_hash,title,recap,answer_message_id,survey_status,rating_state,
          rating,rating_count,capture_state,tagging_state,business_category,problem_type,
          resolution_status,overall_confidence,needs_review,review_reason,transcript,
          transcript_hash,message_count,harness_revision,business_reason_code,
          problem_reason_code,resolution_reason_code,evidence_anchors_json,manual_review_status,
          model_attempts,model_error,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(master_key) DO UPDATE SET
          turn_id=excluded.turn_id,survey_id=excluded.survey_id,chat_id=excluded.chat_id,
          root_message_id=excluded.root_message_id,respondent_subject_hash=excluded.respondent_subject_hash,
          title=excluded.title,recap=excluded.recap,answer_message_id=excluded.answer_message_id,
          survey_status=excluded.survey_status,rating_state=excluded.rating_state,rating=excluded.rating,
          rating_count=excluded.rating_count,capture_state=excluded.capture_state,
          tagging_state=excluded.tagging_state,business_category=excluded.business_category,
          problem_type=excluded.problem_type,resolution_status=excluded.resolution_status,
          overall_confidence=excluded.overall_confidence,needs_review=excluded.needs_review,
          review_reason=excluded.review_reason,transcript=excluded.transcript,
          transcript_hash=excluded.transcript_hash,message_count=excluded.message_count,
          harness_revision=excluded.harness_revision,business_reason_code=excluded.business_reason_code,
          problem_reason_code=excluded.problem_reason_code,resolution_reason_code=excluded.resolution_reason_code,
          evidence_anchors_json=excluded.evidence_anchors_json,
          manual_review_status=excluded.manual_review_status,model_attempts=excluded.model_attempts,
          model_error=excluded.model_error,updated_at=excluded.updated_at
      `).run(
        record.masterKey, publicId(record.masterKey), record.larkAppId, record.sessionId, record.turnId, record.surveyId,
        record.chatId, record.rootMessageId, respondentHash, safeMetadata(record.title, 120), safeMetadata(record.recap, 500),
        record.answerMessageId ?? null, record.surveyStatus, record.ratingState, record.rating ?? null,
        record.ratingCount, record.captureState ?? null, record.taggingState,
        record.businessCategory ?? null, record.problemType ?? null, record.resolutionStatus ?? null,
        record.overallConfidence ?? null, record.needsReview ? 1 : 0, safeMetadata(record.reviewReason, 500),
        record.transcript ?? null, record.transcriptHash ?? null, record.messages?.length ?? 0,
        record.harnessRevision ?? null, record.businessReasonCode ?? null,
        record.problemReasonCode ?? null, record.resolutionReasonCode ?? null,
        json(record.evidenceAnchors ?? []), record.manualReviewStatus ?? 'pending', record.modelAttempts,
        safeMetadata(record.modelError, 500), record.createdAt, record.updatedAt,
      );

      const conversationId = publicId(record.masterKey);
      const catalogStatus: LogisticsBackfillStatus = record.transcript && record.transcriptHash
        ? 'captured'
        : 'pending';
      this.markSessionBackfillInside(record.larkAppId, record.sessionId, catalogStatus, undefined, conversationId);

      if (record.transcript && record.transcriptHash && record.captureState) {
        const snapshotId = `snap_${createHash('sha256').update(`${record.masterKey}:${record.transcriptHash}`).digest('hex')}`;
        this.db.prepare(`
          INSERT OR IGNORE INTO conversation_snapshots
            (snapshot_id,master_key,transcript_hash,transcript,capture_state,message_count,harness_revision,created_at)
          VALUES (?,?,?,?,?,?,?,?)
        `).run(snapshotId, record.masterKey, record.transcriptHash, record.transcript,
          record.captureState, record.messages?.length ?? 0, record.harnessRevision ?? null, record.updatedAt);
        if (record.messages?.length) {
          record.messages.forEach(message => this.upsertCapturedMessageInside({
            larkAppId: record.larkAppId,
            sessionId: record.sessionId,
            role: message.role,
            content: message.content,
            ...(message.senderId ? { senderId: message.senderId } : {}),
            ...(message.senderName ? { senderName: message.senderName } : {}),
            ...(message.senderAvatarUrl ? { senderAvatarUrl: message.senderAvatarUrl } : {}),
            ...(message.messageId ? { platformMessageId: message.messageId } : {}),
            ...(message.createdAt ? { occurredAt: message.createdAt } : {}),
            turnId: message.role === 'user' && message.messageId ? message.messageId : record.turnId,
            ...(message.role === 'assistant' ? { triggerMessageId: record.turnId } : {}),
            ...(message.messageId && message.messageId === record.answerMessageId
              ? { responseKind: 'final' as const }
              : {}),
            source: 'snapshot_projection',
          }, record.updatedAt));
        }
        if (record.businessCategory && record.problemType && record.resolutionStatus && record.overallConfidence) {
          const labelId = `label_${createHash('sha256').update(`${record.masterKey}:${record.transcriptHash}:${record.harnessRevision ?? ''}`).digest('hex')}`;
          this.db.prepare(`
            INSERT OR REPLACE INTO conversation_labels (
              label_id,master_key,transcript_hash,harness_revision,business_category,problem_type,
              resolution_status,overall_confidence,business_reason_code,problem_reason_code,
              resolution_reason_code,evidence_anchors_json,needs_review,review_reason,
              manual_review_status,created_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(labelId, record.masterKey, record.transcriptHash, record.harnessRevision ?? null,
            record.businessCategory, record.problemType, record.resolutionStatus, record.overallConfidence,
            record.businessReasonCode ?? null, record.problemReasonCode ?? null,
            record.resolutionReasonCode ?? null, json(record.evidenceAnchors ?? []),
            record.needsReview ? 1 : 0, record.reviewReason ?? null,
            record.manualReviewStatus ?? 'pending', record.updatedAt);
        }
      }
      this.refreshConversationInitiatorInside(`${record.larkAppId}:${record.sessionId}`);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  upsertCapture(record: LogisticsSessionMasterRecord, fullMessageCount: number): void {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.insertCatalogRow({
        larkAppId: record.larkAppId,
        sessionId: record.sessionId,
        chatId: record.chatId,
        rootMessageId: record.rootMessageId ?? '',
        scope: record.rootMessageId ? 'thread' : 'chat',
        sessionStatus: 'unknown',
        title: record.title,
        createdAt: record.createdAt,
        lastMessageAt: record.updatedAt,
      });
      const existing = this.db.prepare(`
        SELECT master_key FROM conversations WHERE lark_app_id=? AND session_id=?
      `).get(record.larkAppId, record.sessionId) as { master_key: string } | undefined;
      const masterKey = existing?.master_key ?? record.masterKey;
      if (existing) {
        this.db.prepare(`
          UPDATE conversations SET
            turn_id=?,chat_id=?,root_message_id=?,title=?,answer_message_id=?,
            capture_state=?,transcript=?,transcript_hash=?,message_count=?,
            review_reason=CASE
              WHEN review_reason IS NULL OR review_reason='' THEN ?
              ELSE review_reason
            END,
            updated_at=MAX(updated_at,?)
          WHERE master_key=?
        `).run(
          record.turnId, record.chatId, record.rootMessageId, safeMetadata(record.title, 120),
          record.answerMessageId ?? null, record.captureState ?? null, record.transcript ?? null,
          record.transcriptHash ?? null, fullMessageCount, safeMetadata(record.reviewReason, 500),
          record.updatedAt, masterKey,
        );
      } else {
        this.db.prepare(`
          INSERT INTO conversations (
            master_key,public_id,lark_app_id,session_id,turn_id,survey_id,chat_id,root_message_id,
            respondent_subject_hash,title,answer_message_id,survey_status,rating_state,rating_count,
            capture_state,tagging_state,needs_review,review_reason,transcript,transcript_hash,
            message_count,manual_review_status,model_attempts,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          masterKey, publicId(masterKey), record.larkAppId, record.sessionId, record.turnId,
          record.surveyId, record.chatId, record.rootMessageId, null, safeMetadata(record.title, 120),
          record.answerMessageId ?? null, record.surveyStatus, record.ratingState, record.ratingCount,
          record.captureState ?? null, 'needs_review', record.needsReview ? 1 : 0,
          safeMetadata(record.reviewReason, 500), record.transcript ?? null,
          record.transcriptHash ?? null, fullMessageCount, 'pending', 0,
          record.createdAt, record.updatedAt,
        );
      }

      const conversationId = publicId(masterKey);
      if (record.transcript && record.transcriptHash && record.captureState) {
        const snapshotId = `snap_${createHash('sha256').update(`${masterKey}:${record.transcriptHash}`).digest('hex')}`;
        this.db.prepare(`
          INSERT OR IGNORE INTO conversation_snapshots
            (snapshot_id,master_key,transcript_hash,transcript,capture_state,message_count,harness_revision,created_at)
          VALUES (?,?,?,?,?,?,?,?)
        `).run(
          snapshotId, masterKey, record.transcriptHash, record.transcript,
          record.captureState, record.messages?.length ?? 0, null, record.updatedAt,
        );
      }
      this.markSessionBackfillInside(
        record.larkAppId,
        record.sessionId,
        'captured',
        undefined,
        conversationId,
      );
      this.refreshConversationInitiatorInside(`${record.larkAppId}:${record.sessionId}`);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  listLabelingRecords(filters: { larkAppId?: string; sessionPrefix?: string } = {}): LogisticsSessionMasterRecord[] {
    const rows = this.db.prepare(`
      SELECT c.*,sc.scope,sc.created_at session_created_at
      FROM conversations c
      JOIN session_catalog sc ON sc.lark_app_id=c.lark_app_id AND sc.session_id=c.session_id
      WHERE sc.backfill_status='captured'
        AND c.transcript_hash IS NOT NULL
        AND (? IS NULL OR c.lark_app_id=?)
      ORDER BY c.master_key
    `).all(filters.larkAppId ?? null, filters.larkAppId ?? null) as any[];
    const messagesFor = this.db.prepare(`
      SELECT platform_message_id,role,content,occurred_at
      FROM conversation_messages
      WHERE session_key=?
      ORDER BY occurred_at IS NULL,occurred_at,message_id
    `);
    return rows
      .filter(row => !filters.sessionPrefix || String(row.session_id).startsWith(filters.sessionPrefix))
      .map(row => {
        const sessionKey = `${row.lark_app_id}:${row.session_id}`;
        const messages = (messagesFor.all(sessionKey) as any[]).map(message => ({
          messageId: String(message.platform_message_id ?? ''),
          senderType: message.role === 'user' ? 'user' : 'app',
          content: String(message.content),
          ...(message.occurred_at === null || message.occurred_at === undefined
            ? {}
            : { createTime: String(message.occurred_at) }),
        }));
        const snapshot = buildLogisticsSessionSnapshot({
          turnId: String(row.turn_id),
          ...(row.answer_message_id ? { answerMessageId: String(row.answer_message_id) } : {}),
          rootMessageId: row.scope === 'chat' ? null : String(row.root_message_id ?? ''),
          sessionStartedAt: new Date(Number(row.session_created_at)).toISOString(),
          messages,
        });
        if (snapshot.transcriptHash !== row.transcript_hash) {
          throw new Error(`label_snapshot_hash_mismatch:${row.public_id}`);
        }
        return {
          masterKey: String(row.master_key),
          larkAppId: String(row.lark_app_id),
          sessionId: String(row.session_id),
          turnId: String(row.turn_id),
          surveyId: String(row.survey_id ?? `turn_${row.turn_id}`),
          settledSurveyIds: [],
          ratingCount: Number(row.rating_count ?? 0),
          chatId: String(row.chat_id),
          rootMessageId: row.root_message_id ? String(row.root_message_id) : null,
          respondentOpenId: '',
          ...(row.title ? { title: String(row.title) } : {}),
          ...(row.recap ? { recap: String(row.recap) } : {}),
          ...(row.answer_message_id ? { answerMessageId: String(row.answer_message_id) } : {}),
          surveyStatus: String(row.survey_status ?? 'scheduled') as FeedbackSurveyRecord['status'],
          dueAt: Number(row.updated_at),
          ...(row.rating !== null && row.rating !== undefined ? { rating: Number(row.rating) } : {}),
          ratingState: String(row.rating_state ?? 'awaiting') as LogisticsSessionMasterRecord['ratingState'],
          transcript: snapshot.transcript,
          transcriptHash: snapshot.transcriptHash,
          captureState: snapshot.captureState,
          messages: snapshot.messages,
          taggingState: String(row.tagging_state ?? 'needs_review') as LogisticsSessionMasterRecord['taggingState'],
          ...(row.business_category ? { businessCategory: String(row.business_category) } : {}),
          ...(row.problem_type ? { problemType: String(row.problem_type) } : {}),
          ...(row.resolution_status ? { resolutionStatus: String(row.resolution_status) as LogisticsSessionMasterRecord['resolutionStatus'] } : {}),
          ...(row.overall_confidence ? { overallConfidence: String(row.overall_confidence) as LogisticsSessionMasterRecord['overallConfidence'] } : {}),
          needsReview: bool(row.needs_review),
          ...(row.review_reason ? { reviewReason: String(row.review_reason) } : {}),
          ...(row.harness_revision ? { harnessRevision: String(row.harness_revision) } : {}),
          ...(row.business_reason_code ? { businessReasonCode: String(row.business_reason_code) } : {}),
          ...(row.problem_reason_code ? { problemReasonCode: String(row.problem_reason_code) } : {}),
          ...(row.resolution_reason_code ? { resolutionReasonCode: String(row.resolution_reason_code) } : {}),
          evidenceAnchors: parseJson<LogisticsEvidenceAnchor[]>(row.evidence_anchors_json, []),
          manualReviewStatus: 'pending',
          modelAttempts: Number(row.model_attempts ?? 0),
          ...(row.model_error ? { modelError: String(row.model_error) } : {}),
          baseSyncAttempts: 0,
          createdAt: Number(row.session_created_at),
          updatedAt: Number(row.updated_at),
        };
      });
  }

  labelRunState(masterKey: string, transcriptHash: string, harnessRevision: string): LogisticsLabelRunState {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(attempt),0) max_attempt,
        COALESCE(SUM(status='completed'),0) completed
      FROM label_runs
      WHERE master_key=? AND transcript_hash=? AND harness_revision=?
    `).get(masterKey, transcriptHash, harnessRevision) as any;
    return {
      completed: Number(row?.completed ?? 0) > 0,
      nextAttempt: Number(row?.max_attempt ?? 0) + 1,
    };
  }

  completeLabeling(input: {
    record: LogisticsSessionMasterRecord;
    tagging: LogisticsModelTagging;
    harnessRevision: string;
    attempt: number;
    model?: string;
    startedAt: number;
    completedAt: number;
  }): void {
    const { record, tagging } = input;
    if (!record.transcript || !record.transcriptHash || !record.captureState) {
      throw new Error('label_record_snapshot_missing');
    }
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const snapshotId = `snap_${createHash('sha256').update(`${record.masterKey}:${record.transcriptHash}`).digest('hex')}`;
      this.db.prepare(`
        INSERT OR IGNORE INTO conversation_snapshots
          (snapshot_id,master_key,transcript_hash,transcript,capture_state,message_count,harness_revision,created_at)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(
        snapshotId, record.masterKey, record.transcriptHash, record.transcript,
        record.captureState, record.messages?.length ?? 0, input.harnessRevision, input.completedAt,
      );
      this.db.prepare(`
        UPDATE conversation_snapshots SET harness_revision=?
        WHERE master_key=? AND transcript_hash=?
      `).run(input.harnessRevision, record.masterKey, record.transcriptHash);
      this.db.prepare(`
        UPDATE conversations SET
          tagging_state=?,business_category=?,problem_type=?,resolution_status=?,
          overall_confidence=?,needs_review=?,review_reason=?,harness_revision=?,
          business_reason_code=?,problem_reason_code=?,resolution_reason_code=?,
          evidence_anchors_json=?,manual_review_status=?,model_attempts=?,
          model_error=NULL,updated_at=?
        WHERE master_key=?
      `).run(
        tagging.needsReview ? 'needs_review' : 'tagged',
        tagging.businessCategory, tagging.problemType, tagging.resolutionStatus,
        tagging.overallConfidence, tagging.needsReview ? 1 : 0,
        safeMetadata(tagging.reviewReason, 500), input.harnessRevision,
        tagging.businessReasonCode ?? null, tagging.problemReasonCode ?? null,
        tagging.resolutionReasonCode ?? null, json(tagging.evidenceAnchors ?? []),
        tagging.manualReviewStatus ?? 'pending', input.attempt, input.completedAt,
        record.masterKey,
      );
      const labelId = `label_${createHash('sha256').update(`${record.masterKey}:${record.transcriptHash}:${input.harnessRevision}`).digest('hex')}`;
      this.db.prepare(`
        INSERT OR REPLACE INTO conversation_labels (
          label_id,master_key,transcript_hash,harness_revision,business_category,problem_type,
          resolution_status,overall_confidence,business_reason_code,problem_reason_code,
          resolution_reason_code,evidence_anchors_json,needs_review,review_reason,
          manual_review_status,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        labelId, record.masterKey, record.transcriptHash, input.harnessRevision,
        tagging.businessCategory, tagging.problemType, tagging.resolutionStatus,
        tagging.overallConfidence, tagging.businessReasonCode ?? null,
        tagging.problemReasonCode ?? null, tagging.resolutionReasonCode ?? null,
        json(tagging.evidenceAnchors ?? []), tagging.needsReview ? 1 : 0,
        safeMetadata(tagging.reviewReason, 500), tagging.manualReviewStatus ?? 'pending',
        input.completedAt,
      );
      this.recordLabelRunInside({
        masterKey: record.masterKey,
        transcriptHash: record.transcriptHash,
        harnessRevision: input.harnessRevision,
        status: 'completed',
        model: input.model,
        attempt: input.attempt,
        createdAt: input.startedAt,
        completedAt: input.completedAt,
      });
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  failLabeling(input: {
    masterKey: string;
    transcriptHash: string;
    harnessRevision: string;
    attempt: number;
    model?: string;
    error: string;
    startedAt: number;
    completedAt: number;
  }): void {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.recordLabelRunInside({
        masterKey: input.masterKey,
        transcriptHash: input.transcriptHash,
        harnessRevision: input.harnessRevision,
        status: 'failed',
        model: input.model,
        attempt: input.attempt,
        error: input.error,
        createdAt: input.startedAt,
        completedAt: input.completedAt,
      });
      this.db.prepare(`
        UPDATE conversations SET
          tagging_state=CASE
            WHEN EXISTS(SELECT 1 FROM conversation_labels cl WHERE cl.master_key=conversations.master_key)
              THEN tagging_state
            ELSE 'needs_review'
          END,
          needs_review=CASE
            WHEN EXISTS(SELECT 1 FROM conversation_labels cl WHERE cl.master_key=conversations.master_key)
              THEN needs_review
            ELSE 1
          END,
          review_reason=CASE
            WHEN review_reason IS NULL OR review_reason='' THEN '自动打标失败，等待重试'
            ELSE review_reason
          END,
          model_attempts=?,model_error=?,updated_at=MAX(updated_at,?)
        WHERE master_key=?
      `).run(
        input.attempt, safeMetadata(input.error, 500), input.completedAt, input.masterKey,
      );
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  recordLabelRun(input: {
    masterKey: string;
    transcriptHash: string;
    harnessRevision?: string;
    status: 'running' | 'completed' | 'failed';
    model?: string;
    attempt: number;
    error?: string;
    createdAt: number;
    completedAt?: number;
  }): string {
    return this.recordLabelRunInside(input);
  }

  private recordLabelRunInside(input: {
    masterKey: string;
    transcriptHash: string;
    harnessRevision?: string;
    status: 'running' | 'completed' | 'failed';
    model?: string;
    attempt: number;
    error?: string;
    createdAt: number;
    completedAt?: number;
  }): string {
    const runId = `run_${createHash('sha256').update(`${input.masterKey}:${input.transcriptHash}:${input.harnessRevision ?? ''}:${input.attempt}`).digest('hex')}`;
    this.db.prepare(`
      INSERT OR REPLACE INTO label_runs
        (run_id,master_key,transcript_hash,harness_revision,status,model,attempt,error,created_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(runId, input.masterKey, input.transcriptHash, input.harnessRevision ?? null,
      input.status, input.model ?? null, input.attempt, input.error ?? null,
      input.createdAt, input.completedAt ?? null);
    return runId;
  }

  importLegacyJson(dataDir: string, larkAppId?: string): { files: number; records: number } {
    const dir = join(dataDir, 'logistics-session-master');
    if (!existsSync(dir)) return { files: 0, records: 0 };
    let files = 0;
    let records = 0;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      if (larkAppId && name !== `${larkAppId.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`) continue;
      try {
        const payload = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { records?: LogisticsSessionMasterRecord[] };
        if (!Array.isArray(payload.records)) continue;
        files += 1;
        for (const record of payload.records) {
          if (!record?.masterKey || !record?.sessionId || !record?.larkAppId) continue;
          if (String((record as { resolutionStatus?: unknown }).resolutionStatus ?? '') === 'unresolved') {
            record.resolutionStatus = 'unknown';
            record.needsReview = true;
            record.reviewReason = record.reviewReason
              ? `${record.reviewReason}；旧未解决状态迁移为 unknown`
              : '旧未解决状态迁移为 unknown';
          }
          this.upsert(record);
          records += 1;
        }
      } catch {
        // A corrupt legacy file is not allowed to block other bot stores.
      }
    }
    return { files, records };
  }

  importFeedbackSurveyJson(dataDir: string, larkAppId?: string): { files: number; records: number } {
    const dir = join(dataDir, 'feedback-surveys');
    if (!existsSync(dir)) return { files: 0, records: 0 };
    let files = 0;
    let records = 0;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        if (larkAppId && name !== `${larkAppId.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`) continue;
        try {
          const payload = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { records?: FeedbackSurveyRecord[] };
          if (!Array.isArray(payload.records)) continue;
          files += 1;
          for (const record of payload.records) {
            if (!record?.surveyId || !record?.larkAppId || !record?.sessionId || !record?.turnId) continue;
            const respondentHash = record.respondentOpenId
              ? createHash('sha256').update(record.respondentOpenId).digest('hex') : null;
            this.db.prepare(`
              INSERT INTO conversation_surveys (
                survey_id,lark_app_id,session_id,turn_id,respondent_subject_hash,status,rating,
                scheduled_at,due_at,sent_at,answered_at,failure_reason,updated_at
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(survey_id) DO UPDATE SET status=excluded.status,rating=excluded.rating,
                sent_at=excluded.sent_at,answered_at=excluded.answered_at,
                failure_reason=excluded.failure_reason,updated_at=excluded.updated_at
            `).run(
              record.surveyId, record.larkAppId, record.sessionId, record.turnId,
              respondentHash, record.status, record.rating ?? null, record.scheduledAt,
              record.dueAt, record.sentAt ?? null, record.answeredAt ?? null,
              safeMetadata(record.failureReason, 500), record.updatedAt,
            );
            records += 1;
          }
        } catch {
          // A corrupt survey file is isolated from other bot stores.
        }
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    return { files, records };
  }

  summary(filters: LogisticsConversationFilters = {}): LogisticsConversationSummary {
    const w = where(filters);
    const analyzable = analyzableConversationCondition();
    const row = this.db.prepare(`
      SELECT COUNT(*) total_sessions,
        COALESCE(SUM(${analyzable}),0) conversations,
        COALESCE(SUM(c.master_key IS NOT NULL AND EXISTS(SELECT 1 FROM conversation_snapshots cs WHERE cs.master_key=c.master_key)),0) snapshotted,
        COALESCE(SUM(${analyzable} AND c.harness_revision IS NOT NULL
          AND c.business_category IS NOT NULL AND c.problem_type IS NOT NULL
          AND c.resolution_status IS NOT NULL),0) labeled,
        COALESCE(SUM(sc.backfill_status IN ('pending','processing')),0) pending_backfill,
        COALESCE(SUM(sc.backfill_status IN ('missing_turn','missing_answer','history_failed')),0) failed_backfill,
        COALESCE(SUM((SELECT COUNT(*) FROM conversation_messages cm WHERE cm.session_key=sc.session_key)),0) messages,
        COALESCE(SUM(${analyzable} AND c.resolution_status='resolved'),0) resolved,
        COALESCE(SUM(${analyzable} AND c.resolution_status='in_progress'),0) in_progress,
        COALESCE(SUM(${analyzable} AND (c.resolution_status='unknown' OR c.resolution_status IS NULL)),0) unknown_count,
        COALESCE(SUM(${analyzable} AND c.needs_review=1),0) needs_review,
        COALESCE(SUM(c.rating IS NOT NULL),0) rated,
        AVG(c.rating) average_rating
      FROM session_catalog sc
      LEFT JOIN conversations c ON c.lark_app_id=sc.lark_app_id AND c.session_id=sc.session_id
      ${w.sql}
    `).get(...w.params) as any;
    const survey = this.db.prepare(`
      SELECT COUNT(*) survey_records,COALESCE(SUM(s.status='answered'),0) answered_surveys,AVG(s.rating) average_rating
      FROM conversation_surveys s
      LEFT JOIN session_catalog sc ON s.lark_app_id=sc.lark_app_id AND s.session_id=sc.session_id
      LEFT JOIN conversations c ON c.lark_app_id=sc.lark_app_id AND c.session_id=sc.session_id
      ${w.sql}
    `).get(...w.params) as any;
    const totalSessions = Number(row.total_sessions ?? 0);
    const conversations = Number(row.conversations ?? 0);
    const labeled = Number(row.labeled ?? 0);
    const resolved = Number(row.resolved ?? 0);
    return {
      totalSessions,
      conversations,
      snapshotted: Number(row.snapshotted ?? 0),
      labeled,
      pendingBackfill: Number(row.pending_backfill ?? 0),
      failedBackfill: Number(row.failed_backfill ?? 0),
      analysisCoverage: totalSessions ? conversations / totalSessions : 0,
      labelCoverage: conversations ? labeled / conversations : 0,
      surveyRecords: Number(survey.survey_records ?? 0),
      answeredSurveys: Number(survey.answered_surveys ?? 0),
      messages: Number(row.messages ?? 0),
      resolved,
      inProgress: Number(row.in_progress ?? 0),
      unknown: Number(row.unknown_count ?? 0),
      needsReview: Number(row.needs_review ?? 0),
      rated: Number(row.rated ?? 0),
      averageRating: survey.average_rating === null || survey.average_rating === undefined
        ? null : Math.round(Number(survey.average_rating) * 100) / 100,
      resolutionRate: conversations ? resolved / conversations : 0,
    };
  }

  trend(filters: LogisticsConversationFilters = {}): Array<{ day: string; totalSessions: number; conversations: number; resolved: number; resolutionRate: number }> {
    const w = where(filters);
    const analyzable = analyzableConversationCondition();
    return (this.db.prepare(`
      SELECT date(COALESCE(sc.last_message_at,sc.closed_at,sc.created_at,c.updated_at)/1000,'unixepoch','+8 hours') day,
        COUNT(*) total_sessions, COALESCE(SUM(${analyzable}),0) conversations,
        COALESCE(SUM(${analyzable} AND c.resolution_status='resolved'),0) resolved
      FROM session_catalog sc
      LEFT JOIN conversations c ON c.lark_app_id=sc.lark_app_id AND c.session_id=sc.session_id
      ${w.sql}
      GROUP BY day ORDER BY day
    `).all(...w.params) as any[]).map(row => ({
      day: String(row.day),
      totalSessions: Number(row.total_sessions),
      conversations: Number(row.conversations),
      resolved: Number(row.resolved),
      resolutionRate: Number(row.conversations) ? Number(row.resolved) / Number(row.conversations) : 0,
    }));
  }

  distributions(filters: LogisticsConversationFilters = {}): Record<string, Array<{ key: string; count: number }>> {
    const w = where(filters);
    const group = (column: string, analyzableOnly: boolean) => (this.db.prepare(`
      SELECT COALESCE(${column},'unknown') key, COUNT(*) count
      FROM session_catalog sc
      LEFT JOIN conversations c ON c.lark_app_id=sc.lark_app_id AND c.session_id=sc.session_id
      ${analyzableOnly
        ? appendWhereCondition(w.sql, analyzableConversationCondition())
        : w.sql}
      GROUP BY key ORDER BY count DESC,key
    `).all(...w.params) as any[]).map(row => ({ key: String(row.key), count: Number(row.count) }));
    return {
      business: group('c.business_category', true),
      problem: group('c.problem_type', true),
      resolution: group('c.resolution_status', true),
      confidence: group('c.overall_confidence', true),
      dataStatus: group('sc.backfill_status', false),
    };
  }

  list(filters: LogisticsConversationFilters = {}, page: { limit?: number; offset?: number } = {}): { items: LogisticsConversationListItem[]; total: number } {
    const w = where(filters);
    const rawLimit = Number(page.limit ?? 50);
    const rawOffset = Number(page.offset ?? 0);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(Math.trunc(rawLimit), 200)) : 50;
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
    const joins = `FROM session_catalog sc LEFT JOIN conversations c ON c.lark_app_id=sc.lark_app_id AND c.session_id=sc.session_id`;
    const total = Number((this.db.prepare(`SELECT COUNT(*) count ${joins} ${w.sql}`).get(...w.params) as any)?.count ?? 0);
    const rows = this.db.prepare(`
      SELECT sc.public_id session_public_id,sc.lark_app_id,sc.session_status,sc.scope,
        sc.backfill_status,sc.title session_title,sc.created_at session_created_at,
        COALESCE(sc.last_message_at,sc.closed_at,sc.created_at) session_updated_at,
        c.public_id conversation_id,c.capture_state,c.tagging_state,c.business_category,
        c.problem_type,c.resolution_status,c.overall_confidence,c.needs_review,c.review_reason,
        c.rating,c.rating_count,
        (SELECT COUNT(*) FROM conversation_messages cm WHERE cm.session_key=sc.session_key) message_count
      ${joins} ${w.sql}
      ORDER BY session_updated_at DESC,sc.session_key DESC LIMIT ? OFFSET ?
    `).all(...w.params, limit, offset) as any[];
    return { total, items: rows.map(row => this.catalogListItem(row)) };
  }

  listProjectBaseRows(larkAppId?: string): LogisticsProjectBaseSourceRow[] {
    const rows = this.db.prepare(`
      SELECT c.public_id conversation_key,sc.public_id session_public_id,c.lark_app_id,
        c.initiator_name,COALESCE(c.title,sc.title) title,sc.created_at conversation_at,
        sc.backfill_status,c.capture_state,c.tagging_state,c.business_category,c.problem_type,
        c.resolution_status,c.overall_confidence,c.needs_review,c.review_reason,
        c.harness_revision,c.business_reason_code,c.problem_reason_code,
        c.resolution_reason_code,c.rating,c.survey_status,c.updated_at
      FROM conversations c
      JOIN session_catalog sc ON sc.lark_app_id=c.lark_app_id AND sc.session_id=c.session_id
      WHERE (? IS NULL OR c.lark_app_id=?)
      ORDER BY c.public_id
    `).all(larkAppId ?? null, larkAppId ?? null) as any[];
    return rows.map(row => ({
      conversationKey: String(row.conversation_key),
      sessionPublicId: String(row.session_public_id),
      larkAppId: String(row.lark_app_id),
      ...(row.initiator_name ? { initiatorName: String(row.initiator_name) } : {}),
      ...(row.title ? { title: String(row.title) } : {}),
      conversationAt: Number(row.conversation_at),
      dataStatus: String(row.backfill_status ?? 'pending') as LogisticsBackfillStatus,
      ...(row.capture_state ? { captureState: String(row.capture_state) } : {}),
      taggingState: String(row.tagging_state ?? 'pending_capture'),
      ...(row.business_category ? { businessCategory: String(row.business_category) } : {}),
      ...(row.problem_type ? { problemType: String(row.problem_type) } : {}),
      ...(row.resolution_status ? { resolutionStatus: String(row.resolution_status) } : {}),
      ...(row.overall_confidence ? { overallConfidence: String(row.overall_confidence) } : {}),
      needsReview: bool(row.needs_review),
      ...(row.review_reason ? { reviewReason: String(row.review_reason) } : {}),
      ...(row.harness_revision ? { harnessRevision: String(row.harness_revision) } : {}),
      ...(row.business_reason_code ? { businessReasonCode: String(row.business_reason_code) } : {}),
      ...(row.problem_reason_code ? { problemReasonCode: String(row.problem_reason_code) } : {}),
      ...(row.resolution_reason_code ? { resolutionReasonCode: String(row.resolution_reason_code) } : {}),
      ...(row.rating !== null && row.rating !== undefined ? { rating: Number(row.rating) } : {}),
      ...(row.survey_status ? { surveyStatus: String(row.survey_status) } : {}),
      updatedAt: Number(row.updated_at),
    }));
  }

  identityCoverage(larkAppId?: string): LogisticsIdentityCoverage {
    const conversation = this.db.prepare(`
      SELECT COUNT(*) conversations,
        COALESCE(SUM(initiator_id IS NOT NULL AND initiator_id<>''),0) initiators,
        COALESCE(SUM(initiator_name IS NOT NULL AND initiator_name<>''),0) initiator_names
      FROM conversations
      WHERE (? IS NULL OR lark_app_id=?)
    `).get(larkAppId ?? null, larkAppId ?? null) as any;
    const message = this.db.prepare(`
      SELECT COUNT(*) messages,
        COALESCE(SUM(cm.sender_id IS NOT NULL AND cm.sender_id<>''),0) message_senders,
        COALESCE(SUM(cm.sender_name IS NOT NULL AND cm.sender_name<>''),0) message_sender_names,
        COALESCE(SUM(cm.role='user'),0) user_messages,
        COALESCE(SUM(cm.role='user' AND cm.sender_id IS NOT NULL AND cm.sender_id<>''),0)
          user_message_senders
      FROM conversation_messages cm
      JOIN session_catalog sc ON sc.session_key=cm.session_key
      WHERE (? IS NULL OR sc.lark_app_id=?)
    `).get(larkAppId ?? null, larkAppId ?? null) as any;
    const participant = this.db.prepare(`
      SELECT COUNT(*) participants,
        COALESCE(SUM(cp.user_name IS NOT NULL AND cp.user_name<>''),0) participant_names
      FROM conversation_participants cp
      JOIN session_catalog sc ON sc.session_key=cp.session_key
      WHERE (? IS NULL OR sc.lark_app_id=?)
    `).get(larkAppId ?? null, larkAppId ?? null) as any;
    return {
      conversations: Number(conversation.conversations ?? 0),
      initiators: Number(conversation.initiators ?? 0),
      initiatorNames: Number(conversation.initiator_names ?? 0),
      messages: Number(message.messages ?? 0),
      messageSenders: Number(message.message_senders ?? 0),
      messageSenderNames: Number(message.message_sender_names ?? 0),
      userMessages: Number(message.user_messages ?? 0),
      userMessageSenders: Number(message.user_message_senders ?? 0),
      participants: Number(participant.participants ?? 0),
      participantNames: Number(participant.participant_names ?? 0),
    };
  }

  detail(conversationId: string): LogisticsConversationDetail | undefined {
    const row = this.db.prepare(`
      SELECT c.*,sc.public_id session_public_id,sc.session_status,sc.scope,sc.backfill_status,
        sc.title session_title,sc.created_at session_created_at,
        COALESCE(sc.last_message_at,sc.closed_at,sc.created_at) session_updated_at
      FROM conversations c JOIN session_catalog sc
        ON c.lark_app_id=sc.lark_app_id AND c.session_id=sc.session_id
      WHERE c.public_id=?
    `).get(conversationId) as any;
    if (!row) return undefined;
    const snapshotRows = this.db.prepare(`
      SELECT snapshot_id,transcript_hash,capture_state,message_count,harness_revision,created_at
      FROM conversation_snapshots WHERE master_key=? ORDER BY created_at DESC
    `).all(row.master_key) as any[];
    const sessionKey = `${row.lark_app_id}:${row.session_id}`;
    const messages = (this.db.prepare(`
      SELECT role,content,platform_message_id,occurred_at FROM conversation_messages
      WHERE session_key=? ORDER BY occurred_at IS NULL,occurred_at,message_id
    `).all(sessionKey) as any[]).map(item => ({
      role: String(item.role), content: String(item.content),
      ...(item.occurred_at ? { createdAt: Number(item.occurred_at) } : {}),
    }));
    return {
      ...this.catalogListItem({
        ...row, conversation_id: row.public_id, session_public_id: row.session_public_id,
        session_title: row.title ?? row.session_title, session_created_at: row.session_created_at,
        session_updated_at: row.session_updated_at, backfill_status: row.backfill_status,
      }),
      ...(row.transcript ? { transcript: String(row.transcript) } : {}),
      ...(row.transcript_hash ? { transcriptHash: String(row.transcript_hash) } : {}),
      ...(row.harness_revision ? { harnessRevision: String(row.harness_revision) } : {}),
      ...(row.business_reason_code ? { businessReasonCode: String(row.business_reason_code) } : {}),
      ...(row.problem_reason_code ? { problemReasonCode: String(row.problem_reason_code) } : {}),
      ...(row.resolution_reason_code ? { resolutionReasonCode: String(row.resolution_reason_code) } : {}),
      evidenceAnchors: parseJson<LogisticsEvidenceAnchor[]>(row.evidence_anchors_json, []),
      manualReviewStatus: String(row.manual_review_status ?? 'pending'),
      messages,
      snapshots: snapshotRows.map(item => ({
        captureState: String(item.capture_state),
        messageCount: Number(item.message_count), createdAt: Number(item.created_at),
        ...(item.harness_revision ? { harnessRevision: String(item.harness_revision) } : {}),
      })),
    };
  }

  private catalogListItem(row: any): LogisticsConversationListItem {
    return {
      sessionPublicId: String(row.session_public_id),
      ...(row.conversation_id ? { conversationId: String(row.conversation_id) } : {}),
      larkAppId: String(row.lark_app_id),
      sessionStatus: String(row.session_status ?? 'unknown'),
      scope: String(row.scope ?? 'thread'),
      dataStatus: String(row.backfill_status ?? 'pending') as LogisticsBackfillStatus,
      ...(row.session_title ? { title: String(row.session_title) } : {}),
      ...(row.capture_state ? { captureState: String(row.capture_state) } : {}),
      taggingState: String(row.tagging_state ?? 'pending'),
      ...(row.business_category ? { businessCategory: String(row.business_category) } : {}),
      ...(row.problem_type ? { problemType: String(row.problem_type) } : {}),
      ...(row.resolution_status ? { resolutionStatus: String(row.resolution_status) } : {}),
      ...(row.overall_confidence ? { overallConfidence: String(row.overall_confidence) } : {}),
      needsReview: bool(row.needs_review),
      ...(row.review_reason ? { reviewReason: String(row.review_reason) } : {}),
      ...(row.rating !== null && row.rating !== undefined ? { rating: Number(row.rating) } : {}),
      ratingCount: Number(row.rating_count ?? 0), messageCount: Number(row.message_count ?? 0),
      createdAt: Number(row.session_created_at), updatedAt: Number(row.session_updated_at),
    };
  }
}

export function openLogisticsConversationStore(options: LogisticsConversationStoreOptions): LogisticsConversationStore {
  return new LogisticsConversationStore(options);
}
