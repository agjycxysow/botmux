import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

import { sanitizeLogisticsMessageText } from './logistics-session-capture.js';
import {
  canPreferLogisticsRecoveryMessage,
  isTrustedLogisticsRecoveryMessage,
  LogisticsAnalysisStore,
  type LogisticsAnalysisCaptureStatus,
  type LogisticsAnalysisMessageInput,
  type LogisticsAnalysisMessageSource,
  type LogisticsAnalysisSessionInput,
  type LogisticsAnalysisSessionStatus,
} from './logistics-analysis-store.js';
import {
  buildLogisticsTopicKey,
  buildLogisticsTopicPublicId,
  classifyLogisticsTopic,
  type LogisticsTopicExclusionReason,
} from './logistics-analysis-topic.js';

const require = createRequire(import.meta.url);

export interface LogisticsAnalysisMigrationOptions {
  sourcePath: string;
  targetPath: string;
  apply?: boolean;
  now?: number;
}

export interface LogisticsAnalysisMigrationConflict {
  topicPublicId: string;
  platformMessageIdHash: string;
  candidateCount: number;
  sourceSet: LogisticsAnalysisMessageSource[];
  kind: 'same_source_revision' | 'trusted_recovery_conflict' | 'unresolved';
  importedCandidateCount: number;
}

export interface LogisticsAnalysisMigrationResolvedConflict {
  topicPublicId: string;
  platformMessageIdHash: string;
  candidateCount: number;
  sourceSet: LogisticsAnalysisMessageSource[];
  selectedSource: LogisticsAnalysisMessageSource;
  discardedCandidateCount: number;
  reason: 'trusted_recovery_replaced_placeholder';
}

export interface LogisticsAnalysisMigrationReport {
  mode: 'dry-run' | 'apply';
  sourcePath: string;
  targetPath: string;
  sourceSchemaVersion: number;
  source: {
    sessionCatalogRows: number;
    threadSessionRows: number;
    topics: number;
    messageRows: number;
    oldLabelRows: number;
  };
  excluded: {
    total: number;
    byReason: Record<LogisticsTopicExclusionReason, number>;
  };
  messages: {
    candidateRows: number;
    uniqueGroups: number;
    duplicateRows: number;
    rawConflictGroups: number;
    trustedResolvedGroups: number;
    unresolvedConflictGroups: number;
    rawConflictRows: number;
    trustedResolvedRows: number;
    selectedRows: number;
    conflictRowsExcluded: number;
    missingPlatformIdRows: number;
    missingPlatformIdTopics: number;
    conflicts: LogisticsAnalysisMigrationConflict[];
    resolvedConflicts: LogisticsAnalysisMigrationResolvedConflict[];
  };
  labels: {
    sourceRows: number;
    importedRows: 0;
    skippedRows: number;
  };
  topics: {
    captured: number;
    running: number;
    partial: number;
    failed: number;
    conflict: number;
    pending: number;
  };
  apply?: {
    targetSessionsInserted: number;
    targetSessionsUpdated: number;
    targetSessionsUnchanged: number;
    targetMessagesInserted: number;
    targetMessagesUpdated: number;
    targetMessagesUnchanged: number;
    targetCaptureUpdates: number;
  };
}

interface SourceCatalogRow {
  session_key: string;
  lark_app_id: string;
  session_id: string;
  chat_id: string;
  root_message_id?: string | null;
  scope?: string | null;
  session_status?: string | null;
  title?: string | null;
  created_at?: number | null;
  last_message_at?: number | null;
  special_session?: number | null;
  backfill_status?: string | null;
  backfill_error?: string | null;
  updated_at?: number | null;
}

interface SourceConversationRow {
  lark_app_id: string;
  session_id: string;
  initiator_id?: string | null;
  initiator_name?: string | null;
  title?: string | null;
  cli_session_id?: string | null;
}

interface SourceMessageRow {
  source_session_key: string;
  source_session_id: string;
  lark_app_id: string;
  chat_id: string;
  root_message_id?: string | null;
  scope?: string | null;
  special_session?: number | null;
  message_id?: string | null;
  platform_message_id?: string | null;
  role: string;
  content: string;
  sender_id?: string | null;
  sender_name?: string | null;
  occurred_at?: number | null;
  response_kind?: string | null;
  source?: string | null;
  captured_at?: number | null;
}

interface SourceCandidate extends LogisticsAnalysisMessageInput {
  sourceSessionId: string;
  capturedAt: number;
  groupKey: string;
  platformMessageId?: string;
  trusted: boolean;
  contentHash: string;
}

interface TopicAggregate {
  sessionKey: string;
  botId: string;
  chatId: string;
  rootMessageId: string;
  rows: SourceCatalogRow[];
  latest: SourceCatalogRow;
  conversation?: SourceConversationRow;
  candidates: SourceCandidate[];
  conflictGroups: Set<string>;
}

interface MessageGroupResolution {
  selected?: SourceCandidate;
  conflict?: LogisticsAnalysisMigrationConflict;
  resolvedConflict?: LogisticsAnalysisMigrationResolvedConflict;
}

function asNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function asText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function source(value: unknown): LogisticsAnalysisMessageSource {
  return value === 'lark_history'
    || value === 'botmux_send_marker'
    || value === 'codex_rollout'
    ? value : 'legacy';
}

function sourceStatus(value: string | null | undefined): LogisticsAnalysisCaptureStatus {
  if (value === 'captured') return 'captured';
  if (value === 'processing') return 'running';
  if (value === 'history_failed') return 'failed';
  if (value === 'missing_turn' || value === 'missing_answer') return 'partial';
  return 'pending';
}

function sourceSessionStatus(value: string | null | undefined): LogisticsAnalysisSessionStatus {
  return value === 'active' || value === 'closed' ? value : 'unknown';
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function assertDistinctDatabaseFiles(sourcePath: string, targetPath: string): void {
  if (canonicalPath(sourcePath) === canonicalPath(targetPath)) {
    throw new Error('migration_source_target_same');
  }
  if (!existsSync(targetPath)) return;
  const sourceStat = statSync(sourcePath);
  const targetStat = statSync(targetPath);
  if (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) {
    throw new Error('migration_source_target_same');
  }
}

function conflictKind(candidates: SourceCandidate[]): LogisticsAnalysisMigrationConflict['kind'] {
  const sources = new Set(candidates.map(candidate => candidate.source));
  if (sources.size === 1) return 'same_source_revision';
  if (candidates.some(candidate => candidate.trusted)) return 'trusted_recovery_conflict';
  return 'unresolved';
}

function resolveMessageGroup(
  topic: TopicAggregate,
  groupKey: string,
  candidates: SourceCandidate[],
): MessageGroupResolution {
  const hashes = new Set(candidates.map(candidate => candidate.contentHash));
  if (hashes.size === 1) {
    return { selected: candidates[0] };
  }
  const preferred = candidates.filter(candidate => candidate.trusted && candidates
    .filter(other => other.contentHash !== candidate.contentHash)
    .every(other => canPreferLogisticsRecoveryMessage(candidate, other)));
  if (new Set(preferred.map(candidate => candidate.contentHash)).size === 1 && preferred.length > 0) {
    const selected = preferred[0]!;
    return {
      selected,
      resolvedConflict: {
        topicPublicId: buildLogisticsTopicPublicId(topic.sessionKey),
        platformMessageIdHash: hashKey(candidates.find(candidate => candidate.platformMessageId)?.platformMessageId ?? groupKey),
        candidateCount: candidates.length,
        sourceSet: [...new Set(candidates.map(candidate => candidate.source))].sort(),
        selectedSource: selected.source,
        discardedCandidateCount: candidates.length - 1,
        reason: 'trusted_recovery_replaced_placeholder',
      },
    };
  }
  topic.conflictGroups.add(groupKey);
  const platformMessageId = candidates.find(candidate => candidate.platformMessageId)?.platformMessageId;
  return {
    conflict: {
      topicPublicId: buildLogisticsTopicPublicId(topic.sessionKey),
      platformMessageIdHash: hashKey(platformMessageId ?? groupKey),
      candidateCount: candidates.length,
      sourceSet: [...new Set(candidates.map(candidate => candidate.source))].sort(),
      kind: conflictKind(candidates),
      importedCandidateCount: 0,
    },
  };
}

function aggregateCaptureStatus(topic: TopicAggregate, selectedRows: number): LogisticsAnalysisCaptureStatus {
  if (topic.conflictGroups.size) return 'conflict';
  const statuses = topic.rows.map(row => sourceStatus(row.backfill_status));
  if (statuses.length > 0 && statuses.every(status => status === 'captured')) return 'captured';
  if (selectedRows > 0) return 'partial';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('running')) return 'running';
  return 'pending';
}

function topicSessionInput(topic: TopicAggregate, status: LogisticsAnalysisCaptureStatus): LogisticsAnalysisSessionInput {
  const conversation = topic.conversation;
  const latest = topic.latest;
  const createdAt = Math.min(...topic.rows.map(row => asNumber(row.created_at) ?? 0));
  const lastMessageAt = Math.max(...topic.rows.map(row => asNumber(row.last_message_at) ?? 0)) || undefined;
  const updatedAt = Math.max(...topic.rows.map(row => asNumber(row.updated_at) ?? 0), lastMessageAt ?? 0, createdAt);
  return {
    sessionKey: topic.sessionKey,
    botmuxSessionId: latest.session_id,
    ...(conversation?.cli_session_id ? { cliSessionId: conversation.cli_session_id } : {}),
    botId: topic.botId,
    chatId: topic.chatId,
    scope: 'thread',
    rootMessageId: topic.rootMessageId,
    title: latest.title ?? conversation?.title ?? undefined,
    ...(conversation?.initiator_id ? { initiatorId: conversation.initiator_id } : {}),
    ...(conversation?.initiator_name ? { initiatorName: conversation.initiator_name } : {}),
    sessionStatus: sourceSessionStatus(latest.session_status),
    createdAt,
    ...(lastMessageAt ? { lastMessageAt } : {}),
    captureStatus: status,
    ...(latest.backfill_error ? { captureError: latest.backfill_error } : {}),
    updatedAt,
  };
}

function sourceColumns(db: DatabaseSyncType, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name));
}

function loadSourceData(db: DatabaseSyncType): {
  schemaVersion: number;
  catalogRows: SourceCatalogRow[];
  conversations: Map<string, SourceConversationRow>;
  messageRows: SourceMessageRow[];
  oldLabelRows: number;
} {
  const tables = new Set((db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  ).all() as Array<{ name: string }>).map(row => row.name));
  for (const table of ['session_catalog', 'conversation_messages']) {
    if (!tables.has(table)) throw new Error(`migration_source_table_missing:${table}`);
  }
  const conversationColumns = tables.has('conversations') ? sourceColumns(db, 'conversations') : new Set<string>();
  const cliSessionExpression = conversationColumns.has('cli_session_id') ? 'c.cli_session_id' : 'NULL';
  const conversations = new Map<string, SourceConversationRow>();
  if (tables.has('conversations')) {
    const rows = db.prepare(`
      SELECT c.lark_app_id,c.session_id,c.initiator_id,c.initiator_name,c.title,
        ${cliSessionExpression} AS cli_session_id
      FROM conversations c
    `).all() as unknown as SourceConversationRow[];
    for (const row of rows) conversations.set(`${row.lark_app_id}\u0000${row.session_id}`, row);
  }
  const catalogRows = db.prepare('SELECT * FROM session_catalog ORDER BY session_key').all() as unknown as SourceCatalogRow[];
  const messageRows = db.prepare(`
    SELECT m.session_key AS source_session_key,sc.session_id AS source_session_id,
      sc.lark_app_id,sc.chat_id,sc.root_message_id,sc.scope,sc.special_session,
      m.message_id,m.platform_message_id,m.role,m.content,m.sender_id,m.sender_name,
      m.occurred_at,m.response_kind,m.source,m.captured_at
    FROM conversation_messages m
    JOIN session_catalog sc ON sc.session_key=m.session_key
    ORDER BY m.session_key,m.occurred_at IS NULL,m.occurred_at,m.message_id
  `).all() as unknown as SourceMessageRow[];
  let oldLabelRows = 0;
  if (tables.has('conversation_labels')) {
    oldLabelRows = Number((db.prepare('SELECT COUNT(*) count FROM conversation_labels').get() as { count?: number }).count ?? 0);
  }
  const schemaVersion = Number((db.prepare('PRAGMA user_version').get() as { user_version?: number }).user_version ?? 0);
  return { schemaVersion, catalogRows, conversations, messageRows, oldLabelRows };
}

function buildPlan(data: ReturnType<typeof loadSourceData>): {
  topics: Map<string, TopicAggregate>;
  excluded: { total: number; byReason: Record<LogisticsTopicExclusionReason, number> };
  messages: LogisticsAnalysisMessageInput[];
  conflicts: LogisticsAnalysisMigrationConflict[];
  resolvedConflicts: LogisticsAnalysisMigrationResolvedConflict[];
  candidateRows: number;
  uniqueGroups: number;
  duplicateRows: number;
  rawConflictGroups: number;
  trustedResolvedGroups: number;
  unresolvedConflictGroups: number;
  rawConflictRows: number;
  trustedResolvedRows: number;
  conflictRowsExcluded: number;
  missingPlatformIdRows: number;
  missingPlatformIdTopics: number;
  statusCounts: Record<LogisticsAnalysisCaptureStatus, number>;
  migrationAt: number;
} {
  const bySourceSession = new Map<string, TopicAggregate>();
  const topics = new Map<string, TopicAggregate>();
  const excludedByReason: Record<LogisticsTopicExclusionReason, number> = {
    special_session: 0,
    chat_scope: 0,
    non_thread_scope: 0,
    missing_root: 0,
  };
  for (const row of data.catalogRows) {
    const reason = classifyLogisticsTopic({
      scope: row.scope,
      rootMessageId: row.root_message_id,
      specialSession: row.special_session,
    });
    if (reason) {
      excludedByReason[reason] += 1;
      continue;
    }
    const botId = asText(row.lark_app_id)!;
    const chatId = asText(row.chat_id)!;
    const rootMessageId = asText(row.root_message_id)!;
    const sessionKey = buildLogisticsTopicKey({ botId, chatId, rootMessageId });
    const topic = topics.get(sessionKey) ?? {
      sessionKey,
      botId,
      chatId,
      rootMessageId,
      rows: [],
      latest: row,
      conversation: data.conversations.get(`${botId}\u0000${row.session_id}`),
      candidates: [],
      conflictGroups: new Set<string>(),
    };
    topic.rows.push(row);
    const currentAt = asNumber(topic.latest.updated_at) ?? asNumber(topic.latest.last_message_at) ?? 0;
    const rowAt = asNumber(row.updated_at) ?? asNumber(row.last_message_at) ?? 0;
    if (rowAt >= currentAt) {
      topic.latest = row;
      topic.conversation = data.conversations.get(`${botId}\u0000${row.session_id}`) ?? topic.conversation;
    }
    topics.set(sessionKey, topic);
    bySourceSession.set(row.session_key, topic);
  }
  const groups = new Map<string, SourceCandidate[]>();
  let candidateRows = 0;
  let missingPlatformIdRows = 0;
  let migrationAt = 0;
  for (const [rowIndex, row] of data.messageRows.entries()) {
    const topic = bySourceSession.get(row.source_session_key);
    if (!topic) continue;
    const content = sanitizeLogisticsMessageText(row.content);
    if (!content) continue;
    const messageSource = source(row.source);
    const responseKind = row.response_kind === 'final' ? 'final' as const : undefined;
    const occurredAt = asNumber(row.occurred_at);
    const capturedAt = asNumber(row.captured_at) ?? occurredAt ?? 0;
    migrationAt = Math.max(migrationAt, capturedAt);
    const platformMessageId = asText(row.platform_message_id);
    const groupKey = platformMessageId
      ? `${topic.sessionKey}\u0000platform\u0000${platformMessageId}`
      : `${topic.sessionKey}\u0000source\u0000${row.source_session_key}\u0000${row.message_id ?? `row_${rowIndex}`}`;
    const messageKey = platformMessageId
      ? undefined
      : `msg_${hashKey(`${groupKey}\u0000${content}\u0000${occurredAt ?? ''}`)}`;
    const contentHash = createHash('sha256').update(content).digest('hex');
    const candidate: SourceCandidate = {
      sessionKey: topic.sessionKey,
      ...(messageKey ? { messageKey } : {}),
      ...(platformMessageId ? { platformMessageId } : {}),
      role: row.role === 'user' ? 'user' : 'assistant',
      ...(asText(row.sender_id) ? { senderId: asText(row.sender_id) } : {}),
      ...(asText(row.sender_name) ? { senderName: asText(row.sender_name) } : {}),
      content,
      ...(occurredAt === undefined ? {} : { occurredAt }),
      ...(responseKind ? { responseKind } : {}),
      source: messageSource,
      sourceSessionId: row.source_session_id,
      capturedAt,
      groupKey,
      trusted: isTrustedLogisticsRecoveryMessage({
        role: row.role === 'user' ? 'user' : 'assistant',
        source: messageSource,
        ...(responseKind ? { responseKind } : {}),
        content,
      }),
      contentHash,
    };
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), candidate]);
    topic.candidates.push(candidate);
    candidateRows += 1;
    if (!platformMessageId) missingPlatformIdRows += 1;
  }
  const messages: LogisticsAnalysisMessageInput[] = [];
  const conflicts: LogisticsAnalysisMigrationConflict[] = [];
  const resolvedConflicts: LogisticsAnalysisMigrationResolvedConflict[] = [];
  for (const [groupKey, candidates] of groups) {
    const topic = topics.get(candidates[0]!.sessionKey)!;
    const resolution = resolveMessageGroup(topic, groupKey, candidates);
    if (resolution.conflict) {
      conflicts.push(resolution.conflict);
      continue;
    }
    if (resolution.resolvedConflict) resolvedConflicts.push(resolution.resolvedConflict);
    const selected = resolution.selected!;
    messages.push({
      sessionKey: selected.sessionKey,
      ...(selected.messageKey ? { messageKey: selected.messageKey } : {}),
      ...(selected.platformMessageId ? { platformMessageId: selected.platformMessageId } : {}),
      role: selected.role,
      ...(selected.senderId ? { senderId: selected.senderId } : {}),
      ...(selected.senderName ? { senderName: selected.senderName } : {}),
      content: selected.content,
      ...(selected.occurredAt === undefined ? {} : { occurredAt: selected.occurredAt }),
      ...(selected.responseKind ? { responseKind: selected.responseKind } : {}),
      source: selected.source,
    });
  }
  let conflictRowsExcluded = 0;
  for (const conflict of conflicts) conflictRowsExcluded += conflict.candidateCount;
  const statusCounts: Record<LogisticsAnalysisCaptureStatus, number> = {
    pending: 0,
    running: 0,
    captured: 0,
    partial: 0,
    failed: 0,
    conflict: 0,
  };
  for (const topic of topics.values()) {
    const selectedRows = messages.filter(message => message.sessionKey === topic.sessionKey).length;
    statusCounts[aggregateCaptureStatus(topic, selectedRows)] += 1;
  }
  return {
    topics,
    excluded: { total: data.catalogRows.length - [...bySourceSession.keys()].length, byReason: excludedByReason },
    messages,
    conflicts,
    resolvedConflicts,
    candidateRows,
    uniqueGroups: groups.size,
    duplicateRows: Math.max(0, candidateRows - groups.size),
    rawConflictGroups: conflicts.length + resolvedConflicts.length,
    trustedResolvedGroups: resolvedConflicts.length,
    unresolvedConflictGroups: conflicts.length,
    rawConflictRows: [...conflicts, ...resolvedConflicts].reduce((sum, conflict) => sum + conflict.candidateCount, 0),
    trustedResolvedRows: resolvedConflicts.reduce((sum, conflict) => sum + conflict.discardedCandidateCount, 0),
    conflictRowsExcluded,
    missingPlatformIdRows,
    missingPlatformIdTopics: new Set(
      [...groups.values()]
        .flatMap(candidates => candidates)
        .filter(candidate => !candidate.platformMessageId)
        .map(candidate => candidate.sessionKey),
    ).size,
    statusCounts,
    migrationAt,
  };
}

export function migrateLogisticsAnalysisDatabase(
  options: LogisticsAnalysisMigrationOptions,
): LogisticsAnalysisMigrationReport {
  if (!options.sourcePath?.trim()) throw new Error('migration_source_required');
  if (!options.targetPath?.trim()) throw new Error('migration_target_required');
  const sourcePath = canonicalPath(resolve(options.sourcePath));
  const targetPath = resolve(options.targetPath);
  assertDistinctDatabaseFiles(sourcePath, targetPath);
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  const sourceDb = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const data = loadSourceData(sourceDb);
    const plan = buildPlan(data);
    const report: LogisticsAnalysisMigrationReport = {
      mode: options.apply === true ? 'apply' : 'dry-run',
      sourcePath,
      targetPath,
      sourceSchemaVersion: data.schemaVersion,
      source: {
        sessionCatalogRows: data.catalogRows.length,
        threadSessionRows: [...plan.topics.values()].reduce((sum, topic) => sum + topic.rows.length, 0),
        topics: plan.topics.size,
        messageRows: plan.candidateRows,
        oldLabelRows: data.oldLabelRows,
      },
      excluded: plan.excluded,
      messages: {
        candidateRows: plan.candidateRows,
        uniqueGroups: plan.uniqueGroups,
        duplicateRows: plan.duplicateRows,
        rawConflictGroups: plan.rawConflictGroups,
        trustedResolvedGroups: plan.trustedResolvedGroups,
        unresolvedConflictGroups: plan.unresolvedConflictGroups,
        rawConflictRows: plan.rawConflictRows,
        trustedResolvedRows: plan.trustedResolvedRows,
        selectedRows: plan.messages.length,
        conflictRowsExcluded: plan.conflictRowsExcluded,
        missingPlatformIdRows: plan.missingPlatformIdRows,
        missingPlatformIdTopics: plan.missingPlatformIdTopics,
        conflicts: plan.conflicts,
        resolvedConflicts: plan.resolvedConflicts,
      },
      labels: {
        sourceRows: data.oldLabelRows,
        importedRows: 0,
        skippedRows: data.oldLabelRows,
      },
      topics: plan.statusCounts,
    };
    if (options.apply !== true) return report;
    const store = new LogisticsAnalysisStore({ dataDir: dirname(targetPath), path: targetPath });
    try {
      const sessionInputs = [...plan.topics.values()].map(topic => topicSessionInput(
        topic,
        aggregateCaptureStatus(topic, plan.messages.filter(message => message.sessionKey === topic.sessionKey).length),
      ));
      const sync = store.syncSessions(sessionInputs);
      const messageWrite = store.upsertMessages(plan.messages, options.now ?? (plan.migrationAt || Date.now()));
      let captureUpdates = 0;
      for (const topic of plan.topics.values()) {
        const status = aggregateCaptureStatus(
          topic,
          plan.messages.filter(message => message.sessionKey === topic.sessionKey).length,
        );
        store.markCaptureResult({
          sessionKey: topic.sessionKey,
          status,
          ...(status === 'conflict' ? { error: 'platform_message_content_conflict' } : {}),
          updatedAt: options.now ?? Math.max(
            ...topic.rows.map(row => asNumber(row.updated_at) ?? 0),
            plan.migrationAt,
          ),
        });
        captureUpdates += 1;
      }
      report.apply = {
        targetSessionsInserted: sync.inserted,
        targetSessionsUpdated: sync.updated,
        targetSessionsUnchanged: sync.unchanged,
        targetMessagesInserted: messageWrite.inserted,
        targetMessagesUpdated: messageWrite.updated,
        targetMessagesUnchanged: messageWrite.unchanged,
        targetCaptureUpdates: captureUpdates,
      };
      return report;
    } finally {
      store.close();
    }
  } finally {
    sourceDb.close();
  }
}
