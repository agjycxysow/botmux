import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadBotConfigs, registerBot, type BotConfig } from '../bot-registry.js';
import { listChatMessagesUntil, listThreadMessages } from '../im/lark/client.js';
import { parseApiMessage } from '../im/lark/message-parser.js';
import {
  buildLogisticsSessionSnapshot,
  sanitizeLogisticsMessageText,
} from '../services/logistics-session-capture.js';
import {
  LogisticsConversationStore,
  type LogisticsCapturedMessageInput,
  type LogisticsSessionCatalogInput,
} from '../services/logistics-conversation-store.js';
import {
  stableLogisticsSessionMasterKey,
  type LogisticsSessionMasterRecord,
} from '../services/logistics-session-master.js';
import {
  createLogisticsSessionModelTaskRunner,
  isLogisticsHarnessRecordAnalyzable,
  prepareLogisticsHarnessRecord,
  resolveLogisticsHarnessRevision,
} from '../services/logistics-session-model-task.js';
import { loadAllSessionsSnapshot } from '../services/session-store.js';
import type { Session } from '../types.js';

interface BackfillOptions {
  apply: boolean;
  bot?: string;
  session?: string;
  since?: number;
  until?: number;
  limit: number;
  cursor?: string;
}

interface LabelOptions {
  apply: boolean;
  force: boolean;
  bot?: string;
  session?: string;
  limit: number;
  concurrency: number;
  cursor?: string;
  harnessRoot?: string;
  model?: string;
}

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(`Usage:
  botmux logistics sync-catalog [--bot <appId>]
  botmux logistics backfill [--bot <appId>] [--session <id-prefix>] [--since <ISO|YYYY-MM-DD>] [--until <ISO|YYYY-MM-DD>] [--limit N] [--cursor <opaque>] [--apply]
  botmux logistics label [--bot <appId>] [--session <id-prefix>] [--limit N] [--cursor <opaque>] [--concurrency N] [--harness-root <dir>] [--model <id>] [--force] [--apply]
  botmux logistics import-legacy [--bot <appId>]
  botmux logistics import-surveys [--bot <appId>]

backfill defaults to dry-run. It reads bounded BotMux session metadata; --apply fetches
visible Lark history and writes sanitized message facts plus bounded snapshots to SQLite.
It never runs semantic labeling.

label defaults to dry-run. It reads only captured SQLite snapshots and invokes the
configured read-only Labeling Harness when --apply is present.`);
  process.exit(2);
}

function value(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0) {
    const next = args[index + 1];
    if (!next || next.startsWith('--')) usage(`Missing value for ${flag}`);
    return next;
  }
  const prefix = `${flag}=`;
  const eq = args.find(arg => arg.startsWith(prefix));
  return eq?.slice(prefix.length) || undefined;
}

function dateArg(raw: string | undefined, end: boolean): number | undefined {
  if (!raw) return undefined;
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed = Date.parse(dayOnly ? `${raw}T00:00:00+08:00` : raw);
  if (!Number.isFinite(parsed)) usage(`Invalid date: ${raw}`);
  return dayOnly && end ? parsed + 24 * 60 * 60_000 : parsed;
}

function parseBackfill(args: string[]): BackfillOptions {
  const knownWithValue = new Set(['--bot', '--session', '--since', '--until', '--limit', '--cursor']);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--apply') continue;
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (!knownWithValue.has(flag)) usage(`Unknown option: ${arg}`);
    if (!arg.includes('=')) i += 1;
  }
  const limitRaw = value(args, '--limit');
  const limit = limitRaw ? Number(limitRaw) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) usage('--limit must be 1..500');
  return {
    apply: args.includes('--apply'),
    bot: value(args, '--bot'),
    session: value(args, '--session'),
    since: dateArg(value(args, '--since'), false),
    until: dateArg(value(args, '--until'), true),
    limit,
    cursor: value(args, '--cursor'),
  };
}

function parseLabel(args: string[]): LabelOptions {
  const knownWithValue = new Set([
    '--bot', '--session', '--limit', '--cursor', '--concurrency', '--harness-root', '--model',
  ]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--apply' || arg === '--force') continue;
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (!knownWithValue.has(flag)) usage(`Unknown option: ${arg}`);
    if (!arg.includes('=')) i += 1;
  }
  const limitRaw = value(args, '--limit');
  const limit = limitRaw ? Number(limitRaw) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) usage('--limit must be 1..500');
  const concurrencyRaw = value(args, '--concurrency');
  const concurrency = concurrencyRaw ? Number(concurrencyRaw) : 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    usage('--concurrency must be 1..8');
  }
  return {
    apply: args.includes('--apply'),
    force: args.includes('--force'),
    bot: value(args, '--bot'),
    session: value(args, '--session'),
    limit,
    concurrency,
    cursor: value(args, '--cursor'),
    harnessRoot: value(args, '--harness-root'),
    model: value(args, '--model'),
  };
}

function sessionTime(session: Session): number {
  const value = session.lastMessageAt ?? session.closedAt ?? session.createdAt;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface LogisticsSendMarker {
  messageId?: string;
  sentAtMs?: number;
  previewText?: string;
  contentLength?: number;
}

function latestSendMarker(dataDir: string, sessionId: string): LogisticsSendMarker {
  const path = join(dataDir, 'turn-sends', `${sessionId}.jsonl`);
  if (!existsSync(path)) return {};
  let latest: LogisticsSendMarker = {};
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        latest = {
          ...(typeof parsed.messageId === 'string' ? { messageId: parsed.messageId } : {}),
          ...(typeof parsed.sentAtMs === 'number' ? { sentAtMs: parsed.sentAtMs } : {}),
          ...(typeof parsed.previewText === 'string' ? { previewText: parsed.previewText } : {}),
          ...(typeof parsed.contentLength === 'number' ? { contentLength: parsed.contentLength } : {}),
        };
      } catch { /* malformed historical row */ }
    }
  } catch { /* best effort */ }
  return latest;
}

function selectBot(configs: BotConfig[], appId: string | undefined): BotConfig {
  if (appId) {
    const found = configs.find(config => config.larkAppId === appId);
    if (!found) usage(`Bot not found: ${appId}`);
    return found;
  }
  const enabled = configs.filter(config => config.logisticsSessionMaster?.enabled === true);
  if (enabled.length === 1) return enabled[0]!;
  if (configs.length === 1) return configs[0]!;
  usage('Multiple bots found; pass --bot <appId>');
}

interface LogisticsBackfillCursor {
  v: 1;
  at: number;
  sessionId: string;
  filter: string;
}

interface LogisticsLabelCursor {
  v: 1;
  masterKey: string;
  filter: string;
}

function filterFingerprint(options: BackfillOptions): string {
  return JSON.stringify({
    bot: options.bot ?? '', session: options.session ?? '',
    since: options.since ?? null, until: options.until ?? null,
  });
}

function decodeCursor(raw: string | undefined, options: BackfillOptions): LogisticsBackfillCursor | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as LogisticsBackfillCursor;
    if (parsed.v !== 1 || !Number.isFinite(parsed.at) || typeof parsed.sessionId !== 'string') throw new Error('shape');
    if (parsed.filter !== filterFingerprint(options)) throw new Error('filter');
    return parsed;
  } catch {
    throw new Error('invalid_backfill_cursor');
  }
}

function encodeCursor(session: Session, options: BackfillOptions): string {
  const payload: LogisticsBackfillCursor = {
    v: 1, at: sessionTime(session), sessionId: session.sessionId, filter: filterFingerprint(options),
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function labelFilterFingerprint(options: LabelOptions, harnessRevision: string): string {
  return JSON.stringify({
    bot: options.bot ?? '',
    session: options.session ?? '',
    force: options.force,
    harnessRevision,
  });
}

function decodeLabelCursor(
  raw: string | undefined,
  options: LabelOptions,
  harnessRevision: string,
): LogisticsLabelCursor | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as LogisticsLabelCursor;
    if (parsed.v !== 1 || typeof parsed.masterKey !== 'string') throw new Error('shape');
    if (parsed.filter !== labelFilterFingerprint(options, harnessRevision)) throw new Error('filter');
    return parsed;
  } catch {
    throw new Error('invalid_label_cursor');
  }
}

function encodeLabelCursor(
  masterKey: string,
  options: LabelOptions,
  harnessRevision: string,
): string {
  const payload: LogisticsLabelCursor = {
    v: 1,
    masterKey,
    filter: labelFilterFingerprint(options, harnessRevision),
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export interface LogisticsLabelCandidate {
  record: LogisticsSessionMasterRecord;
  attempt: number;
  truncated: boolean;
}

export function paginateLogisticsLabelCandidates(
  candidates: LogisticsLabelCandidate[],
  options: LabelOptions,
  harnessRevision: string,
): {
  candidates: LogisticsLabelCandidate[];
  totalCandidates: number;
  hasMore: boolean;
  nextCursor?: string;
} {
  const cursor = decodeLabelCursor(options.cursor, options, harnessRevision);
  const sorted = [...candidates].sort((left, right) => left.record.masterKey.localeCompare(right.record.masterKey));
  const remaining = cursor
    ? sorted.filter(candidate => candidate.record.masterKey.localeCompare(cursor.masterKey) > 0)
    : sorted;
  const page = remaining.slice(0, options.limit);
  const hasMore = remaining.length > page.length;
  return {
    candidates: page,
    totalCandidates: sorted.length,
    hasMore,
    ...(hasMore && page.length
      ? { nextCursor: encodeLabelCursor(page.at(-1)!.record.masterKey, options, harnessRevision) }
      : {}),
  };
}

export function paginateLogisticsBackfillSessions(
  input: Iterable<Session>,
  options: BackfillOptions,
): { sessions: Session[]; totalCandidates: number; nextCursor?: string; hasMore: boolean } {
  const cursor = decodeCursor(options.cursor, options);
  const eligible = [...input]
    .filter(session => !options.bot || session.larkAppId === options.bot)
    .filter(session => !options.session || session.sessionId.startsWith(options.session))
    .filter(session => !session.vcMeetingReceiver && !session.deferredScheduleRun)
    .filter(session => {
      const at = sessionTime(session);
      return (options.since === undefined || at >= options.since)
        && (options.until === undefined || at < options.until);
    })
    .sort((a, b) => sessionTime(b) - sessionTime(a) || b.sessionId.localeCompare(a.sessionId));
  const remaining = cursor
    ? eligible.filter(session => sessionTime(session) < cursor.at
      || (sessionTime(session) === cursor.at && session.sessionId.localeCompare(cursor.sessionId) < 0))
    : eligible;
  const sessions = remaining.slice(0, options.limit);
  const hasMore = remaining.length > sessions.length;
  return {
    sessions,
    totalCandidates: eligible.length,
    hasMore,
    ...(hasMore && sessions.length ? { nextCursor: encodeCursor(sessions.at(-1)!, options) } : {}),
  };
}

export function logisticsSessionCatalogInput(session: Session): LogisticsSessionCatalogInput | undefined {
  if (!session.larkAppId) return undefined;
  const createdAt = Date.parse(session.createdAt);
  if (!Number.isFinite(createdAt)) return undefined;
  const lastMessageAt = session.lastMessageAt ? Date.parse(session.lastMessageAt) : undefined;
  const closedAt = session.closedAt ? Date.parse(session.closedAt) : undefined;
  const specialSession = Boolean(session.vcMeetingReceiver || session.deferredScheduleRun);
  return {
    larkAppId: session.larkAppId,
    sessionId: session.sessionId,
    chatId: session.chatId,
    rootMessageId: session.rootMessageId,
    scope: session.scope === 'chat' ? 'chat' : 'thread',
    sessionStatus: session.status,
    title: session.title,
    createdAt,
    ...(Number.isFinite(lastMessageAt) ? { lastMessageAt } : {}),
    ...(Number.isFinite(closedAt) ? { closedAt } : {}),
    specialSession,
    ...(specialSession ? { backfillStatus: 'skipped' as const } : {}),
  };
}


export function mergeLogisticsAnswerPreview(
  messages: ReadonlyArray<{ messageId: string; senderType?: string; content: string; createTime?: string }>,
  answerMessageId: string | undefined,
  marker: LogisticsSendMarker,
): Array<{ messageId: string; senderType?: string; content: string; createTime?: string }> {
  const preview = marker.previewText?.trim();
  if (!answerMessageId || marker.messageId !== answerMessageId || !preview || preview === 'BOTMUX_NOTHING_TO_SEND') {
    return [...messages];
  }
  const index = messages.findIndex(message => message.messageId === answerMessageId);
  if (index < 0) {
    return [
      ...messages,
      {
        messageId: answerMessageId,
        senderType: 'app',
        content: preview,
        ...(marker.sentAtMs ? { createTime: String(marker.sentAtMs) } : {}),
      },
    ].sort((left, right) => {
      const leftAt = historyMessageTime(left) ?? Number.MAX_SAFE_INTEGER;
      const rightAt = historyMessageTime(right) ?? Number.MAX_SAFE_INTEGER;
      return leftAt - rightAt;
    });
  }
  const current = messages[index]!.content.trim();
  const nonTerminal = /\[卡片:|工作中|等待输入|显示输出|打开(?:可操作 )?Web 终端|Ask Codex|BOTMUX_NOTHING_TO_SEND/i.test(current);
  const previewIsRicher = preview.length >= Math.max(20, current.length * 1.2)
    || (marker.contentLength !== undefined && marker.contentLength > current.length);
  if (!nonTerminal && !previewIsRicher) return [...messages];
  return messages.map((message, messageIndex) => messageIndex === index
    ? { ...message, senderType: 'app', content: preview }
    : { ...message });
}

type LogisticsHistoryMessage = {
  messageId: string;
  senderType?: string;
  content: string;
  createTime?: string;
};

const CHAT_BACKFILL_PADDING_MS = 120_000;
const CHAT_BACKFILL_MAX_MESSAGES = 5_000;

function historyMessageTime(message: { createTime?: string }): number | undefined {
  const parsed = Number(message.createTime);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function logisticsBackfillErrorReason(error: unknown): string {
  const candidate = error as {
    message?: unknown;
    response?: { data?: { code?: unknown; msg?: unknown } };
  };
  const code = candidate?.response?.data?.code;
  const message = candidate?.response?.data?.msg;
  if ((typeof code === 'number' || typeof code === 'string') && typeof message === 'string') {
    return `lark_${code}:${message}`.slice(0, 300);
  }
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

async function fetchLogisticsSessionHistory(
  session: Session,
  larkAppId: string,
): Promise<{ messages: LogisticsHistoryMessage[]; complete: boolean }> {
  if (session.scope !== 'chat') {
    const raw = await listThreadMessages(larkAppId, session.chatId, session.rootMessageId, 0);
    return {
      messages: raw.map(item => {
        const parsed = parseApiMessage(item);
        return {
          messageId: parsed.messageId,
          senderType: parsed.senderType,
          content: parsed.content,
          createTime: parsed.createTime,
        };
      }),
      complete: true,
    };
  }

  const sessionStartedAt = Date.parse(session.createdAt);
  if (!Number.isFinite(sessionStartedAt)) throw new Error('invalid_session_created_at');
  let stoppedAtLimit = false;
  const raw = await listChatMessagesUntil(larkAppId, session.chatId, {
    stopAfter: (item, seenCount) => {
      const parsed = parseApiMessage(item);
      const occurredAt = historyMessageTime(parsed);
      if (occurredAt !== undefined && occurredAt < sessionStartedAt - CHAT_BACKFILL_PADDING_MS) {
        return true;
      }
      if (seenCount >= CHAT_BACKFILL_MAX_MESSAGES) {
        stoppedAtLimit = true;
        return true;
      }
      return false;
    },
  });
  const sessionEndedAt = sessionTime(session);
  const messages = raw.map(item => {
    const parsed = parseApiMessage(item);
    return {
      messageId: parsed.messageId,
      senderType: parsed.senderType,
      content: parsed.content,
      createTime: parsed.createTime,
    };
  }).filter(message => {
    const occurredAt = historyMessageTime(message);
    return occurredAt === undefined
      || (occurredAt >= sessionStartedAt - CHAT_BACKFILL_PADDING_MS
        && occurredAt <= sessionEndedAt + CHAT_BACKFILL_PADDING_MS);
  });
  return { messages, complete: !stoppedAtLimit };
}

export function buildLogisticsCapturedMessages(input: {
  larkAppId: string;
  sessionId: string;
  messages: ReadonlyArray<LogisticsHistoryMessage>;
  finalAnswerMessageId?: string;
  markerHydratedMessageId?: string;
}): LogisticsCapturedMessageInput[] {
  let latestUserMessageId: string | undefined;
  return input.messages.flatMap(message => {
    const role = message.senderType === 'user'
      ? 'user'
      : message.senderType === 'app'
        ? 'assistant'
        : undefined;
    const content = sanitizeLogisticsMessageText(message.content);
    if (!role || !content) return [];
    if (role === 'user') latestUserMessageId = message.messageId;
    const occurredAt = historyMessageTime(message);
    return [{
      larkAppId: input.larkAppId,
      sessionId: input.sessionId,
      role,
      content,
      ...(message.messageId ? { platformMessageId: message.messageId } : {}),
      ...(occurredAt !== undefined ? { occurredAt } : {}),
      ...(role === 'user' && message.messageId ? { turnId: message.messageId } : {}),
      ...(role === 'assistant' && latestUserMessageId
        ? { turnId: latestUserMessageId, triggerMessageId: latestUserMessageId }
        : {}),
      ...(message.messageId === input.finalAnswerMessageId
        ? { responseKind: 'final' as const }
        : {}),
      source: message.messageId === input.markerHydratedMessageId
        ? 'botmux_send_marker' as const
        : 'lark_history' as const,
    }];
  });
}

export function inferLogisticsBackfillBoundaries(
  messages: ReadonlyArray<{ messageId: string; senderType?: string; content: string }>,
  preferredTurnId?: string,
  preferredAnswerId?: string,
): { turnId?: string; answerMessageId?: string } {
  const byId = new Map(messages.map((message, index) => [message.messageId, { message, index }] as const));
  let answerIndex = preferredAnswerId ? byId.get(preferredAnswerId)?.index : undefined;
  if (answerIndex === undefined) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.senderType !== 'app') continue;
      if (!message.content.trim()) continue;
      if (/这次回答对你的帮助有多大|很不满意|非常满意|\[卡片:|工作中|等待输入|显示输出|打开(?:可操作 )?Web 终端|Ask Codex|BOTMUX_NOTHING_TO_SEND/i.test(message.content)) {
        continue;
      }
      answerIndex = index;
      break;
    }
  }
  const answerMessageId = answerIndex === undefined ? undefined : messages[answerIndex]?.messageId;
  let turnIndex = preferredTurnId ? byId.get(preferredTurnId)?.index : undefined;
  if (turnIndex === undefined || (answerIndex !== undefined && turnIndex > answerIndex)) {
    const before = answerIndex ?? messages.length;
    for (let index = before - 1; index >= 0; index -= 1) {
      if (messages[index]?.senderType === 'user') {
        turnIndex = index;
        break;
      }
    }
  }
  const turnId = turnIndex === undefined ? undefined : messages[turnIndex]?.messageId;
  return { turnId, answerMessageId };
}

async function backfill(dataDir: string, args: string[]): Promise<void> {
  const options = parseBackfill(args);
  const allSessions = [...loadAllSessionsSnapshot({ dataDir }).values()];
  const page = paginateLogisticsBackfillSessions(allSessions, options);
  const { sessions } = page;
  const audit = sessions.map(session => {
    const marker = latestSendMarker(dataDir, session.sessionId);
    return {
      session: session.sessionId.slice(0, 12),
      bot: session.larkAppId ?? null,
      scope: session.scope ?? 'thread',
      hasTurn: !!session.quoteTargetId || session.rootMessageId.startsWith('om_'),
      hasAnswer: !!marker.messageId,
      at: sessionTime(session),
    };
  });
  if (!options.apply) {
    console.log(JSON.stringify({
      mode: 'dry-run', candidateCount: audit.length, totalCandidates: page.totalCandidates,
      hasMore: page.hasMore, nextCursor: page.nextCursor ?? null, candidates: audit,
    }, null, 2));
    return;
  }

  if (sessions.length === 0) {
    console.log(JSON.stringify({
      mode: 'apply', candidates: 0, totalCandidates: page.totalCandidates,
      hasMore: page.hasMore, nextCursor: page.nextCursor ?? null,
      captured: 0, messages: { total: 0, inserted: 0, updated: 0 },
      statuses: {}, failed: 0, failures: [],
    }, null, 2));
    return;
  }
  const configs = loadBotConfigs();
  const sessionApps = [...new Set(sessions.map(session => session.larkAppId).filter((value): value is string => !!value))];
  const bot = selectBot(configs, options.bot ?? (sessionApps.length === 1 ? sessionApps[0] : undefined));
  registerBot(bot);
  const store = new LogisticsConversationStore({ dataDir, path: bot.logisticsSessionMaster?.sqlite?.path });
  store.syncSessionCatalog(allSessions
    .filter(session => session.larkAppId === bot.larkAppId)
    .map(logisticsSessionCatalogInput)
    .filter((row): row is LogisticsSessionCatalogInput => !!row));
  const result = {
    mode: 'apply',
    candidates: sessions.length,
    totalCandidates: page.totalCandidates,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor ?? null,
    captured: 0,
    messages: { total: 0, inserted: 0, updated: 0 },
    statuses: {} as Record<string, number>,
    failed: 0,
    failures: [] as Array<{ session: string; reason: string }>,
  };
  const countStatus = (status: string) => {
    result.statuses[status] = (result.statuses[status] ?? 0) + 1;
  };
  try {
    for (const session of sessions) {
      if (session.larkAppId !== bot.larkAppId) {
        countStatus('skipped');
        if (session.larkAppId) store.markSessionBackfill(session.larkAppId, session.sessionId, 'skipped', 'different_bot');
        continue;
      }
      const marker = latestSendMarker(dataDir, session.sessionId);
      store.markSessionBackfill(bot.larkAppId, session.sessionId, 'processing');
      try {
        const history = await fetchLogisticsSessionHistory(session, bot.larkAppId);
        const hydratedMessages = mergeLogisticsAnswerPreview(
          history.messages,
          marker.messageId,
          marker,
        );
        const boundary = inferLogisticsBackfillBoundaries(
          hydratedMessages,
          session.quoteTargetId ?? (session.rootMessageId.startsWith('om_') ? session.rootMessageId : undefined),
          marker.messageId,
        );
        const capturedMessages = buildLogisticsCapturedMessages({
          larkAppId: bot.larkAppId,
          sessionId: session.sessionId,
          messages: hydratedMessages,
          finalAnswerMessageId: boundary.answerMessageId,
          ...(marker.messageId && marker.previewText?.trim()
            ? { markerHydratedMessageId: marker.messageId }
            : {}),
        });
        const write = store.upsertCapturedMessages(capturedMessages);
        result.messages.total += write.total;
        result.messages.inserted += write.inserted;
        result.messages.updated += write.updated;
        if (!history.complete) {
          const reason = `chat_history_limit:${CHAT_BACKFILL_MAX_MESSAGES}`;
          store.markSessionBackfill(bot.larkAppId, session.sessionId, 'history_failed', reason);
          countStatus('history_failed');
          result.failed += 1;
          if (result.failures.length < 20) result.failures.push({
            session: session.sessionId.slice(0, 12),
            reason,
          });
          continue;
        }
        if (!boundary.turnId) {
          store.markSessionBackfill(bot.larkAppId, session.sessionId, 'missing_turn');
          countStatus('missing_turn');
          continue;
        }
        if (!boundary.answerMessageId) {
          store.markSessionBackfill(bot.larkAppId, session.sessionId, 'missing_answer');
          countStatus('missing_answer');
          continue;
        }
        const snapshot = buildLogisticsSessionSnapshot({
          turnId: boundary.turnId,
          answerMessageId: boundary.answerMessageId,
          rootMessageId: session.scope === 'chat' ? null : session.rootMessageId,
          sessionStartedAt: session.createdAt,
          maxTranscriptChars: bot.logisticsSessionMaster?.maxTranscriptChars,
          messages: hydratedMessages,
        });
        const now = Date.now();
        const masterKey = stableLogisticsSessionMasterKey(bot.larkAppId, session.sessionId, boundary.turnId, session.chatId);
        const record: LogisticsSessionMasterRecord = {
          masterKey,
          larkAppId: bot.larkAppId,
          sessionId: session.sessionId,
          turnId: boundary.turnId,
          surveyId: `turn_${boundary.turnId}`,
          settledSurveyIds: [],
          ratingCount: 0,
          chatId: session.chatId,
          rootMessageId: session.scope === 'chat' ? null : session.rootMessageId,
          respondentOpenId: '',
          title: session.title,
          answerMessageId: boundary.answerMessageId,
          surveyStatus: 'scheduled',
          dueAt: marker.sentAtMs ?? now,
          ratingState: 'awaiting',
          transcript: snapshot.transcript,
          transcriptHash: snapshot.transcriptHash,
          captureState: snapshot.captureState,
          messages: snapshot.messages,
          taggingState: 'needs_review',
          needsReview: snapshot.captureState === 'partial',
          reviewReason: snapshot.reviewReason,
          manualReviewStatus: 'pending',
          modelAttempts: 0,
          baseSyncAttempts: 0,
          createdAt: Date.parse(session.createdAt) || now,
          updatedAt: marker.sentAtMs ?? (sessionTime(session) || now),
        };
        store.upsertCapture(record, capturedMessages.length);
        result.captured += 1;
        countStatus('captured');
      } catch (error) {
        const reason = logisticsBackfillErrorReason(error);
        store.markSessionBackfill(bot.larkAppId, session.sessionId, 'history_failed', reason);
        countStatus('history_failed');
        result.failed += 1;
        if (result.failures.length < 20) result.failures.push({
          session: session.sessionId.slice(0, 12),
          reason,
        });
      }
    }
  } finally {
    store.close();
  }
  console.log(JSON.stringify(result, null, 2));
}

async function label(dataDir: string, args: string[]): Promise<void> {
  const options = parseLabel(args);
  const configs = loadBotConfigs();
  const bot = selectBot(configs, options.bot);
  registerBot(bot);
  const harnessRoot = options.harnessRoot
    ?? bot.logisticsSessionMaster?.harness?.rootDir
    ?? process.env.LOGISTICS_CONVERSATION_HARNESS_ROOT;
  if (!harnessRoot) throw new Error('logistics_label_harness_root_required');
  const harnessRevision = resolveLogisticsHarnessRevision(harnessRoot);
  const model = options.model
    ?? bot.logisticsSessionMaster?.modelTask?.model
    ?? bot.model;
  const store = new LogisticsConversationStore({
    dataDir,
    path: bot.logisticsSessionMaster?.sqlite?.path,
  });
  try {
    const records = store.listLabelingRecords({
      larkAppId: bot.larkAppId,
      sessionPrefix: options.session,
    });
    const skippedCompleted = { count: 0 };
    const ineligibleNoUser = { count: 0 };
    const eligible = records.flatMap(record => {
      const prepared = prepareLogisticsHarnessRecord(record);
      if (!isLogisticsHarnessRecordAnalyzable(prepared.record)) {
        ineligibleNoUser.count += 1;
        return [];
      }
      const state = store.labelRunState(
        prepared.record.masterKey,
        prepared.record.transcriptHash!,
        harnessRevision,
      );
      if (state.completed && !options.force) {
        skippedCompleted.count += 1;
        return [];
      }
      return [{
        record: prepared.record,
        attempt: state.nextAttempt,
        truncated: prepared.truncated,
      }];
    });
    const page = paginateLogisticsLabelCandidates(eligible, options, harnessRevision);
    if (!options.apply) {
      console.log(JSON.stringify({
        mode: 'dry-run',
        harnessRevision,
        model: model ?? null,
        totalCaptured: records.length,
        totalEligible: records.length - ineligibleNoUser.count,
        totalCandidates: page.totalCandidates,
        skippedCompleted: skippedCompleted.count,
        ineligibleNoUser: ineligibleNoUser.count,
        candidateCount: page.candidates.length,
        partialInputs: page.candidates.filter(candidate => candidate.record.captureState === 'partial').length,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor ?? null,
        candidates: page.candidates.map(candidate => ({
          session: candidate.record.sessionId.slice(0, 12),
          messages: candidate.record.messages?.length ?? 0,
          captureState: candidate.record.captureState,
          attempt: candidate.attempt,
        })),
      }, null, 2));
      return;
    }

    const runner = createLogisticsSessionModelTaskRunner({
      cliId: bot.cliId,
      cliPathOverride: bot.cliPathOverride,
      wrapperCli: bot.wrapperCli,
      model,
      env: bot.env,
      timeoutMs: bot.logisticsSessionMaster?.modelTask?.timeoutMs,
      harnessRoot,
    });
    const result = {
      mode: 'apply',
      harnessRevision,
      model: model ?? null,
      totalCaptured: records.length,
      totalEligible: records.length - ineligibleNoUser.count,
      candidates: page.candidates.length,
      totalCandidates: page.totalCandidates,
      skippedCompleted: skippedCompleted.count,
      ineligibleNoUser: ineligibleNoUser.count,
      partialInputs: page.candidates.filter(candidate => candidate.record.captureState === 'partial').length,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor ?? null,
      labeled: 0,
      failed: 0,
      distributions: {
        business: {} as Record<string, number>,
        problem: {} as Record<string, number>,
        resolution: {} as Record<string, number>,
        review: {} as Record<string, number>,
      },
      failures: [] as Array<{ session: string; reason: string }>,
    };
    let nextIndex = 0;
    let finished = 0;
    const worker = async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        const candidate = page.candidates[index];
        if (!candidate) return;
        const startedAt = Date.now();
        store.recordLabelRun({
          masterKey: candidate.record.masterKey,
          transcriptHash: candidate.record.transcriptHash!,
          harnessRevision,
          status: 'running',
          model,
          attempt: candidate.attempt,
          createdAt: startedAt,
        });
        try {
          const tagging = await runner({ record: candidate.record });
          if (tagging.harnessRevision !== harnessRevision) {
            throw new Error(`harness_revision_mismatch:${tagging.harnessRevision ?? 'missing'}`);
          }
          const completedAt = Date.now();
          store.completeLabeling({
            record: candidate.record,
            tagging,
            harnessRevision,
            attempt: candidate.attempt,
            model,
            startedAt,
            completedAt,
          });
          result.labeled += 1;
          result.distributions.business[tagging.businessCategory]
            = (result.distributions.business[tagging.businessCategory] ?? 0) + 1;
          result.distributions.problem[tagging.problemType]
            = (result.distributions.problem[tagging.problemType] ?? 0) + 1;
          result.distributions.resolution[tagging.resolutionStatus]
            = (result.distributions.resolution[tagging.resolutionStatus] ?? 0) + 1;
          const review = tagging.needsReview ? 'needs_review' : 'auto_labeled';
          result.distributions.review[review] = (result.distributions.review[review] ?? 0) + 1;
        } catch (error) {
          const reason = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
          store.failLabeling({
            masterKey: candidate.record.masterKey,
            transcriptHash: candidate.record.transcriptHash!,
            harnessRevision,
            attempt: candidate.attempt,
            model,
            error: reason,
            startedAt,
            completedAt: Date.now(),
          });
          result.failed += 1;
          if (result.failures.length < 50) result.failures.push({
            session: candidate.record.sessionId.slice(0, 12),
            reason,
          });
        } finally {
          finished += 1;
          if (finished === page.candidates.length || finished % 10 === 0 || result.failed > 0) {
            console.error(`[logistics label] ${finished}/${page.candidates.length} labeled=${result.labeled} failed=${result.failed}`);
          }
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(options.concurrency, Math.max(1, page.candidates.length)) },
        () => worker(),
      ),
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    store.close();
  }
}

function syncCatalog(dataDir: string, args: string[]): void {
  const bot = value(args, '--bot');
  const unknown = args.filter((arg, index) => arg !== '--bot' && args[index - 1] !== '--bot' && !arg.startsWith('--bot='));
  if (unknown.length) usage(`Unknown option: ${unknown[0]}`);
  const rows = [...loadAllSessionsSnapshot({ dataDir }).values()]
    .filter(session => !bot || session.larkAppId === bot)
    .map(logisticsSessionCatalogInput)
    .filter((row): row is LogisticsSessionCatalogInput => !!row);
  const store = new LogisticsConversationStore({ dataDir });
  try {
    const synced = store.syncSessionCatalog(rows);
    console.log(JSON.stringify({ mode: 'sync-catalog', ...synced, summary: store.summary(bot ? { larkAppId: bot } : {}) }, null, 2));
  } finally {
    store.close();
  }
}

function importSurveys(dataDir: string, args: string[]): void {
  const bot = value(args, '--bot');
  const unknown = args.filter((arg, index) => arg !== '--bot' && args[index - 1] !== '--bot' && !arg.startsWith('--bot='));
  if (unknown.length) usage(`Unknown option: ${unknown[0]}`);
  const store = new LogisticsConversationStore({ dataDir });
  try { console.log(JSON.stringify(store.importFeedbackSurveyJson(dataDir, bot), null, 2)); }
  finally { store.close(); }
}

function importLegacy(dataDir: string, args: string[]): void {
  const bot = value(args, '--bot');
  const unknown = args.filter((arg, index) => arg !== '--bot' && args[index - 1] !== '--bot' && !arg.startsWith('--bot='));
  if (unknown.length) usage(`Unknown option: ${unknown[0]}`);
  const store = new LogisticsConversationStore({ dataDir });
  try { console.log(JSON.stringify(store.importLegacyJson(dataDir, bot), null, 2)); }
  finally { store.close(); }
}

export async function runLogisticsConversationCommand(sub: string, args: string[], dataDir: string): Promise<void> {
  if (sub === 'sync-catalog') return syncCatalog(dataDir, args);
  if (sub === 'backfill') return backfill(dataDir, args);
  if (sub === 'label') return label(dataDir, args);
  if (sub === 'import-legacy') return importLegacy(dataDir, args);
  if (sub === 'import-surveys') return importSurveys(dataDir, args);
  usage();
}
