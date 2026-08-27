import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

import type {
  LogisticsEvidenceAnchor,
  LogisticsSessionMasterRecord,
} from './logistics-session-master.js';

const require = createRequire(import.meta.url);

const SCHEMA_VERSION = 2;
const DEFAULT_FILE = 'botmux-conversations.sqlite';

export interface LogisticsConversationStoreOptions {
  dataDir: string;
  path?: string;
  readOnly?: boolean;
}

export type LogisticsBackfillStatus =
  | 'pending'
  | 'processing'
  | 'missing_turn'
  | 'missing_answer'
  | 'history_failed'
  | 'snapshot_ready'
  | 'labeled'
  | 'label_failed'
  | 'skipped';

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

function sessionPublicId(larkAppId: string, sessionId: string): string {
  return `sess_${createHash('sha256').update(`${larkAppId}:${sessionId}`).digest('hex').slice(0, 32)}`;
}


export class LogisticsConversationStore {
  readonly path: string;
  private readonly db: DatabaseSyncType;

  constructor(options: LogisticsConversationStoreOptions) {
    this.path = sqlitePath(options);
    if (!options.readOnly) mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    this.db = new DatabaseSync(this.path, options.readOnly ? { readOnly: true } : {});
    this.db.exec('PRAGMA busy_timeout=5000;');
    this.db.exec('PRAGMA foreign_keys=ON;');
    if (!options.readOnly) {
      this.db.exec('PRAGMA journal_mode=WAL;');
      this.migrate();
    }
  }

  close(): void { this.db.close(); }

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

        CREATE TABLE IF NOT EXISTS conversation_messages (
          snapshot_id TEXT NOT NULL REFERENCES conversation_snapshots(snapshot_id) ON DELETE CASCADE,
          message_index INTEGER NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user','assistant')),
          content TEXT NOT NULL,
          platform_message_id TEXT,
          created_at INTEGER,
          PRIMARY KEY(snapshot_id, message_index)
        );

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
      this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION};`);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
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
      const catalogStatus: LogisticsBackfillStatus = record.modelError
        ? 'label_failed'
        : record.businessCategory && record.problemType && record.resolutionStatus
          ? 'labeled'
          : record.transcript && record.transcriptHash ? 'snapshot_ready' : 'pending';
      this.markSessionBackfillInside(record.larkAppId, record.sessionId, catalogStatus, record.modelError, conversationId);

      if (record.transcript && record.transcriptHash && record.captureState) {
        const snapshotId = `snap_${createHash('sha256').update(`${record.masterKey}:${record.transcriptHash}`).digest('hex')}`;
        this.db.prepare(`
          INSERT OR IGNORE INTO conversation_snapshots
            (snapshot_id,master_key,transcript_hash,transcript,capture_state,message_count,harness_revision,created_at)
          VALUES (?,?,?,?,?,?,?,?)
        `).run(snapshotId, record.masterKey, record.transcriptHash, record.transcript,
          record.captureState, record.messages?.length ?? 0, record.harnessRevision ?? null, record.updatedAt);
        if (record.messages?.length) {
          const insert = this.db.prepare(`
            INSERT OR REPLACE INTO conversation_messages
              (snapshot_id,message_index,role,content,platform_message_id,created_at)
            VALUES (?,?,?,?,?,?)
          `);
          record.messages.forEach((message, index) => insert.run(
            snapshotId, index, message.role, message.content, message.messageId ?? null,
            message.createdAt ?? null,
          ));
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

  summary(filters: LogisticsConversationFilters = {}): LogisticsConversationSummary {
    const w = where(filters);
    const row = this.db.prepare(`
      SELECT COUNT(*) total_sessions,
        COALESCE(SUM(c.master_key IS NOT NULL),0) conversations,
        COALESCE(SUM(sc.backfill_status IN ('snapshot_ready','labeled','label_failed')),0) snapshotted,
        COALESCE(SUM(sc.backfill_status='labeled'),0) labeled,
        COALESCE(SUM(sc.backfill_status IN ('pending','processing','missing_turn','missing_answer')),0) pending_backfill,
        COALESCE(SUM(sc.backfill_status IN ('history_failed','label_failed')),0) failed_backfill,
        COALESCE(SUM(c.message_count),0) messages,
        COALESCE(SUM(c.resolution_status='resolved'),0) resolved,
        COALESCE(SUM(c.resolution_status='in_progress'),0) in_progress,
        COALESCE(SUM(c.master_key IS NOT NULL AND (c.resolution_status='unknown' OR c.resolution_status IS NULL)),0) unknown_count,
        COALESCE(SUM(c.needs_review=1),0) needs_review,
        COALESCE(SUM(c.rating IS NOT NULL),0) rated,
        AVG(c.rating) average_rating
      FROM session_catalog sc
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
      labelCoverage: totalSessions ? labeled / totalSessions : 0,
      messages: Number(row.messages ?? 0),
      resolved,
      inProgress: Number(row.in_progress ?? 0),
      unknown: Number(row.unknown_count ?? 0),
      needsReview: Number(row.needs_review ?? 0),
      rated: Number(row.rated ?? 0),
      averageRating: row.average_rating === null || row.average_rating === undefined
        ? null : Math.round(Number(row.average_rating) * 100) / 100,
      resolutionRate: conversations ? resolved / conversations : 0,
    };
  }

  trend(filters: LogisticsConversationFilters = {}): Array<{ day: string; totalSessions: number; conversations: number; resolved: number; resolutionRate: number }> {
    const w = where(filters);
    return (this.db.prepare(`
      SELECT date(COALESCE(sc.last_message_at,sc.closed_at,sc.created_at,c.updated_at)/1000,'unixepoch','+8 hours') day,
        COUNT(*) total_sessions, COALESCE(SUM(c.master_key IS NOT NULL),0) conversations,
        COALESCE(SUM(c.resolution_status='resolved'),0) resolved
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
    const group = (column: string) => (this.db.prepare(`
      SELECT COALESCE(${column},'unknown') key, COUNT(*) count
      FROM session_catalog sc
      LEFT JOIN conversations c ON c.lark_app_id=sc.lark_app_id AND c.session_id=sc.session_id
      ${w.sql} GROUP BY key ORDER BY count DESC,key
    `).all(...w.params) as any[]).map(row => ({ key: String(row.key), count: Number(row.count) }));
    return {
      business: group('c.business_category'),
      problem: group('c.problem_type'),
      resolution: group('c.resolution_status'),
      confidence: group('c.overall_confidence'),
      dataStatus: group('sc.backfill_status'),
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
        c.rating,c.rating_count,c.message_count
      ${joins} ${w.sql}
      ORDER BY session_updated_at DESC,sc.session_key DESC LIMIT ? OFFSET ?
    `).all(...w.params, limit, offset) as any[];
    return { total, items: rows.map(row => this.catalogListItem(row)) };
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
    const currentSnapshot = snapshotRows.find(item => item.transcript_hash === row.transcript_hash) ?? snapshotRows[0];
    const messages = currentSnapshot
      ? (this.db.prepare(`
          SELECT role,content,platform_message_id,created_at FROM conversation_messages
          WHERE snapshot_id=? ORDER BY message_index
        `).all(currentSnapshot.snapshot_id) as any[]).map(item => ({
          role: String(item.role), content: String(item.content),
          ...(item.created_at ? { createdAt: Number(item.created_at) } : {}),
        }))
      : [];
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
