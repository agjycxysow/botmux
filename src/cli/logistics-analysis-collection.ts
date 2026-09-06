import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { loadBotConfigs, registerBot, type BotConfig } from '../bot-registry.js';
import { fetchDaemonIpc } from '../core/daemon-ipc-auth.js';
import { listThreadMessages } from '../im/lark/client.js';
import { parseApiMessage } from '../im/lark/message-parser.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';
import { findOnlineDaemon, type OnlineDaemonInfo } from '../utils/daemon-discovery.js';
import { loadAllSessionsSnapshot } from '../services/session-store.js';
import {
  buildLogisticsAnalysisMessageKey,
  canPreferLogisticsRecoveryMessage,
  computeLogisticsAnalysisContentHash,
  isLogisticsPlaceholderContent,
  type LogisticsAnalysisCaptureStatus,
  type LogisticsAnalysisMessage,
  type LogisticsAnalysisMessageInput,
  type LogisticsAnalysisMessageSource,
  type LogisticsAnalysisSession,
  type LogisticsAnalysisSessionInput,
  type LogisticsAnalysisStore,
  LogisticsAnalysisStore as AnalysisStore,
} from '../services/logistics-analysis-store.js';
import {
  buildLogisticsTopicKey,
  buildLogisticsTopicPublicId,
  classifyLogisticsTopic,
} from '../services/logistics-analysis-topic.js';
import {
  createLogisticsSessionModelTaskRunner,
  isLogisticsHarnessRecordAnalyzable,
  prepareLogisticsHarnessRecord,
  resolveLogisticsHarnessRevision,
} from '../services/logistics-session-model-task.js';
import type {
  LogisticsSessionMasterRecord,
  LogisticsSessionModelTaskRunner,
  LogisticsModelTagging,
} from '../services/logistics-session-master.js';
import {
  extractLogisticsCodexUserText,
  resolveLogisticsCodexAnswer,
} from '../services/logistics-codex-answer.js';
import {
  sanitizeLogisticsMessageText,
} from '../services/logistics-session-capture.js';
import { migrateLogisticsAnalysisDatabase } from '../services/logistics-analysis-migration.js';
import type { LogisticsCodexAnswerLookup, LogisticsCodexRecoveredAnswer } from '../services/logistics-codex-answer.js';
import type { Session } from '../types.js';

export const LOGISTICS_ANALYSIS_DEFAULT_DB_NAME = 'logistics-analysis.sqlite';
export const LOGISTICS_ANALYSIS_DEFAULT_PAGE_LIMIT = 50;
export const LOGISTICS_ANALYSIS_MAX_PAGE_LIMIT = 200;
export const LOGISTICS_ANALYSIS_MAX_HISTORY_MESSAGES = 5_000;
export const LOGISTICS_ANALYSIS_SILENCE_MS = 15 * 60_000;
export const LOGISTICS_ANALYSIS_RUN_MODEL_BUDGET = 50;
export const LOGISTICS_ANALYSIS_ACTIVITY_TIMEOUT_MS = 5_000;
export const LOGISTICS_ANALYSIS_STALE_RUN_MIN_MS = 10 * 60_000;
export const LOGISTICS_ANALYSIS_MAX_SCAN_PAGES = 1_000;
export const LOGISTICS_ANALYSIS_RUN_STATE_VERSION = 1;

const BUSY_RUNTIME_STATUSES = new Set(['working', 'analyzing', 'starting', 'limited', 'stalled']);
const ACCEPTED_IDLE_RUNTIME_STATUS = 'idle';

export interface LogisticsAnalysisCollectionBot {
  larkAppId: string;
  cliId: string;
  larkAppSecret?: string;
  displayName?: string;
  name?: string;
  model?: string;
  cliPathOverride?: string;
  wrapperCli?: string;
  env?: unknown;
  logisticsSessionMaster?: {
    harness?: { rootDir?: string };
    modelTask?: { enabled?: boolean; timeoutMs?: number; model?: string };
  };
}

export interface LogisticsAnalysisCollectionOptions {
  dataDir: string;
  dbPath: string;
  bot: LogisticsAnalysisCollectionBot;
  apply?: boolean;
  limit?: number;
  cursor?: string;
  sessionPrefix?: string;
  concurrency?: number;
  harnessRoot?: string;
  model?: string;
  now?: number;
  /** Internal run-only budget/cursor plumbing; standalone label remains one page. */
  modelBudget?: number;
  modelCounter?: { started: number };
  staleAfterMs?: number;
}

export interface LogisticsAnalysisRuntimeSessionSnapshot {
  status?: string;
  queued?: boolean;
  pendingRepo?: boolean;
  pendingRepoSetup?: unknown;
  queuedActivationPending?: boolean;
}

export interface LogisticsAnalysisRuntimeFetchResult {
  httpStatus: number;
  body?: unknown;
}

export interface LogisticsAnalysisQueueProbeResult {
  known: boolean;
  pending: boolean;
  offset?: number;
}

export interface LogisticsAnalysisCollectionDeps {
  loadSessions?: (dataDir: string, botId: string) => Map<string, Session>;
  fetchThreadMessages?: (
    botId: string,
    chatId: string,
    rootMessageId: string,
    maxMessages: number,
  ) => Promise<ReadonlyArray<unknown>>;
  resolveAnswer?: (
    session: Session,
    lookup: LogisticsCodexAnswerLookup,
  ) => LogisticsCodexRecoveredAnswer | undefined;
  findDaemon?: (botId: string) => OnlineDaemonInfo | null;
  fetchRuntimeSession?: (
    daemon: OnlineDaemonInfo,
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<LogisticsAnalysisRuntimeFetchResult>;
  inspectQueue?: (dataDir: string, rootMessageId: string) => LogisticsAnalysisQueueProbeResult;
  resolveHarnessRevision?: (harnessRoot: string) => string;
  createModelRunner?: (
    bot: LogisticsAnalysisCollectionBot,
    harnessRoot: string,
    model: string | undefined,
  ) => LogisticsSessionModelTaskRunner;
  now?: () => number;
}

export interface LogisticsAnalysisRunState {
  schemaVersion: 1;
  status: 'running' | 'succeeded' | 'partial' | 'failed';
  startedAt: number;
  finishedAt: number | null;
  lastSuccessfulSyncAt: number | null;
  lastSuccessfulCaptureAt: number | null;
  lastSuccessfulLabelAt: number | null;
  pendingCapture: number;
  pendingLabel: number;
  errorCode: string | null;
  nextLabelCursor?: string;
}

export interface LogisticsAnalysisTopicCandidate {
  sessionKey: string;
}

export interface LogisticsAnalysisTopicPage<T extends LogisticsAnalysisTopicCandidate> {
  candidates: T[];
  totalCandidates: number;
  hasMore: boolean;
  nextCursor?: string;
}

export interface LogisticsAnalysisLabelGateResult {
  allowed: boolean;
  reason?: string;
  latestVisibleAt?: number;
  checkedSessions: number;
}

interface TopicGroup extends LogisticsAnalysisTopicCandidate {
  botId: string;
  chatId: string;
  rootMessageId: string;
  sessions: Session[];
  rows: LogisticsAnalysisSessionInput[];
  latest: Session;
}

interface SourceSnapshot {
  rows: LogisticsAnalysisSessionInput[];
  groups: TopicGroup[];
  excludedByReason: Record<string, number>;
  excluded: number;
}

interface VisibleMessage {
  platformMessageId: string | null;
  role: 'user' | 'assistant';
  senderId?: string;
  senderName?: string;
  content: string;
  occurredAt?: number;
}

interface SourceBoundary {
  fingerprint: string;
  latestVisibleAt?: number;
  latestPlatformMessageId?: string | null;
}

interface VisibleHistory {
  messages: VisibleMessage[];
  complete: boolean;
  parseErrors: number;
  boundary: SourceBoundary;
}

interface SendMarker {
  messageId?: string;
  sentAtMs?: number;
  previewText?: string;
  contentLength?: number;
  authoritative?: boolean;
}

interface CollectionContext {
  options: LogisticsAnalysisCollectionOptions;
  deps: RequiredPick<LogisticsAnalysisCollectionDeps, 'loadSessions' | 'fetchThreadMessages' | 'resolveAnswer' | 'findDaemon' | 'fetchRuntimeSession' | 'inspectQueue' | 'resolveHarnessRevision' | 'createModelRunner'>;
  now: () => number;
  dbPath: string;
}

type RequiredPick<T, K extends keyof T> = T & Required<Pick<T, K>>;

interface CapturePageResult {
  processed: number;
  captured: number;
  partial: number;
  conflict: number;
  failed: number;
  messages: {
    total: number;
    inserted: number;
    updated: number;
    unchanged: number;
    conflicts: number;
    missingPlatformMessageIds: number;
  };
  failures: Array<{ topicPublicId: string; code: string }>;
  boundaries: Map<string, SourceBoundary>;
  page: LogisticsAnalysisTopicPage<TopicGroup>;
}

interface CaptureStageResult extends CapturePageResult {
  mode: 'dry-run' | 'apply';
  db: string;
  bot: string;
  totalCandidates: number;
  hasMore: boolean;
  nextCursor: string | null;
  pendingCapture?: number;
  sync?: ReturnType<AnalysisStore['syncSessions']>;
}

interface LabelStageResult {
  mode: 'dry-run' | 'apply';
  db: string;
  bot: string;
  harnessRevision: string;
  totalCandidates: number;
  candidates: number;
  hasMore: boolean;
  nextCursor: string | null;
  created: number;
  reused: number;
  skipped: number;
  labeled: number;
  expired: number;
  failed: number;
  modelBudgetReached?: boolean;
  gateSkipped: number;
  attemptLimit: number;
  failures: Array<{ topicPublicId: string; code: string }>;
  pendingLabel?: number;
  candidateTopics?: string[];
}

function requiredText(value: string | undefined, name: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) throw new Error(`analysis_${name}_required`);
  return normalized;
}

function safeInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`analysis_${name}_invalid`);
  return value;
}

function normalizePageLimit(value: number | undefined): number {
  const limit = value ?? LOGISTICS_ANALYSIS_DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LOGISTICS_ANALYSIS_MAX_PAGE_LIMIT) {
    throw new Error(`analysis_invalid_limit:${limit}`);
  }
  return limit;
}

function normalizeConcurrency(value: number | undefined): number {
  const concurrency = value ?? 2;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error(`analysis_invalid_concurrency:${concurrency}`);
  }
  return concurrency;
}

function parseTime(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sessionUpdatedAt(session: Session): number {
  return Math.max(
    parseTime(session.createdAt) ?? 0,
    parseTime(session.lastMessageAt) ?? 0,
    parseTime(session.closedAt) ?? 0,
  );
}

function botDisplayName(bot: LogisticsAnalysisCollectionBot): string {
  return bot.displayName?.trim() || bot.name?.trim() || bot.larkAppId;
}

function safeErrorCode(error: unknown, fallback = 'analysis_operation_failed'): string {
  const message = error instanceof Error ? error.message : String(error);
  const known = message.match(/(?:analysis|migration|harness|model_task|lark|source|runtime|queue)_[a-z0-9_]+/i)?.[0];
  if (known) return known.toLowerCase().slice(0, 120);
  if (/timeout|aborted/i.test(message)) return 'analysis_timeout';
  if (/not found|404/i.test(message)) return 'analysis_not_found';
  if (/sqlite|database|readonly|locked/i.test(message)) return 'analysis_database_error';
  return fallback;
}

function isDatabaseError(error: unknown): boolean {
  const code = safeErrorCode(error);
  return code === 'analysis_database_error'
    || code === 'analysis_store_read_only'
    || code === 'analysis_database_not_four_table'
    || code === 'analysis_schema_version_unsupported'
    || code === 'analysis_label_run_not_running';
}

function encodeCursor(sessionKey: string): string {
  return Buffer.from(JSON.stringify({ v: 1, sessionKey })).toString('base64url');
}

function decodeCursor(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      v?: unknown;
      sessionKey?: unknown;
    };
    if (value.v !== 1 || typeof value.sessionKey !== 'string' || !value.sessionKey) throw new Error('shape');
    return value.sessionKey;
  } catch {
    throw new Error('analysis_invalid_cursor');
  }
}

export function paginateLogisticsAnalysisTopics<T extends LogisticsAnalysisTopicCandidate>(
  candidates: ReadonlyArray<T>,
  options: { limit?: number; cursor?: string } = {},
): LogisticsAnalysisTopicPage<T> {
  const limit = normalizePageLimit(options.limit);
  const cursor = decodeCursor(options.cursor);
  const unique = new Map<string, T>();
  for (const candidate of candidates) {
    const sessionKey = requiredText(candidate.sessionKey, 'session_key');
    if (!unique.has(sessionKey)) unique.set(sessionKey, candidate);
  }
  const sorted = [...unique.values()].sort((left, right) => left.sessionKey.localeCompare(right.sessionKey));
  const remaining = cursor
    ? sorted.filter(candidate => candidate.sessionKey.localeCompare(cursor) > 0)
    : sorted;
  const page = remaining.slice(0, limit);
  const hasMore = remaining.length > page.length;
  return {
    candidates: page,
    totalCandidates: sorted.length,
    hasMore,
    ...(hasMore && page.length ? { nextCursor: encodeCursor(page.at(-1)!.sessionKey) } : {}),
  };
}

function defaultLoadSessions(dataDir: string, botId: string): Map<string, Session> {
  return loadAllSessionsSnapshot({ dataDir, fallbackAppId: botId });
}

async function defaultFetchThreadMessages(
  botId: string,
  chatId: string,
  rootMessageId: string,
  maxMessages: number,
): Promise<ReadonlyArray<unknown>> {
  return listThreadMessages(botId, chatId, rootMessageId, maxMessages);
}

async function defaultFetchRuntimeSession(
  daemon: OnlineDaemonInfo,
  sessionId: string,
  signal: AbortSignal,
): Promise<LogisticsAnalysisRuntimeFetchResult> {
  const response = await fetchDaemonIpc(
    daemon.ipcPort,
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'GET', signal },
  );
  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  return { httpStatus: response.status, body };
}

function defaultInspectQueue(dataDir: string, rootMessageId: string): LogisticsAnalysisQueueProbeResult {
  if (!/^[A-Za-z0-9._-]+$/.test(rootMessageId)) return { known: false, pending: false };
  const queuePath = join(dataDir, 'queues', `${rootMessageId}.jsonl`);
  if (!existsSync(queuePath)) return { known: true, pending: false, offset: 0 };
  const offsetPath = join(dataDir, 'queues', `${rootMessageId}.offset`);
  let offset = 0;
  try {
    const raw = readFileSync(offsetPath, 'utf8').trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) offset = parsed;
  } catch { /* absent or malformed offset is conservatively treated as zero */ }
  try {
    const content = readFileSync(queuePath, 'utf8');
    // message-queue.ts stores a JS-string offset (despite the byte-position
    // comment), so compare against content.length rather than stat.size.
    // An offset beyond the current string is corruption/truncation, not proof
    // that all queued input was consumed.
    if (offset > content.length) return { known: false, pending: false, offset };
    if (offset === content.length) return { known: true, pending: false, offset };
    const unread = content.slice(Math.min(offset, content.length));
    return { known: true, pending: unread.split('\n').some(line => !!line.trim()), offset };
  } catch {
    return { known: false, pending: false, offset };
  }
}
/** Read-only diagnostic for the legacy preview file. It is intentionally not
 * part of the label admission gate: queues/*.jsonl are Dashboard previews,
 * not proof that a turn is waiting for delivery. */
export function peekLogisticsAnalysisQueue(
  dataDir: string,
  rootMessageId: string,
): LogisticsAnalysisQueueProbeResult {
  return defaultInspectQueue(dataDir, rootMessageId);
}

function defaultResolveAnswer(session: Session, lookup: LogisticsCodexAnswerLookup): LogisticsCodexRecoveredAnswer | undefined {
  return resolveLogisticsCodexAnswer(session, lookup);
}

function defaultResolveHarnessRevision(harnessRoot: string): string {
  return resolveLogisticsHarnessRevision(harnessRoot);
}

function defaultCreateModelRunner(
  bot: LogisticsAnalysisCollectionBot,
  harnessRoot: string,
  model: string | undefined,
): LogisticsSessionModelTaskRunner {
  return createLogisticsSessionModelTaskRunner({
    cliId: bot.cliId,
    cliPathOverride: bot.cliPathOverride,
    wrapperCli: bot.wrapperCli,
    model,
    env: bot.env,
    timeoutMs: bot.logisticsSessionMaster?.modelTask?.timeoutMs,
    harnessRoot,
  });
}

function createContext(
  options: LogisticsAnalysisCollectionOptions,
  supplied: LogisticsAnalysisCollectionDeps = {},
): CollectionContext {
  const dbPath = resolve(options.dbPath);
  if (basename(dbPath) === 'botmux-conversations.sqlite') {
    throw new Error('analysis_legacy_database_path_forbidden');
  }
  const deps = {
    ...supplied,
    loadSessions: supplied.loadSessions ?? defaultLoadSessions,
    fetchThreadMessages: supplied.fetchThreadMessages ?? defaultFetchThreadMessages,
    resolveAnswer: supplied.resolveAnswer ?? defaultResolveAnswer,
    findDaemon: supplied.findDaemon ?? findOnlineDaemon,
    fetchRuntimeSession: supplied.fetchRuntimeSession ?? defaultFetchRuntimeSession,
    inspectQueue: supplied.inspectQueue ?? defaultInspectQueue,
    resolveHarnessRevision: supplied.resolveHarnessRevision ?? defaultResolveHarnessRevision,
    createModelRunner: supplied.createModelRunner ?? defaultCreateModelRunner,
  } as RequiredPick<LogisticsAnalysisCollectionDeps, 'loadSessions' | 'fetchThreadMessages' | 'resolveAnswer' | 'findDaemon' | 'fetchRuntimeSession' | 'inspectQueue' | 'resolveHarnessRevision' | 'createModelRunner'>;
  const fixedNow = options.now;
  const now = fixedNow === undefined ? (supplied.now ?? (() => Date.now())) : () => fixedNow;
  return { options, deps, now, dbPath };
}

function inputForSession(
  session: Session,
  bot: LogisticsAnalysisCollectionBot,
): LogisticsAnalysisSessionInput | undefined {
  const createdAt = parseTime(session.createdAt);
  if (createdAt === undefined) return undefined;
  const special = Boolean(session.vcMeetingReceiver || session.deferredScheduleRun);
  const rawScope = (session as Session & { scope?: string }).scope;
  const scope = special
    ? 'special'
    : rawScope === 'chat'
      ? 'chat'
      : rawScope === 'thread' || rawScope === undefined
        ? 'thread'
        : rawScope as LogisticsAnalysisSessionInput['scope'];
  const rootMessageId = typeof session.rootMessageId === 'string' && session.rootMessageId.trim()
    ? session.rootMessageId.trim()
    : null;
  const sessionKey = rootMessageId
    ? buildLogisticsTopicKey({ botId: bot.larkAppId, chatId: session.chatId, rootMessageId })
    : undefined;
  const lastMessageAt = parseTime(session.lastMessageAt);
  const updatedAt = Math.max(createdAt, lastMessageAt ?? 0, parseTime(session.closedAt) ?? 0);
  const chatName = typeof session.chatDisplayName === 'string' && session.chatDisplayName.trim()
    ? session.chatDisplayName.trim()
    : undefined;
  return {
    ...(sessionKey ? { sessionKey } : {}),
    botmuxSessionId: session.sessionId,
    ...(session.cliSessionId ? { cliSessionId: session.cliSessionId } : {}),
    botId: bot.larkAppId,
    botName: botDisplayName(bot),
    chatId: session.chatId,
    ...(chatName ? { chatName } : {}),
    scope,
    rootMessageId,
    title: session.title,
    sessionStatus: session.status,
    createdAt,
    ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
    updatedAt,
  };
}

function buildSourceSnapshot(ctx: CollectionContext): SourceSnapshot {
  const { options, deps } = ctx;
  const excludedByReason: Record<string, number> = {
    special_session: 0,
    chat_scope: 0,
    non_thread_scope: 0,
    missing_root: 0,
  };
  const sourceRows: LogisticsAnalysisSessionInput[] = [];
  const groups = new Map<string, TopicGroup>();
  const excludedEntries: Array<{ sessionId: string; reason: string }> = [];
  const sessions = [...deps.loadSessions(options.dataDir, options.bot.larkAppId).values()]
    .filter(session => session.larkAppId === options.bot.larkAppId);
  for (const session of sessions) {
    const row = inputForSession(session, options.bot);
    if (!row) continue;
    sourceRows.push(row);
    const reason = classifyLogisticsTopic({
      scope: row.scope,
      rootMessageId: row.rootMessageId,
      specialSession: row.scope === 'special',
    });
    if (reason) {
      excludedEntries.push({ sessionId: session.sessionId, reason });
      continue;
    }
    const rootMessageId = requiredText(row.rootMessageId ?? undefined, 'root_message_id');
    const sessionKey = buildLogisticsTopicKey({
      botId: row.botId,
      chatId: row.chatId,
      rootMessageId,
    });
    const existing = groups.get(sessionKey);
    if (existing) {
      existing.sessions.push(session);
      existing.rows.push({ ...row, sessionKey });
      if (sessionUpdatedAt(session) > sessionUpdatedAt(existing.latest)
        || (sessionUpdatedAt(session) === sessionUpdatedAt(existing.latest)
          && session.sessionId.localeCompare(existing.latest.sessionId) > 0)) {
        existing.latest = session;
      }
    } else {
      groups.set(sessionKey, {
        sessionKey,
        botId: row.botId,
        chatId: row.chatId,
        rootMessageId,
        sessions: [session],
        rows: [{ ...row, sessionKey }],
        latest: session,
      });
    }
  }
  const sortedGroups = [...groups.values()].sort((left, right) => left.sessionKey.localeCompare(right.sessionKey));
  for (const group of sortedGroups) {
    group.sessions.sort((left, right) => (
      sessionUpdatedAt(left) - sessionUpdatedAt(right)
      || left.sessionId.localeCompare(right.sessionId)
    ));
    group.rows.sort((left, right) => (
      (left.updatedAt ?? 0) - (right.updatedAt ?? 0)
      || String(left.botmuxSessionId ?? '').localeCompare(String(right.botmuxSessionId ?? ''))
    ));
  }
  const selectedSessionIds = new Set<string>();
  if (!options.sessionPrefix) {
    for (const session of sessions) selectedSessionIds.add(session.sessionId);
  } else {
    for (const group of sortedGroups) {
      if (!group.sessions.some(session => session.sessionId.startsWith(options.sessionPrefix!))) continue;
      for (const session of group.sessions) selectedSessionIds.add(session.sessionId);
    }
    for (const entry of excludedEntries) {
      if (entry.sessionId.startsWith(options.sessionPrefix)) selectedSessionIds.add(entry.sessionId);
    }
  }
  const selectedGroups = sortedGroups.filter(group => group.sessions.some(session => selectedSessionIds.has(session.sessionId)));
  const selectedRows = sourceRows.filter(row => (
    typeof row.botmuxSessionId === 'string' && selectedSessionIds.has(row.botmuxSessionId)
  ));
  for (const entry of excludedEntries) {
    if (selectedSessionIds.has(entry.sessionId)) {
      excludedByReason[entry.reason] = (excludedByReason[entry.reason] ?? 0) + 1;
    }
  }
  const excluded = Object.values(excludedByReason).reduce((sum, count) => sum + count, 0);
  return {
    rows: selectedRows,
    groups: selectedGroups,
    excludedByReason,
    excluded,
  };
}

function plannedSync(snapshot: SourceSnapshot): {
  total: number;
  included: number;
  excluded: number;
  excludedByReason: Record<string, number>;
} {
  return {
    total: snapshot.rows.length,
    included: snapshot.rows.length - snapshot.excluded,
    excluded: snapshot.excluded,
    excludedByReason: snapshot.excludedByReason,
  };
}

function latestMarker(dataDir: string, sessionId: string): SendMarker {
  const markerPath = join(dataDir, 'turn-sends', `${sessionId}.jsonl`);
  if (!existsSync(markerPath)) return {};
  let marker: SendMarker = {};
  try {
    for (const line of readFileSync(markerPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        marker = {
          ...(typeof value.messageId === 'string' && value.messageId ? { messageId: value.messageId } : {}),
          ...(typeof value.sentAtMs === 'number' ? { sentAtMs: value.sentAtMs } : {}),
          ...(typeof value.previewText === 'string' ? { previewText: value.previewText } : {}),
          ...(typeof value.contentLength === 'number' ? { contentLength: value.contentLength } : {}),
          ...(value.authoritative === true ? { authoritative: true } : {}),
        };
      } catch { /* ignore one malformed marker */ }
    }
  } catch { /* marker recovery is best effort */ }
  return marker;
}

function directMessage(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.content !== 'string') return undefined;
  if (value.role === 'user' || value.role === 'assistant' || typeof value.senderType === 'string') return value;
  return undefined;
}

function visibleMessage(raw: unknown): VisibleMessage | undefined {
  const direct = directMessage(raw);
  let parsed: Record<string, unknown>;
  if (direct) {
    parsed = direct;
  } else {
    try { parsed = parseApiMessage(raw) as unknown as Record<string, unknown>; }
    catch { return undefined; }
  }
  const senderType = parsed.senderType;
  const role = parsed.role === 'user' || senderType === 'user'
    ? 'user'
    : parsed.role === 'assistant' || senderType === 'app'
      ? 'assistant'
      : undefined;
  if (!role || typeof parsed.content !== 'string') return undefined;
  const content = sanitizeLogisticsMessageText(parsed.content);
  if (!content) return undefined;
  const rawId = parsed.platformMessageId ?? parsed.messageId ?? parsed.message_id;
  const platformMessageId = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : null;
  const senderId = typeof parsed.senderId === 'string' && parsed.senderId.trim()
    ? parsed.senderId.trim()
    : undefined;
  const senderName = typeof parsed.senderName === 'string' && parsed.senderName.trim()
    ? parsed.senderName.trim()
    : undefined;
  const occurredAt = parseTime(parsed.occurredAt ?? parsed.createTime ?? parsed.create_time);
  return {
    platformMessageId,
    role,
    ...(senderId ? { senderId } : {}),
    ...(senderName ? { senderName } : {}),
    content,
    ...(occurredAt === undefined ? {} : { occurredAt }),
  };
}

function boundaryForMessages(messages: ReadonlyArray<VisibleMessage>): SourceBoundary {
  const fingerprint = createHash('sha256').update(JSON.stringify(messages.map(message => ({
    platformMessageId: message.platformMessageId,
    role: message.role,
    content: message.content,
    occurredAt: message.occurredAt ?? null,
  })))).digest('hex');
  let latest: VisibleMessage | undefined;
  for (const message of messages) {
    if (!latest || (message.occurredAt ?? -1) >= (latest.occurredAt ?? -1)) latest = message;
  }
  return {
    fingerprint,
    ...(latest?.occurredAt === undefined ? {} : { latestVisibleAt: latest.occurredAt }),
    ...(latest ? { latestPlatformMessageId: latest.platformMessageId } : {}),
  };
}

async function readVisibleHistory(ctx: CollectionContext, group: TopicGroup): Promise<VisibleHistory> {
  const raw = await ctx.deps.fetchThreadMessages(
    group.botId,
    group.chatId,
    group.rootMessageId,
    LOGISTICS_ANALYSIS_MAX_HISTORY_MESSAGES + 1,
  );
  const messages: VisibleMessage[] = [];
  let parseErrors = 0;
  for (const item of raw) {
    const message = visibleMessage(item);
    if (message) messages.push(message);
    // Non-user/non-app messages are intentionally outside the analysis
    // contract and are not capture failures.
  }
  return {
    messages,
    complete: raw.length <= LOGISTICS_ANALYSIS_MAX_HISTORY_MESSAGES,
    parseErrors,
    boundary: boundaryForMessages(messages),
  };
}

function lastUserBefore(messages: ReadonlyArray<VisibleMessage>, markerMessageId?: string): VisibleMessage | undefined {
  const boundary = markerMessageId
    ? messages.findIndex(message => message.platformMessageId === markerMessageId)
    : messages.length;
  const end = boundary >= 0 ? boundary : messages.length;
  for (let index = end - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return messages[index];
  }
  return [...messages].reverse().find(message => message.role === 'user');
}

function recoveredSource(_answer: LogisticsCodexRecoveredAnswer): LogisticsAnalysisMessageSource {
  return 'codex_rollout';
}

function recoveryMessageKey(
  sessionKey: string,
  sessionId: string,
  answer: LogisticsCodexRecoveredAnswer,
): string {
  return `msg_${createHash('sha256').update(JSON.stringify([
    sessionKey,
    sessionId,
    answer.source,
    answer.occurredAt ?? null,
    sanitizeLogisticsMessageText(answer.content),
  ])).digest('hex')}`;
}

async function buildAnalysisMessages(
  ctx: CollectionContext,
  group: TopicGroup,
  history: VisibleHistory,
): Promise<LogisticsAnalysisMessageInput[]> {
  const messages: LogisticsAnalysisMessageInput[] = history.messages.map((message, index) => ({
    sessionKey: group.sessionKey,
    ...(message.platformMessageId
      ? {}
      : { messageKey: buildLogisticsAnalysisMessageKey(group.sessionKey, null, {
        role: message.role,
        content: `${message.content}\u0000visible-${index}`,
        ...(message.occurredAt === undefined ? {} : { occurredAt: message.occurredAt }),
      }) }),
    platformMessageId: message.platformMessageId,
    role: message.role,
    ...(message.senderId ? { senderId: message.senderId } : {}),
    ...(message.senderName ? { senderName: message.senderName } : {}),
    content: message.content,
    ...(message.occurredAt === undefined ? {} : { occurredAt: message.occurredAt }),
    source: 'lark_history',
  }));
  for (const session of group.sessions) {
    const marker = latestMarker(ctx.options.dataDir, session.sessionId);
    const expectedUser = lastUserBefore(history.messages, marker.messageId);
    const expectedAnswerAtMs = marker.sentAtMs
      ?? (marker.messageId
        ? history.messages.find(message => message.platformMessageId === marker.messageId)?.occurredAt
        : undefined);
    const lookup: LogisticsCodexAnswerLookup = {
      ...(marker.messageId ? { markerMessageId: marker.messageId } : {}),
      ...(expectedUser ? { expectedUserText: extractLogisticsCodexUserText(expectedUser.content) } : {}),
      ...(expectedAnswerAtMs === undefined ? {} : { expectedAnswerAtMs }),
    };
    let recovered: LogisticsCodexRecoveredAnswer | undefined;
    try { recovered = ctx.deps.resolveAnswer(session, lookup); }
    catch { recovered = undefined; }
    if (recovered?.content?.trim() && (!marker.messageId || recovered.content.trim() !== 'BOTMUX_NOTHING_TO_SEND')) {
      messages.push({
        sessionKey: group.sessionKey,
        ...(marker.messageId
          ? { platformMessageId: marker.messageId }
          : { messageKey: recoveryMessageKey(group.sessionKey, session.sessionId, recovered) }),
        role: 'assistant',
        content: recovered.content,
        ...(recovered.occurredAt === undefined ? {} : { occurredAt: recovered.occurredAt }),
        responseKind: 'final',
        source: recoveredSource(recovered),
      });
      continue;
    }
    const preview = marker.previewText?.trim();
    const previewIsFull = !!preview
      && !isLogisticsPlaceholderContent(preview)
      && (marker.contentLength === undefined || marker.contentLength <= preview.length);
    if (marker.messageId && previewIsFull) {
      messages.push({
        sessionKey: group.sessionKey,
        platformMessageId: marker.messageId,
        role: 'assistant',
        content: preview!,
        ...(marker.sentAtMs === undefined ? {} : { occurredAt: marker.sentAtMs }),
        responseKind: 'final',
        source: 'botmux_send_marker',
      });
    }
  }
  return messages;
}

function canonicalInputKey(input: LogisticsAnalysisMessageInput, index: number): string {
  if (input.platformMessageId?.trim()) {
    return buildLogisticsAnalysisMessageKey(input.sessionKey, input.platformMessageId, {
      role: input.role,
      content: input.content,
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    });
  }
  return input.messageKey
    ?? buildLogisticsAnalysisMessageKey(input.sessionKey, null, {
      role: input.role,
      content: `${input.content}\u0000source-${index}`,
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    });
}

interface CanonicalSourceMessages {
  hash?: string;
  reliable: boolean;
  conflicted: boolean;
}

function canonicalSourceMessages(
  messages: ReadonlyArray<LogisticsAnalysisMessageInput>,
): CanonicalSourceMessages {
  const selected = new Map<string, LogisticsAnalysisMessageInput>();
  for (let index = 0; index < messages.length; index += 1) {
    const incoming = messages[index]!;
    const key = incoming.platformMessageId?.trim()
      ? `platform:${incoming.platformMessageId.trim()}`
      : `message:${canonicalInputKey(incoming, index)}`;
    const existing = selected.get(key);
    if (!existing) {
      selected.set(key, incoming);
      continue;
    }
    if (existing.content === incoming.content && existing.role === incoming.role) continue;
    const existingInput = {
      role: existing.role,
      source: existing.source,
      ...(existing.responseKind ? { responseKind: existing.responseKind } : {}),
      content: existing.content,
    } as const;
    const incomingInput = {
      role: incoming.role,
      source: incoming.source,
      ...(incoming.responseKind ? { responseKind: incoming.responseKind } : {}),
      content: incoming.content,
    } as const;
    if (canPreferLogisticsRecoveryMessage(incomingInput, existingInput)) selected.set(key, incoming);
    else if (!canPreferLogisticsRecoveryMessage(existingInput, incomingInput)) {
      return { reliable: messages.every(message => !!message.platformMessageId), conflicted: true };
    }
  }
  const ordered = [...selected.values()].sort((left, right) => {
    const leftTime = left.occurredAt === undefined ? Number.POSITIVE_INFINITY : left.occurredAt;
    const rightTime = right.occurredAt === undefined ? Number.POSITIVE_INFINITY : right.occurredAt;
    return leftTime - rightTime || canonicalInputKey(left, 0).localeCompare(canonicalInputKey(right, 0));
  });
  return {
    hash: computeLogisticsAnalysisContentHash(ordered.map(message => ({ role: message.role, content: message.content }))),
    reliable: messages.every(message => !!message.platformMessageId),
    conflicted: false,
  };
}

function sourceSessionFingerprint(group: TopicGroup): string {
  return createHash('sha256').update(JSON.stringify(group.sessions.map(session => ({
    sessionId: session.sessionId,
    status: session.status,
    cliSessionId: session.cliSessionId ?? null,
    lastMessageAt: session.lastMessageAt ?? null,
    queued: session.queued === true,
    pendingRepoSetup: !!session.pendingRepoSetup,
    queuedActivationPending: session.queuedActivationPending === true,
  })).sort((left, right) => left.sessionId.localeCompare(right.sessionId)))).digest('hex');
}
function captureErrorFor(status: LogisticsAnalysisCaptureStatus, history: VisibleHistory): string | undefined {
  if (status === 'conflict') return 'platform_message_content_conflict';
  if (history.parseErrors > 0) return 'visible_message_parse_partial';
  if (!history.complete) return `history_limit:${LOGISTICS_ANALYSIS_MAX_HISTORY_MESSAGES}`;
  if (history.messages.some(message => !message.platformMessageId)) return 'missing_platform_message_id';
  return undefined;
}

async function captureTopic(
  ctx: CollectionContext,
  store: LogisticsAnalysisStore,
  group: TopicGroup,
): Promise<{ status: LogisticsAnalysisCaptureStatus; boundary?: SourceBoundary; write?: ReturnType<LogisticsAnalysisStore['upsertMessages']> }> {
  let history: VisibleHistory;
  try {
    history = await readVisibleHistory(ctx, group);
  } catch (error) {
    const code = safeErrorCode(error, 'lark_history_read_failed');
    try {
      store.markCaptureResult({ sessionKey: group.sessionKey, status: 'failed', error: code, updatedAt: ctx.now() });
    } catch (storeError) {
      throw storeError;
    }
    return { status: 'failed' };
  }
  const messages = await buildAnalysisMessages(ctx, group, history);
  let write: ReturnType<LogisticsAnalysisStore['upsertMessages']>;
  try {
    write = store.upsertMessages(messages, ctx.now());
  } catch (error) {
    if (isDatabaseError(error)) throw error;
    const code = safeErrorCode(error, 'capture_message_write_failed');
    store.markCaptureResult({ sessionKey: group.sessionKey, status: 'failed', error: code, updatedAt: ctx.now() });
    return { status: 'failed', boundary: history.boundary };
  }
  const unresolved = write.conflicts.some(conflict => conflict.resolution === 'unresolved');
  const status: LogisticsAnalysisCaptureStatus = unresolved
    ? 'conflict'
    : history.complete && history.parseErrors === 0 && write.missingPlatformMessageIds === 0
      ? 'captured'
      : 'partial';
  store.markCaptureResult({
    sessionKey: group.sessionKey,
    status,
    ...(captureErrorFor(status, history) ? { error: captureErrorFor(status, history) } : {}),
    updatedAt: ctx.now(),
  });
  return { status, boundary: history.boundary, write };
}

function emptyCapturePage(page: LogisticsAnalysisTopicPage<TopicGroup>): CapturePageResult {
  return {
    processed: 0,
    captured: 0,
    partial: 0,
    conflict: 0,
    failed: 0,
    messages: { total: 0, inserted: 0, updated: 0, unchanged: 0, conflicts: 0, missingPlatformMessageIds: 0 },
    failures: [],
    boundaries: new Map(),
    page,
  };
}

async function capturePageWithStore(
  ctx: CollectionContext,
  store: LogisticsAnalysisStore,
  page: LogisticsAnalysisTopicPage<TopicGroup>,
): Promise<CapturePageResult> {
  const result = emptyCapturePage(page);
  for (const group of page.candidates) {
    try {
      const captured = await captureTopic(ctx, store, group);
      result.processed += 1;
      if (captured.status === 'captured') result.captured += 1;
      if (captured.status === 'partial') result.partial += 1;
      if (captured.status === 'conflict') result.conflict += 1;
      if (captured.status === 'failed') {
        result.failed += 1;
        result.failures.push({ topicPublicId: buildLogisticsTopicPublicId(group.sessionKey), code: 'capture_failed' });
      }
      if (captured.boundary) result.boundaries.set(group.sessionKey, captured.boundary);
      if (captured.write) {
        result.messages.total += captured.write.total;
        result.messages.inserted += captured.write.inserted;
        result.messages.updated += captured.write.updated;
        result.messages.unchanged += captured.write.unchanged;
        result.messages.conflicts += captured.write.conflicts.length;
        result.messages.missingPlatformMessageIds += captured.write.missingPlatformMessageIds;
      }
    } catch (error) {
      if (isDatabaseError(error)) throw error;
      result.processed += 1;
      result.failed += 1;
      result.failures.push({ topicPublicId: buildLogisticsTopicPublicId(group.sessionKey), code: safeErrorCode(error, 'capture_failed') });
    }
  }
  return result;
}

function addCaptureResults(target: CapturePageResult, source: CapturePageResult): void {
  target.processed += source.processed;
  target.captured += source.captured;
  target.partial += source.partial;
  target.conflict += source.conflict;
  target.failed += source.failed;
  target.messages.total += source.messages.total;
  target.messages.inserted += source.messages.inserted;
  target.messages.updated += source.messages.updated;
  target.messages.unchanged += source.messages.unchanged;
  target.messages.conflicts += source.messages.conflicts;
  target.messages.missingPlatformMessageIds += source.messages.missingPlatformMessageIds;
  target.failures.push(...source.failures);
  for (const [key, value] of source.boundaries) target.boundaries.set(key, value);
}

function countPendingCapture(store: LogisticsAnalysisStore, botId: string): number {
  let offset = 0;
  let count = 0;
  for (let page = 0; page < LOGISTICS_ANALYSIS_MAX_SCAN_PAGES; page += 1) {
    const rows = store.listPendingCapture({ botId, limit: LOGISTICS_ANALYSIS_MAX_PAGE_LIMIT, offset });
    count += rows.length;
    if (rows.length < LOGISTICS_ANALYSIS_MAX_PAGE_LIMIT) return count;
    offset += rows.length;
  }
  return count;
}

function allPendingLabels(
  store: LogisticsAnalysisStore,
  botId: string,
  labelerRevision: string,
): Array<LogisticsAnalysisSession & { messages: LogisticsAnalysisMessage[] }> {
  const rows: Array<LogisticsAnalysisSession & { messages: LogisticsAnalysisMessage[] }> = [];
  let offset = 0;
  for (let page = 0; page < LOGISTICS_ANALYSIS_MAX_SCAN_PAGES; page += 1) {
    const current = store.listPendingLabels({
      botId,
      labelerRevision,
      limit: LOGISTICS_ANALYSIS_MAX_PAGE_LIMIT,
      offset,
    });
    rows.push(...current);
    if (current.length < LOGISTICS_ANALYSIS_MAX_PAGE_LIMIT) break;
    offset += current.length;
  }
  const unique = new Map<string, LogisticsAnalysisSession & { messages: LogisticsAnalysisMessage[] }>();
  for (const row of rows) unique.set(row.sessionKey, row);
  return [...unique.values()].sort((left, right) => left.sessionKey.localeCompare(right.sessionKey));
}

function countPendingLabels(store: LogisticsAnalysisStore, botId: string, revision: string): number {
  return allPendingLabels(store, botId, revision).length;
}

function runtimeRow(body: unknown): LogisticsAnalysisRuntimeSessionSnapshot | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  const row = value.session && typeof value.session === 'object' && !Array.isArray(value.session)
    ? value.session as Record<string, unknown>
    : value;
  if (typeof row.status !== 'string') return undefined;
  return {
    status: row.status,
    queued: row.queued === true,
    pendingRepo: row.pendingRepo === true,
    pendingRepoSetup: row.pendingRepoSetup,
    queuedActivationPending: row.queuedActivationPending === true,
  };
}

export async function checkLogisticsAnalysisLabelGate(
  ctxOptions: { dataDir: string; botId: string; now: number; group: { sessions: ReadonlyArray<Session>; rootMessageId: string } },
  deps: Pick<LogisticsAnalysisCollectionDeps, 'findDaemon' | 'fetchRuntimeSession' | 'inspectQueue'>,
  latestVisibleAt: number | undefined,
): Promise<LogisticsAnalysisLabelGateResult> {
  if (latestVisibleAt === undefined || ctxOptions.now - latestVisibleAt < LOGISTICS_ANALYSIS_SILENCE_MS) {
    return {
      allowed: false,
      reason: 'visible_message_not_silent',
      ...(latestVisibleAt === undefined ? {} : { latestVisibleAt }),
      checkedSessions: 0,
    };
  }
  const findDaemon = deps.findDaemon ?? findOnlineDaemon;
  const fetchRuntimeSession = deps.fetchRuntimeSession ?? defaultFetchRuntimeSession;
  let checkedSessions = 0;
  for (const session of ctxOptions.group.sessions) {
    if (session.queued === true || session.pendingRepoSetup || session.queuedActivationPending) {
      return { allowed: false, reason: 'session_queued_or_pending', latestVisibleAt, checkedSessions };
    }
    if (session.status !== 'active' && session.status !== 'closed') {
      return { allowed: false, reason: 'session_status_unknown', latestVisibleAt, checkedSessions };
    }
    const daemon = findDaemon(ctxOptions.botId);
    if (session.status === 'closed' && !daemon) continue;
    if (!daemon) return { allowed: false, reason: 'daemon_unknown', latestVisibleAt, checkedSessions };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOGISTICS_ANALYSIS_ACTIVITY_TIMEOUT_MS);
    let fetched: LogisticsAnalysisRuntimeFetchResult;
    try {
      fetched = await fetchRuntimeSession(daemon, session.sessionId, controller.signal);
    } catch {
      return { allowed: false, reason: 'runtime_query_failed', latestVisibleAt, checkedSessions };
    } finally {
      clearTimeout(timer);
    }
    if (fetched.httpStatus === 404) {
      if (session.status === 'closed') continue;
      return { allowed: false, reason: 'runtime_session_not_found', latestVisibleAt, checkedSessions };
    }
    if (fetched.httpStatus < 200 || fetched.httpStatus >= 300) {
      return { allowed: false, reason: 'runtime_query_failed', latestVisibleAt, checkedSessions };
    }
    const row = runtimeRow(fetched.body);
    if (!row) return { allowed: false, reason: 'runtime_state_unknown', latestVisibleAt, checkedSessions };
    checkedSessions += 1;
    if (row.queued || row.pendingRepo || row.pendingRepoSetup || row.queuedActivationPending) {
      return { allowed: false, reason: 'session_queued_or_pending', latestVisibleAt, checkedSessions };
    }
    if (row.status !== ACCEPTED_IDLE_RUNTIME_STATUS
      && !(session.status === 'closed' && row.status === 'closed')) {
      return {
        allowed: false,
        reason: BUSY_RUNTIME_STATUSES.has(row.status ?? '') ? 'runtime_busy' : 'runtime_state_unknown',
        latestVisibleAt,
        checkedSessions,
      };
    }
  }
  return { allowed: true, latestVisibleAt, checkedSessions };
}

function modelRecord(
  session: LogisticsAnalysisSession,
  messages: ReadonlyArray<LogisticsAnalysisMessage>,
): LogisticsSessionMasterRecord {
  const snapshotMessages = messages.map(message => ({
    role: message.role,
    content: message.content,
    ...(message.messageKey ? { messageId: message.messageKey } : {}),
    ...(message.occurredAt === undefined ? {} : { createdAt: message.occurredAt }),
    ...(message.senderId ? { senderId: message.senderId } : {}),
    ...(message.senderName ? { senderName: message.senderName } : {}),
  }));
  const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant');
  return {
    masterKey: session.sessionKey,
    larkAppId: session.botId,
    sessionId: session.botmuxSessionId ?? session.sessionKey,
    turnId: session.rootMessageId,
    surveyId: `analysis_${session.sessionKey}`,
    settledSurveyIds: [],
    ratingCount: 0,
    chatId: session.chatId,
    rootMessageId: session.rootMessageId,
    respondentOpenId: '',
    ...(session.title ? { title: session.title } : {}),
    ...(lastAssistant?.platformMessageId ? { answerMessageId: lastAssistant.platformMessageId } : {}),
    surveyStatus: 'scheduled',
    dueAt: session.lastMessageAt ?? session.updatedAt,
    ratingState: 'awaiting',
    captureState: 'complete',
    messages: snapshotMessages,
    taggingState: 'needs_review',
    needsReview: false,
    manualReviewStatus: 'pending',
    modelAttempts: 0,
    baseSyncAttempts: 0,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function resolvedHarnessRoot(
  options: LogisticsAnalysisCollectionOptions,
): string {
  return requiredText(
    options.harnessRoot
      ?? options.bot.logisticsSessionMaster?.harness?.rootDir
      ?? process.env.LOGISTICS_CONVERSATION_HARNESS_ROOT,
    'harness_root',
  );
}

function resolvedModel(options: LogisticsAnalysisCollectionOptions): string | undefined {
  return options.model
    ?? options.bot.logisticsSessionMaster?.modelTask?.model
    ?? options.bot.model;
}

function labelPageBase(
  ctx: CollectionContext,
  store: LogisticsAnalysisStore,
  snapshot: SourceSnapshot,
  revision: string,
): { page: LogisticsAnalysisTopicPage<LogisticsAnalysisSession & { messages: LogisticsAnalysisMessage[] }>; groups: Map<string, TopicGroup> } {
  const selectedTopics = new Set(snapshot.groups.map(group => group.sessionKey));
  const pending = allPendingLabels(store, ctx.options.bot.larkAppId, revision)
    .filter(session => selectedTopics.has(session.sessionKey));
  const page = paginateLogisticsAnalysisTopics(pending, {
    limit: ctx.options.limit,
    cursor: ctx.options.cursor,
  });
  return {
    page,
    groups: new Map(snapshot.groups.map(group => [group.sessionKey, group])),
  };
}

function emptyLabelStage(
  ctx: CollectionContext,
  revision: string,
  totalCandidates: number,
  candidates: number,
  page: { hasMore: boolean; nextCursor?: string },
): LabelStageResult {
  return {
    mode: ctx.options.apply ? 'apply' : 'dry-run',
    db: ctx.dbPath,
    bot: ctx.options.bot.larkAppId,
    harnessRevision: revision,
    totalCandidates,
    candidates,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor ?? null,
    created: 0,
    reused: 0,
    skipped: 0,
    labeled: 0,
    expired: 0,
    failed: 0,
    gateSkipped: 0,
    attemptLimit: 0,
    failures: [],
  };
}

function labelReason(tagging: LogisticsModelTagging): string | undefined {
  return tagging.reviewReason?.trim() || undefined;
}

async function labelPageWithStore(
  ctx: CollectionContext,
  store: LogisticsAnalysisStore,
  snapshot: SourceSnapshot,
  revision: string,
  runner: LogisticsSessionModelTaskRunner,
): Promise<LabelStageResult> {
  const base = labelPageBase(ctx, store, snapshot, revision);
  const result = emptyLabelStage(ctx, revision, base.page.totalCandidates, base.page.candidates.length, base.page);
  let nextIndex = 0;
  let lastExaminedIndex = -1;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const candidate = base.page.candidates[index];
      if (!candidate) return;
      if (ctx.options.modelBudget !== undefined
        && (ctx.options.modelCounter?.started ?? 0) >= ctx.options.modelBudget) {
        result.modelBudgetReached = true;
        return;
      }
      lastExaminedIndex = Math.max(lastExaminedIndex, index);
      // Re-read the directory for every candidate. A newly restored Session or
      // a new Session folded into this topic must not be hidden by the page's
      // older snapshot while a model is waiting.
      const currentSnapshot = buildSourceSnapshot(ctx);
      const group = currentSnapshot.groups.find(item => item.sessionKey === candidate.sessionKey);
      if (!group) {
        result.gateSkipped += 1;
        result.failures.push({ topicPublicId: buildLogisticsTopicPublicId(candidate.sessionKey), code: 'source_topic_missing' });
        continue;
      }
      let before: VisibleHistory;
      try {
        before = await readVisibleHistory(ctx, group);
      } catch {
        result.gateSkipped += 1;
        result.failures.push({ topicPublicId: buildLogisticsTopicPublicId(candidate.sessionKey), code: 'source_history_unknown' });
        continue;
      }
      if (!before.complete || before.parseErrors > 0 || before.messages.some(message => !message.platformMessageId)) {
        result.gateSkipped += 1;
        result.failures.push({ topicPublicId: buildLogisticsTopicPublicId(candidate.sessionKey), code: 'source_history_not_stable' });
        continue;
      }
      const beforeMessages = await buildAnalysisMessages(ctx, group, before);
      const beforeCanonical = canonicalSourceMessages(beforeMessages);
      if (!beforeCanonical.reliable || beforeCanonical.conflicted
        || beforeCanonical.hash !== candidate.contentHash) {
        result.gateSkipped += 1;
        result.failures.push({ topicPublicId: buildLogisticsTopicPublicId(candidate.sessionKey), code: 'source_snapshot_stale' });
        continue;
      }
      const beforeSessionFingerprint = sourceSessionFingerprint(group);
      const gate = await checkLogisticsAnalysisLabelGate(
        { dataDir: ctx.options.dataDir, botId: ctx.options.bot.larkAppId, now: ctx.now(), group },
        ctx.deps,
        before.boundary.latestVisibleAt,
      );
      if (!gate.allowed) {
        result.gateSkipped += 1;
        result.failures.push({ topicPublicId: buildLogisticsTopicPublicId(candidate.sessionKey), code: gate.reason ?? 'label_gate_rejected' });
        continue;
      }
      let registration: ReturnType<LogisticsAnalysisStore['registerLabelRun']>;
      if (ctx.options.modelBudget !== undefined
        && (ctx.options.modelCounter?.started ?? 0) >= ctx.options.modelBudget) {
        result.modelBudgetReached = true;
        return;
      }
      try {
        registration = store.registerLabelRun({
          sessionKey: candidate.sessionKey,
          contentHash: requiredText(candidate.contentHash, 'content_hash'),
          labelerRevision: revision,
          ...(resolvedModel(ctx.options) ? { model: resolvedModel(ctx.options) } : {}),
          now: ctx.now(),
        });
      } catch (error) {
        if (safeErrorCode(error) === 'analysis_label_attempt_limit') {
          result.attemptLimit += 1;
          result.failures.push({ topicPublicId: buildLogisticsTopicPublicId(candidate.sessionKey), code: 'analysis_label_attempt_limit' });
          continue;
        }
        if (safeErrorCode(error) === 'analysis_label_content_stale') {
          result.expired += 1;
          result.failures.push({ topicPublicId: buildLogisticsTopicPublicId(candidate.sessionKey), code: 'analysis_label_content_stale' });
          continue;
        }
        if (isDatabaseError(error)) throw error;
        result.failed += 1;
        result.failures.push({ topicPublicId: buildLogisticsTopicPublicId(candidate.sessionKey), code: safeErrorCode(error, 'label_register_failed') });
        continue;
      }
      if (registration.outcome === 'reused') {
        result.reused += 1;
        continue;
      }
      if (registration.outcome === 'skipped') {
        result.skipped += 1;
        continue;
      }
      result.created += 1;
      if (ctx.options.modelCounter) ctx.options.modelCounter.started += 1;
      const prepared = prepareLogisticsHarnessRecord(modelRecord(candidate, candidate.messages));
      if (!isLogisticsHarnessRecordAnalyzable(prepared.record)) {
        store.failLabelRun({ runId: registration.runId, error: 'label_input_has_no_user_message', completedAt: ctx.now() });
        result.failed += 1;
        result.failures.push({ topicPublicId: buildLogisticsTopicPublicId(candidate.sessionKey), code: 'label_input_has_no_user_message' });
        continue;
      }
      let tagging: LogisticsModelTagging;
      try {
        tagging = await runner({ record: prepared.record });
      } catch (error) {
        try {
          store.failLabelRun({ runId: registration.runId, error: safeErrorCode(error, 'model_task_failed'), completedAt: ctx.now() });
        } catch (storeError) {
          if (isDatabaseError(storeError)) throw storeError;
        }
        result.failed += 1;
        result.failures.push({ topicPublicId: buildLogisticsTopicPublicId(candidate.sessionKey), code: safeErrorCode(error, 'model_task_failed') });
        continue;
      }
      if (tagging.harnessRevision && tagging.harnessRevision !== revision) {
        try { store.failLabelRun({ runId: registration.runId, error: 'harness_revision_mismatch', completedAt: ctx.now() }); }
        catch (error) { if (isDatabaseError(error)) throw error; }
        result.failed += 1;
        result.failures.push({ topicPublicId: buildLogisticsTopicPublicId(candidate.sessionKey), code: 'harness_revision_mismatch' });
        continue;
      }
      let after: VisibleHistory;
      let afterGroup: TopicGroup | undefined;
      try {
        const afterSnapshot = buildSourceSnapshot(ctx);
        afterGroup = afterSnapshot.groups.find(item => item.sessionKey === candidate.sessionKey);
        if (!afterGroup) throw new Error('source_topic_missing_before_commit');
        after = await readVisibleHistory(ctx, afterGroup);
      } catch {
        try { store.expireLabelRun({ runId: registration.runId, reason: 'source_boundary_unknown_before_commit', completedAt: ctx.now() }); }
        catch (error) { if (isDatabaseError(error)) throw error; }
        result.expired += 1;
        result.failures.push({ topicPublicId: buildLogisticsTopicPublicId(candidate.sessionKey), code: 'source_boundary_unknown_before_commit' });
        continue;
      }
      if (!after.complete || after.parseErrors > 0 || after.messages.some(message => !message.platformMessageId)) {
        try { store.expireLabelRun({ runId: registration.runId, reason: 'source_history_not_stable_before_commit', completedAt: ctx.now() }); }
        catch (error) { if (isDatabaseError(error)) throw error; }
        result.expired += 1;
        result.failures.push({ topicPublicId: buildLogisticsTopicPublicId(candidate.sessionKey), code: 'source_history_not_stable_before_commit' });
        continue;
      }
      const afterMessages = await buildAnalysisMessages(ctx, afterGroup!, after);
      const afterCanonical = canonicalSourceMessages(afterMessages);
      const afterGate = await checkLogisticsAnalysisLabelGate(
        { dataDir: ctx.options.dataDir, botId: ctx.options.bot.larkAppId, now: ctx.now(), group: afterGroup! },
        ctx.deps,
        after.boundary.latestVisibleAt,
      );
      if (!afterGate.allowed
        || after.boundary.fingerprint !== before.boundary.fingerprint
        || sourceSessionFingerprint(afterGroup!) !== beforeSessionFingerprint
        || !afterCanonical.reliable
        || afterCanonical.conflicted
        || afterCanonical.hash !== candidate.contentHash) {
        const reason = !afterGate.allowed
          ? 'source_activity_changed_before_commit'
          : (sourceSessionFingerprint(afterGroup!) !== beforeSessionFingerprint
            ? 'source_session_set_changed_before_commit'
            : 'source_changed_before_commit');
        try { store.expireLabelRun({ runId: registration.runId, reason, completedAt: ctx.now() }); }
        catch (error) { if (isDatabaseError(error)) throw error; }
        result.expired += 1;
        result.failures.push({
          topicPublicId: buildLogisticsTopicPublicId(candidate.sessionKey),
          code: afterGate.allowed ? reason : (afterGate.reason ?? reason),
        });
        continue;
      }
      try {
        store.commitLabel({
          runId: registration.runId,
          sessionKey: candidate.sessionKey,
          contentHash: requiredText(candidate.contentHash, 'content_hash'),
          labelerRevision: revision,
          lb: tagging.businessCategory,
          lp: tagging.problemType,
          resolutionStatus: tagging.resolutionStatus,
          confidence: tagging.overallConfidence,
          needsReview: tagging.needsReview,
          ...(labelReason(tagging) ? { labelReason: labelReason(tagging) } : {}),
          labeledAt: ctx.now(),
        });
        result.labeled += 1;
      } catch (error) {
        const code = safeErrorCode(error, 'label_commit_failed');
        if (code === 'analysis_label_content_stale') result.expired += 1;
        else result.failed += 1;
        result.failures.push({ topicPublicId: buildLogisticsTopicPublicId(candidate.sessionKey), code });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(normalizeConcurrency(ctx.options.concurrency), Math.max(1, base.page.candidates.length)) }, () => worker()));
  if (result.modelBudgetReached && lastExaminedIndex >= 0 && lastExaminedIndex < base.page.candidates.length - 1) {
    result.hasMore = true;
    result.nextCursor = encodeCursor(base.page.candidates[lastExaminedIndex]!.sessionKey);
  }
  result.pendingLabel = countPendingLabels(store, ctx.options.bot.larkAppId, revision);
  return result;
}

function resolveRevision(ctx: CollectionContext): { root: string; revision: string } {
  const root = resolvedHarnessRoot(ctx.options);
  return { root, revision: ctx.deps.resolveHarnessRevision(root) };
}

function jobLockPath(dbPath: string): string {
  return `${dbPath}.analysis-job`;
}

function runStatePath(dbPath: string): string {
  return `${dbPath}.run.json`;
}

function emptyRunState(now: number, previous?: LogisticsAnalysisRunState): LogisticsAnalysisRunState {
  return {
    schemaVersion: 1,
    status: 'running',
    startedAt: now,
    finishedAt: null,
    lastSuccessfulSyncAt: previous?.lastSuccessfulSyncAt ?? null,
    lastSuccessfulCaptureAt: previous?.lastSuccessfulCaptureAt ?? null,
    lastSuccessfulLabelAt: previous?.lastSuccessfulLabelAt ?? null,
    pendingCapture: 0,
    pendingLabel: 0,
    errorCode: null,
    ...(previous?.nextLabelCursor ? { nextLabelCursor: previous.nextLabelCursor } : {}),
  };
}

function validRunState(value: unknown): value is LogisticsAnalysisRunState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.schemaVersion === 1
    && (row.status === 'running' || row.status === 'succeeded' || row.status === 'partial' || row.status === 'failed')
    && Number.isSafeInteger(row.startedAt)
    && (row.finishedAt === null || Number.isSafeInteger(row.finishedAt))
    && (row.lastSuccessfulSyncAt === null || Number.isSafeInteger(row.lastSuccessfulSyncAt))
    && (row.lastSuccessfulCaptureAt === null || Number.isSafeInteger(row.lastSuccessfulCaptureAt))
    && (row.lastSuccessfulLabelAt === null || Number.isSafeInteger(row.lastSuccessfulLabelAt))
    && Number.isSafeInteger(row.pendingCapture)
    && Number.isSafeInteger(row.pendingLabel)
    && (row.errorCode === null || typeof row.errorCode === 'string')
    && (row.nextLabelCursor === undefined || typeof row.nextLabelCursor === 'string');
}

export function readLogisticsAnalysisRunState(dbPath: string): LogisticsAnalysisRunState | undefined {
  const path = runStatePath(resolve(dbPath));
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return validRunState(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeRunState(dbPath: string, state: LogisticsAnalysisRunState): void {
  const path = runStatePath(dbPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function stageCaptureSummary(
  ctx: CollectionContext,
  snapshot: SourceSnapshot,
  page: LogisticsAnalysisTopicPage<TopicGroup>,
): CaptureStageResult {
  return {
    mode: ctx.options.apply ? 'apply' : 'dry-run',
    db: ctx.dbPath,
    bot: ctx.options.bot.larkAppId,
    totalCandidates: page.totalCandidates,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor ?? null,
    processed: 0,
    captured: 0,
    partial: 0,
    conflict: 0,
    failed: 0,
    messages: { total: 0, inserted: 0, updated: 0, unchanged: 0, conflicts: 0, missingPlatformMessageIds: 0 },
    failures: [],
    boundaries: new Map(),
    page,
    sync: undefined,
    ...(snapshot.groups.length === 0 ? { pendingCapture: 0 } : {}),
  };
}

export async function syncLogisticsAnalysisCatalog(
  options: LogisticsAnalysisCollectionOptions,
  suppliedDeps: LogisticsAnalysisCollectionDeps = {},
): Promise<Record<string, unknown>> {
  const ctx = createContext({ ...options, apply: options.apply === true }, suppliedDeps);
  const snapshot = buildSourceSnapshot(ctx);
  if (!ctx.options.apply) {
    return {
      mode: 'dry-run',
      operation: 'sync-catalog',
      db: ctx.dbPath,
      bot: ctx.options.bot.larkAppId,
      sourceRows: snapshot.rows.length,
      topics: snapshot.groups.length,
      ...plannedSync(snapshot),
    };
  }
  mkdirSync(dirname(ctx.dbPath), { recursive: true, mode: 0o700 });
  return withFileLock(jobLockPath(ctx.dbPath), async () => {
    const store = new AnalysisStore({ dataDir: dirname(ctx.dbPath), path: ctx.dbPath });
    try {
      return {
        mode: 'apply',
        operation: 'sync-catalog',
        db: ctx.dbPath,
        bot: ctx.options.bot.larkAppId,
        sourceRows: snapshot.rows.length,
        topics: snapshot.groups.length,
        sync: store.syncSessions(snapshot.rows),
      };
    } finally {
      store.close();
    }
  });
}

export async function captureLogisticsAnalysis(
  options: LogisticsAnalysisCollectionOptions,
  suppliedDeps: LogisticsAnalysisCollectionDeps = {},
): Promise<CaptureStageResult> {
  const ctx = createContext({ ...options, apply: options.apply === true }, suppliedDeps);
  const snapshot = buildSourceSnapshot(ctx);
  const page = paginateLogisticsAnalysisTopics(snapshot.groups, { limit: ctx.options.limit, cursor: ctx.options.cursor });
  if (!ctx.options.apply) {
    return {
      ...stageCaptureSummary(ctx, snapshot, page),
      plannedSync: plannedSync(snapshot),
      candidateTopics: page.candidates.map(group => buildLogisticsTopicPublicId(group.sessionKey)),
    } as CaptureStageResult;
  }
  mkdirSync(dirname(ctx.dbPath), { recursive: true, mode: 0o700 });
  return withFileLock(jobLockPath(ctx.dbPath), async () => {
    const store = new AnalysisStore({ dataDir: dirname(ctx.dbPath), path: ctx.dbPath });
    try {
      const sync = store.syncSessions(snapshot.rows);
      const result = await capturePageWithStore(ctx, store, page);
      return {
        mode: 'apply',
        db: ctx.dbPath,
        bot: ctx.options.bot.larkAppId,
        totalCandidates: page.totalCandidates,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor ?? null,
        ...result,
        sync,
        pendingCapture: countPendingCapture(store, ctx.options.bot.larkAppId),
      };
    } finally {
      store.close();
    }
  });
}

export async function labelLogisticsAnalysis(
  options: LogisticsAnalysisCollectionOptions,
  suppliedDeps: LogisticsAnalysisCollectionDeps = {},
): Promise<LabelStageResult> {
  const ctx = createContext({ ...options, apply: options.apply === true }, suppliedDeps);
  const revisionInfo = resolveRevision(ctx);
  if (!ctx.options.apply) {
    const store = new AnalysisStore({ dataDir: dirname(ctx.dbPath), path: ctx.dbPath, readOnly: true });
    try {
      const pending = allPendingLabels(store, ctx.options.bot.larkAppId, revisionInfo.revision)
        .filter(session => !ctx.options.sessionPrefix || session.botmuxSessionId?.startsWith(ctx.options.sessionPrefix));
      const page = paginateLogisticsAnalysisTopics(pending, { limit: ctx.options.limit, cursor: ctx.options.cursor });
      const result = emptyLabelStage(ctx, revisionInfo.revision, page.totalCandidates, page.candidates.length, page);
      result.candidateTopics = page.candidates.map(item => buildLogisticsTopicPublicId(item.sessionKey));
      result.pendingLabel = pending.length;
      return result;
    } finally {
      store.close();
    }
  }
  mkdirSync(dirname(ctx.dbPath), { recursive: true, mode: 0o700 });
  return withFileLock(jobLockPath(ctx.dbPath), async () => {
    const store = new AnalysisStore({ dataDir: dirname(ctx.dbPath), path: ctx.dbPath });
    try {
      const staleAfterMs = Math.max(
        ctx.options.staleAfterMs ?? 0,
        LOGISTICS_ANALYSIS_STALE_RUN_MIN_MS,
        (ctx.options.bot.logisticsSessionMaster?.modelTask?.timeoutMs ?? 90_000) * 2 + 60_000,
      );
      const recovered = store.recoverStaleLabelRuns({ now: ctx.now(), staleAfterMs });
      const snapshot = buildSourceSnapshot(ctx);
      const runner = ctx.deps.createModelRunner(ctx.options.bot, revisionInfo.root, resolvedModel(ctx.options));
      const result = await labelPageWithStore(ctx, store, snapshot, revisionInfo.revision, runner);
      return { ...result, recoveredStaleRuns: recovered.expired };
    } finally {
      store.close();
    }
  });
}

interface RunResult {
  mode: 'dry-run' | 'apply';
  status: 'running' | 'succeeded' | 'partial' | 'failed';
  db: string;
  bot: string;
  errorCode: string | null;
  sync?: Record<string, unknown>;
  capture?: Record<string, unknown>;
  label?: Record<string, unknown>;
  pendingCapture: number;
  pendingLabel: number;
  recoveredStaleRuns?: number;
  cleanup?: { cutoff: number; deleted: number };
}

function serializeCapture(result: CapturePageResult | CaptureStageResult): Record<string, unknown> {
  return {
    processed: result.processed,
    captured: result.captured,
    partial: result.partial,
    conflict: result.conflict,
    failed: result.failed,
    totalCandidates: result.page.totalCandidates,
    hasMore: result.page.hasMore,
    nextCursor: result.page.nextCursor ?? null,
    messages: result.messages,
    failures: result.failures,
  };
}

function serializeLabel(result: LabelStageResult): Record<string, unknown> {
  return {
    harnessRevision: result.harnessRevision,
    totalCandidates: result.totalCandidates,
    candidates: result.candidates,
    created: result.created,
    reused: result.reused,
    skipped: result.skipped,
    labeled: result.labeled,
    expired: result.expired,
    failed: result.failed,
    gateSkipped: result.gateSkipped,
    attemptLimit: result.attemptLimit,
    pendingLabel: result.pendingLabel ?? null,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor,
    failures: result.failures,
    ...(result.modelBudgetReached ? { modelBudgetReached: true } : {}),
  };
}

async function dryRunAnalysis(ctx: CollectionContext): Promise<RunResult> {
  const snapshot = buildSourceSnapshot(ctx);
  const page = paginateLogisticsAnalysisTopics(snapshot.groups, { limit: ctx.options.limit, cursor: ctx.options.cursor });
  let pendingLabel = 0;
  let labelPlan: Record<string, unknown> | undefined;
  let revision: string | undefined;
  try {
    const revisionInfo = resolveRevision(ctx);
    revision = revisionInfo.revision;
    if (existsSync(ctx.dbPath)) {
      const store = new AnalysisStore({ dataDir: dirname(ctx.dbPath), path: ctx.dbPath, readOnly: true });
      try {
        pendingLabel = countPendingLabels(store, ctx.options.bot.larkAppId, revision);
        labelPlan = { databasePresent: true, harnessRevision: revision, pendingLabel };
      } finally { store.close(); }
    } else {
      labelPlan = { databasePresent: false, harnessRevision: revision, pendingLabel: null };
    }
  } catch (error) {
    labelPlan = { databasePresent: existsSync(ctx.dbPath), harnessRevision: revision ?? null, errorCode: safeErrorCode(error, 'analysis_label_plan_unavailable') };
  }
  return {
    mode: 'dry-run',
    status: 'succeeded',
    db: ctx.dbPath,
    bot: ctx.options.bot.larkAppId,
    errorCode: null,
    sync: { ...plannedSync(snapshot), sourceRows: snapshot.rows.length, topics: snapshot.groups.length },
    capture: {
      totalCandidates: page.totalCandidates,
      candidateCount: page.candidates.length,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor ?? null,
      candidateTopics: page.candidates.map(group => buildLogisticsTopicPublicId(group.sessionKey)),
    },
    label: labelPlan,
    pendingCapture: 0,
    pendingLabel,
  };
}

export async function runLogisticsAnalysis(
  options: LogisticsAnalysisCollectionOptions,
  suppliedDeps: LogisticsAnalysisCollectionDeps = {},
): Promise<RunResult> {
  const ctx = createContext({ ...options, apply: options.apply === true }, suppliedDeps);
  if (!ctx.options.apply) return dryRunAnalysis(ctx);
  mkdirSync(dirname(ctx.dbPath), { recursive: true, mode: 0o700 });
  return withFileLock(jobLockPath(ctx.dbPath), async () => {
    const previous = readLogisticsAnalysisRunState(ctx.dbPath);
    const state = emptyRunState(ctx.now(), previous);
    writeRunState(ctx.dbPath, state);
    let store: LogisticsAnalysisStore | undefined;
    let pendingCapture = 0;
    let pendingLabel = 0;
    let recoveredStaleRuns = 0;
    try {
      store = new AnalysisStore({ dataDir: dirname(ctx.dbPath), path: ctx.dbPath });
      const staleAfterMs = Math.max(
        ctx.options.staleAfterMs ?? 0,
        LOGISTICS_ANALYSIS_STALE_RUN_MIN_MS,
        (ctx.options.bot.logisticsSessionMaster?.modelTask?.timeoutMs ?? 90_000) * 2 + 60_000,
      );
      recoveredStaleRuns = store.recoverStaleLabelRuns({ now: ctx.now(), staleAfterMs }).expired;
      const snapshot = buildSourceSnapshot(ctx);
      const sync = store.syncSessions(snapshot.rows);
      state.lastSuccessfulSyncAt = ctx.now();
      writeRunState(ctx.dbPath, state);

      const captureTotal = emptyCapturePage({
        candidates: [],
        totalCandidates: snapshot.groups.length,
        hasMore: false,
      });
      let cursor = ctx.options.cursor;
      let lastCapturePage: LogisticsAnalysisTopicPage<TopicGroup> = paginateLogisticsAnalysisTopics(snapshot.groups, { limit: ctx.options.limit, cursor });
      while (true) {
        lastCapturePage = paginateLogisticsAnalysisTopics(snapshot.groups, { limit: ctx.options.limit, cursor });
        const pageResult = await capturePageWithStore(ctx, store, lastCapturePage);
        addCaptureResults(captureTotal, pageResult);
        if (!lastCapturePage.hasMore) break;
        cursor = lastCapturePage.nextCursor;
      }
      pendingCapture = countPendingCapture(store, ctx.options.bot.larkAppId);
      if (captureTotal.failed === 0 && pendingCapture === 0) state.lastSuccessfulCaptureAt = ctx.now();
      state.pendingCapture = pendingCapture;
      writeRunState(ctx.dbPath, state);

      const labelRevision = resolveRevision(ctx);
      const labelSnapshot = buildSourceSnapshot(ctx);
      const runner = ctx.deps.createModelRunner(ctx.options.bot, labelRevision.root, resolvedModel(ctx.options));
      const labelTotal: LabelStageResult = {
        mode: 'apply',
        db: ctx.dbPath,
        bot: ctx.options.bot.larkAppId,
        harnessRevision: labelRevision.revision,
        totalCandidates: 0,
        candidates: 0,
        hasMore: false,
        nextCursor: null,
        created: 0,
        reused: 0,
        skipped: 0,
        labeled: 0,
        expired: 0,
        failed: 0,
        gateSkipped: 0,
        attemptLimit: 0,
        failures: [],
      };
      const modelCounter = { started: 0 };
      let labelCursor: string | undefined = ctx.options.cursor ?? previous?.nextLabelCursor;
      if (labelCursor) state.nextLabelCursor = labelCursor;
      writeRunState(ctx.dbPath, state);
      while (true) {
        const pageOptions = {
          ...ctx.options,
          cursor: labelCursor,
          modelBudget: LOGISTICS_ANALYSIS_RUN_MODEL_BUDGET,
          modelCounter,
        };
        const pageCtx = createContext(pageOptions, suppliedDeps);
        const page = await labelPageWithStore(pageCtx, store, labelSnapshot, labelRevision.revision, runner);
        labelTotal.totalCandidates = page.totalCandidates;
        labelTotal.candidates += page.candidates;
        labelTotal.created += page.created;
        labelTotal.reused += page.reused;
        labelTotal.skipped += page.skipped;
        labelTotal.labeled += page.labeled;
        labelTotal.expired += page.expired;
        labelTotal.failed += page.failed;
        labelTotal.gateSkipped += page.gateSkipped;
        labelTotal.attemptLimit += page.attemptLimit;
        labelTotal.failures.push(...page.failures);
        labelTotal.hasMore = page.hasMore;
        labelTotal.nextCursor = page.nextCursor ?? null;
        pendingLabel = page.pendingLabel ?? countPendingLabels(store, ctx.options.bot.larkAppId, labelRevision.revision);
        if (page.hasMore) {
          labelCursor = page.nextCursor ?? undefined;
          if (modelCounter.started >= LOGISTICS_ANALYSIS_RUN_MODEL_BUDGET) {
            state.nextLabelCursor = labelCursor;
            state.pendingCapture = pendingCapture;
            state.pendingLabel = pendingLabel;
            writeRunState(ctx.dbPath, state);
            break;
          }
        } else {
          state.nextLabelCursor = undefined;
          break;
        }
      }
      labelTotal.pendingLabel = pendingLabel;
      if (labelTotal.failed === 0 && labelTotal.expired === 0 && pendingLabel === 0) state.lastSuccessfulLabelAt = ctx.now();
      state.pendingCapture = pendingCapture;
      state.pendingLabel = pendingLabel;
      const partial = captureTotal.failed > 0 || captureTotal.partial > 0 || captureTotal.conflict > 0
        || labelTotal.failed > 0 || labelTotal.expired > 0 || labelTotal.gateSkipped > 0
        || pendingCapture > 0 || pendingLabel > 0;
      state.status = partial ? 'partial' : 'succeeded';
      state.errorCode = partial ? 'analysis_partial' : null;
      state.finishedAt = ctx.now();
      writeRunState(ctx.dbPath, state);
      const cleanup = store.cleanupOldLabelRuns({ now: ctx.now() });
      return {
        mode: 'apply',
        status: state.status,
        db: ctx.dbPath,
        bot: ctx.options.bot.larkAppId,
        errorCode: state.errorCode,
        sync: { ...sync },
        capture: serializeCapture(captureTotal),
        label: serializeLabel(labelTotal),
        pendingCapture,
        pendingLabel,
        recoveredStaleRuns,
        cleanup,
      };
    } catch (error) {
      const code = safeErrorCode(error, 'analysis_run_failed');
      state.status = 'failed';
      state.errorCode = code;
      state.pendingCapture = pendingCapture;
      state.pendingLabel = pendingLabel;
      state.finishedAt = ctx.now();
      try { writeRunState(ctx.dbPath, state); } catch { /* preserve original failure */ }
      return {
        mode: 'apply',
        status: 'failed',
        db: ctx.dbPath,
        bot: ctx.options.bot.larkAppId,
        errorCode: code,
        pendingCapture,
        pendingLabel,
        recoveredStaleRuns,
      };
    } finally {
      try { store?.close(); } catch { /* preserve run result */ }
    }
  });
}

function optionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0) {
    const next = args[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`analysis_${flag.slice(2).replaceAll('-', '_')}_required`);
    return next;
  }
  const prefix = `${flag}=`;
  const equal = args.find(arg => arg.startsWith(prefix));
  return equal?.slice(prefix.length) || undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag) || args.some(arg => arg === `${flag}=true`);
}

function parseAnalysisArgs(sub: string, args: string[], dataDir: string): LogisticsAnalysisCollectionOptions & { sourcePath?: string } {
  const knownWithValue = new Set(['--db', '--source', '--bot', '--harness-root', '--model', '--limit', '--cursor', '--session', '--concurrency', '--stale-after-ms']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--apply' || arg === '--dry-run') continue;
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (!knownWithValue.has(flag)) throw new Error(`analysis_unknown_option:${arg}`);
    if (!arg.includes('=')) index += 1;
  }
  const botId = optionValue(args, '--bot');
  const sourcePath = optionValue(args, '--source');
  const dbRaw = optionValue(args, '--db');
  const dbPath = sub === 'migrate'
    ? requiredText(dbRaw, 'db')
    : resolve(dbRaw ?? join(dataDir, LOGISTICS_ANALYSIS_DEFAULT_DB_NAME));
  if (sub !== 'migrate') requiredText(botId, 'bot');
  const limitRaw = optionValue(args, '--limit');
  const concurrencyRaw = optionValue(args, '--concurrency');
  const staleRaw = optionValue(args, '--stale-after-ms');
  const parsedLimit = limitRaw === undefined ? undefined : Number(limitRaw);
  const parsedConcurrency = concurrencyRaw === undefined ? undefined : Number(concurrencyRaw);
  const parsedStale = staleRaw === undefined ? undefined : Number(staleRaw);
  if (hasFlag(args, '--apply') && hasFlag(args, '--dry-run')) {
    throw new Error('analysis_apply_dry_run_conflict');
  }
  normalizePageLimit(parsedLimit);
  normalizeConcurrency(parsedConcurrency);
  safeInteger(parsedStale, 'stale_after_ms');
  if (sub === 'migrate') {
    return {
      dataDir,
      dbPath,
      bot: { larkAppId: botId ?? '', cliId: 'codex' },
      apply: hasFlag(args, '--apply'),
      limit: parsedLimit,
      cursor: optionValue(args, '--cursor'),
      sessionPrefix: optionValue(args, '--session'),
      concurrency: parsedConcurrency,
      harnessRoot: optionValue(args, '--harness-root'),
      model: optionValue(args, '--model'),
      staleAfterMs: parsedStale,
      sourcePath: requiredText(sourcePath, 'source'),
    };
  }
  const bot = loadBotConfigs().find(item => item.larkAppId === botId) as BotConfig | undefined;
  if (!bot) throw new Error(`analysis_bot_not_found:${botId}`);
  registerBot(bot);
  return {
    dataDir,
    dbPath,
    bot,
    apply: hasFlag(args, '--apply'),
    limit: parsedLimit,
    cursor: optionValue(args, '--cursor'),
    sessionPrefix: optionValue(args, '--session'),
    concurrency: parsedConcurrency,
    harnessRoot: optionValue(args, '--harness-root'),
    model: optionValue(args, '--model'),
    staleAfterMs: parsedStale,
  };
}

function printAnalysisUsage(message?: string): never {
  if (message) console.error(message);
  console.error(`Usage:
  botmux logistics analysis sync-catalog [--db <four-table-db>] --bot <appId> [--apply]
  botmux logistics analysis capture [--db <four-table-db>] --bot <appId> [--limit N] [--cursor <opaque>] [--apply]
  botmux logistics analysis label [--db <four-table-db>] --bot <appId> [--harness-root <dir>] [--model <id>] [--limit N] [--cursor <opaque>] [--concurrency N] [--apply]
  botmux logistics analysis run [--db <four-table-db>] --bot <appId> [--harness-root <dir>] [--model <id>] [--limit N] [--concurrency N] [--apply]
  botmux logistics analysis migrate --source <source.sqlite> --db <four-table-db> [--apply]

All commands default to dry-run. The omitted --db default is the dedicated
four-table file logistics-analysis.sqlite under BotMux dataDir; the legacy
botmux-conversations.sqlite is never selected.`);
  throw new Error('analysis_usage');
}

export async function runLogisticsAnalysisCommand(
  sub: string,
  args: string[],
  dataDir: string,
): Promise<void> {
  if (!['sync-catalog', 'capture', 'label', 'run', 'migrate'].includes(sub)) printAnalysisUsage(`Unknown analysis operation: ${sub}`);
  let options: LogisticsAnalysisCollectionOptions & { sourcePath?: string };
  try { options = parseAnalysisArgs(sub, args, dataDir); }
  catch (error) { printAnalysisUsage(safeErrorCode(error, error instanceof Error ? error.message : 'analysis_invalid_arguments')); }
  if (sub === 'sync-catalog') console.log(JSON.stringify(await syncLogisticsAnalysisCatalog(options), null, 2));
  else if (sub === 'capture') console.log(JSON.stringify(await captureLogisticsAnalysis(options), null, 2));
  else if (sub === 'label') console.log(JSON.stringify(await labelLogisticsAnalysis(options), null, 2));
  else if (sub === 'run') console.log(JSON.stringify(await runLogisticsAnalysis(options), null, 2));
  else {
    const targetPath = requiredText(options.dbPath, 'db');
    if (!options.apply) {
      console.log(JSON.stringify(migrateLogisticsAnalysisDatabase({
        sourcePath: requiredText(options.sourcePath, 'source'),
        targetPath,
        apply: false,
        now: options.now,
      }), null, 2));
      return;
    }
    mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
    const report = await withFileLock(jobLockPath(targetPath), async () => migrateLogisticsAnalysisDatabase({
      sourcePath: requiredText(options.sourcePath, 'source'),
      targetPath,
      apply: true,
      now: options.now,
    }));
    console.log(JSON.stringify(report, null, 2));
  }
}
