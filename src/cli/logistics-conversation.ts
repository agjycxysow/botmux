import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadBotConfigs, registerBot, type BotConfig } from '../bot-registry.js';
import { listChatMessages, listThreadMessages } from '../im/lark/client.js';
import { parseApiMessage } from '../im/lark/message-parser.js';
import { buildLogisticsSessionSnapshot } from '../services/logistics-session-capture.js';
import {
  LogisticsConversationStore,
  type LogisticsSessionCatalogInput,
} from '../services/logistics-conversation-store.js';
import {
  stableLogisticsSessionMasterKey,
  type LogisticsSessionMasterRecord,
} from '../services/logistics-session-master.js';
import { createLogisticsSessionModelTaskRunner } from '../services/logistics-session-model-task.js';
import { loadAllSessionsSnapshot } from '../services/session-store.js';
import type { Session } from '../types.js';

interface BackfillOptions {
  apply: boolean;
  bot?: string;
  session?: string;
  since?: number;
  until?: number;
  limit: number;
  harnessRoot?: string;
  noLabel: boolean;
  cursor?: string;
}

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(`Usage:
  botmux logistics sync-catalog [--bot <appId>]
  botmux logistics backfill [--bot <appId>] [--session <id-prefix>] [--since <ISO|YYYY-MM-DD>] [--until <ISO|YYYY-MM-DD>] [--limit N] [--cursor <opaque>] [--harness-root <dir>] [--no-label] [--apply]
  botmux logistics import-legacy [--bot <appId>]

backfill defaults to dry-run. It reads bounded BotMux session metadata; --apply fetches
visible Lark history, runs the configured logistics labeler, and writes SQLite.`);
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
  const knownWithValue = new Set(['--bot', '--session', '--since', '--until', '--limit', '--cursor', '--harness-root']);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--apply' || arg === '--no-label') continue;
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
    harnessRoot: value(args, '--harness-root'),
    noLabel: args.includes('--no-label'),
    cursor: value(args, '--cursor'),
  };
}

function sessionTime(session: Session): number {
  const value = session.lastMessageAt ?? session.closedAt ?? session.createdAt;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestSendMarker(dataDir: string, sessionId: string): { messageId?: string; sentAtMs?: number } {
  const path = join(dataDir, 'turn-sends', `${sessionId}.jsonl`);
  if (!existsSync(path)) return {};
  let latest: { messageId?: string; sentAtMs?: number } = {};
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed.messageId === 'string') latest.messageId = parsed.messageId;
        if (typeof parsed.sentAtMs === 'number') latest.sentAtMs = parsed.sentAtMs;
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
      if (/这次回答对你的帮助有多大|很不满意|非常满意/.test(message.content)) continue;
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
      imported: 0, skipped: {}, failed: 0, failures: [],
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
  const runner = options.noLabel ? undefined : createLogisticsSessionModelTaskRunner({
    cliId: bot.cliId,
    cliPathOverride: bot.cliPathOverride,
    wrapperCli: bot.wrapperCli,
    model: bot.logisticsSessionMaster?.modelTask?.model ?? bot.model,
    env: bot.env,
    timeoutMs: bot.logisticsSessionMaster?.modelTask?.timeoutMs,
    harnessRoot: options.harnessRoot ?? bot.logisticsSessionMaster?.harness?.rootDir,
  });
  const result = {
    mode: 'apply',
    candidates: sessions.length,
    totalCandidates: page.totalCandidates,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor ?? null,
    imported: 0,
    skipped: {} as Record<string, number>,
    failed: 0,
    failures: [] as Array<{ session: string; reason: string }>,
  };
  const skip = (reason: string) => { result.skipped[reason] = (result.skipped[reason] ?? 0) + 1; };
  try {
    for (const session of sessions) {
      if (session.larkAppId !== bot.larkAppId) {
        skip('different_bot');
        if (session.larkAppId) store.markSessionBackfill(session.larkAppId, session.sessionId, 'skipped', 'different_bot');
        continue;
      }
      const marker = latestSendMarker(dataDir, session.sessionId);
      store.markSessionBackfill(bot.larkAppId, session.sessionId, 'processing');
      try {
        const raw = session.scope === 'chat'
          ? await listChatMessages(bot.larkAppId, session.chatId, 200)
          : await listThreadMessages(bot.larkAppId, session.chatId, session.rootMessageId, 0);
        const parsedMessages = raw.map(item => {
          const parsed = parseApiMessage(item);
          return {
            messageId: parsed.messageId,
            senderType: parsed.senderType,
            content: parsed.content,
            createTime: parsed.createTime,
          };
        });
        const boundary = inferLogisticsBackfillBoundaries(
          parsedMessages,
          session.quoteTargetId ?? (session.rootMessageId.startsWith('om_') ? session.rootMessageId : undefined),
          marker.messageId,
        );
        if (!boundary.turnId) {
          skip('missing_turn');
          store.markSessionBackfill(bot.larkAppId, session.sessionId, 'missing_turn');
          continue;
        }
        if (!boundary.answerMessageId) {
          skip('missing_answer');
          store.markSessionBackfill(bot.larkAppId, session.sessionId, 'missing_answer');
          continue;
        }
        const snapshot = buildLogisticsSessionSnapshot({
          turnId: boundary.turnId,
          answerMessageId: boundary.answerMessageId,
          rootMessageId: session.scope === 'chat' ? null : session.rootMessageId,
          sessionStartedAt: session.createdAt,
          maxTranscriptChars: bot.logisticsSessionMaster?.maxTranscriptChars,
          messages: parsedMessages,
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
          taggingState: runner ? 'tagging' : 'needs_review',
          needsReview: snapshot.captureState === 'partial' || !runner,
          reviewReason: snapshot.reviewReason ?? (!runner ? '历史回溯跳过自动打标' : undefined),
          manualReviewStatus: 'pending',
          modelAttempts: runner ? 1 : 0,
          baseSyncAttempts: 0,
          createdAt: Date.parse(session.createdAt) || now,
          updatedAt: marker.sentAtMs ?? (sessionTime(session) || now),
        };
        store.markSessionBackfill(bot.larkAppId, session.sessionId, 'snapshot_ready');
        if (runner) {
          try {
            const tagging = await runner({ record });
            Object.assign(record, {
              businessCategory: tagging.businessCategory,
              problemType: tagging.problemType,
              resolutionStatus: tagging.resolutionStatus,
              overallConfidence: tagging.overallConfidence,
              needsReview: record.needsReview || tagging.needsReview,
              reviewReason: [record.reviewReason, tagging.reviewReason].filter(Boolean).join('；') || undefined,
              harnessRevision: tagging.harnessRevision,
              businessReasonCode: tagging.businessReasonCode,
              problemReasonCode: tagging.problemReasonCode,
              resolutionReasonCode: tagging.resolutionReasonCode,
              evidenceAnchors: tagging.evidenceAnchors,
              taggingState: tagging.needsReview ? 'needs_review' : 'tagged',
            });
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            record.taggingState = 'needs_review';
            record.needsReview = true;
            record.modelError = reason.slice(0, 500);
            record.reviewReason = [record.reviewReason, `历史打标失败：${reason.slice(0, 200)}`]
              .filter(Boolean).join('；');
          }
        }
        store.upsert(record);
        result.imported += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
        store.markSessionBackfill(bot.larkAppId, session.sessionId, 'history_failed', reason);
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
  if (sub === 'import-legacy') return importLegacy(dataDir, args);
  usage();
}
