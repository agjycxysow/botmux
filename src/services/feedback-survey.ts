import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';

const DEFAULT_IDLE_DELAY_MS = 10 * 60_000;
const DEFAULT_ASK_TTL_MS = 24 * 60 * 60_000;

export interface FeedbackSurveyRecipient {
  openId: string;
  idleDelayMs: number;
}

export interface FeedbackSurveyConfig {
  enabled?: boolean;
  /**
   * Authoritative survey gray-list and delay rules. When present, this replaces
   * the legacy `grayOpenIds` + shared `idleDelayMs` configuration.
   */
  recipients?: ReadonlyArray<FeedbackSurveyRecipient>;
  /** Optional fallback delay for user responders without an explicit recipient rule. */
  defaultIdleDelayMs?: number;
  /** Legacy shared delay used only when `recipients` is absent. */
  idleDelayMs?: number;
  askTtlMs?: number;
  /** Legacy allowlist. Prefer `recipients` for new configuration. */
  grayOpenIds?: ReadonlyArray<string>;
  larkBase?: {
    appToken: string;
    tableId: string;
    identity?: 'user' | 'bot';
  };
}

export interface NormalizedFeedbackSurveyConfig {
  enabled: boolean;
  idleDelayMs: number;
  askTtlMs: number;
  recipients: FeedbackSurveyRecipient[];
  defaultIdleDelayMs?: number;
  /** Derived from recipients for backward-compatible observability consumers. */
  grayOpenIds: string[];
  larkBase?: {
    appToken: string;
    tableId: string;
    identity: 'user' | 'bot';
  };
}

export type FeedbackSurveyStatus =
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'answered'
  | 'timed_out'
  | 'invalidated'
  | 'cancelled'
  | 'failed';

export interface FeedbackSurveyRecord {
  surveyId: string;
  larkAppId: string;
  sessionId: string;
  turnId: string;
  chatId: string;
  rootMessageId: string | null;
  chatType?: 'group' | 'p2p';
  respondentOpenId: string;
  title?: string;
  cliId?: string;
  recap?: string;
  answerMessageId?: string;
  askId?: string;
  cardMessageId?: string;
  rootMessageLink?: string;
  cardMessageLink?: string;
  baseRecordId?: string;
  baseSyncError?: string;
  status: FeedbackSurveyStatus;
  scheduledAt: number;
  dueAt: number;
  sentAt?: number;
  rating?: number;
  answeredAt?: number;
  failureReason?: string;
  updatedAt: number;
}

export interface FeedbackSurveyAskInput {
  larkAppId: string;
  chatId: string;
  rootMessageId: string | null;
  sessionId: string;
  chatType?: 'group' | 'p2p';
  timeoutMs: number;
  purpose: 'feedback_survey';
  expectedResponderOpenIds: readonly string[];
  allowCustomReply: false;
  metadata: {
    surveyId: string;
    turnId: string;
    title?: string;
    recapPrompt?: string;
    recapAnswer?: string;
  };
  questions: readonly [{
    prompt: string;
    options: readonly [
      { key: '1'; label: string },
      { key: '2'; label: string },
      { key: '3'; label: string },
      { key: '4'; label: string },
      { key: '5'; label: string },
    ];
    multiSelect: false;
  }];
  onDispatched(info: { askId: string; messageId: string }): void | Promise<void>;
  onSettled(result: FeedbackSurveyAskResult): void | Promise<void>;
}

export type FeedbackSurveyAskResult =
  | {
      kind: 'answered';
      answers: ReadonlyArray<ReadonlyArray<string>>;
      by: string;
      comment: string | null;
      timedOut: false;
    }
  | {
      kind: 'timedOut';
      selected: null;
      by: null;
      comment: null;
      timedOut: true;
    }
  | {
      kind: 'invalidated';
      reason: string;
      selected: null;
      by: null;
      comment: null;
      timedOut: false;
    };

export type FeedbackSurveyBaseUpsert = (input: {
  config: NonNullable<NormalizedFeedbackSurveyConfig['larkBase']>;
  record: FeedbackSurveyRecord;
}) => Promise<{ recordId?: string }>;

export interface FeedbackSurveyManagerOptions {
  dataDir: string;
  larkAppId: string;
  config?: FeedbackSurveyConfig;
  registerAsk(input: FeedbackSurveyAskInput): {
    askId: string;
    result: Promise<FeedbackSurveyAskResult>;
  };
  getMessage(messageId: string): Promise<{ chatId: string; content: string }>;
  upsertBase?: FeedbackSurveyBaseUpsert;
  onDispatched?: (record: FeedbackSurveyRecord) => void | Promise<void>;
  onSettled?: (record: FeedbackSurveyRecord) => void | Promise<void>;
  now?: () => number;
}

interface FeedbackSurveyStore {
  version: 1;
  records: FeedbackSurveyRecord[];
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === 'object' ? input as Record<string, unknown> : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeGrayOpenIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const openId = item.trim();
    if (!/^ou_\S+$/.test(openId)) continue;
    seen.add(openId);
  }
  return [...seen];
}

function normalizeRecipients(value: unknown): FeedbackSurveyRecipient[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const recipients: FeedbackSurveyRecipient[] = [];
  for (const item of value) {
    const raw = asRecord(item);
    const openId = typeof raw?.openId === 'string' ? raw.openId.trim() : '';
    const idleDelayMs = positiveInt(raw?.idleDelayMs);
    if (!/^ou_\S+$/.test(openId) || !idleDelayMs || seen.has(openId)) continue;
    seen.add(openId);
    recipients.push({ openId, idleDelayMs });
  }
  return recipients;
}

export function normalizeFeedbackSurveyConfig(input: unknown): NormalizedFeedbackSurveyConfig {
  const raw = asRecord(input);
  const rawBase = asRecord(raw?.larkBase);
  const appToken = typeof rawBase?.appToken === 'string' ? rawBase.appToken.trim() : '';
  const tableId = typeof rawBase?.tableId === 'string' ? rawBase.tableId.trim() : '';
  const idleDelayMs = positiveInt(raw?.idleDelayMs) ?? DEFAULT_IDLE_DELAY_MS;
  const recipients = Object.prototype.hasOwnProperty.call(raw ?? {}, 'recipients')
    ? normalizeRecipients(raw?.recipients)
    : normalizeGrayOpenIds(raw?.grayOpenIds).map(openId => ({ openId, idleDelayMs }));
  const defaultIdleDelayMs = positiveInt(raw?.defaultIdleDelayMs);
  return {
    enabled: raw?.enabled === true,
    idleDelayMs,
    askTtlMs: positiveInt(raw?.askTtlMs) ?? DEFAULT_ASK_TTL_MS,
    recipients,
    ...(defaultIdleDelayMs ? { defaultIdleDelayMs } : {}),
    grayOpenIds: recipients.map(recipient => recipient.openId),
    larkBase: appToken && tableId
      ? { appToken, tableId, identity: rawBase?.identity === 'user' ? 'user' : 'bot' }
      : undefined,
  };
}

export function sanitizeFeedbackRecap(content: string, maxUnicodeChars: number): string {
  const normalized = content
    .replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, '@成员')
    .replace(/```[\s\S]*?```/g, '[代码片段]')
    .replace(/`[^`]*`/g, '[代码片段]')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)]\((?:https?|ftp):\/\/[^)]*\)/gi, '$1')
    .replace(/(?:https?|ftp):\/\/\S+/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(normalized);
  return chars.length > maxUnicodeChars
    ? `${chars.slice(0, Math.max(0, maxUnicodeChars - 1)).join('')}…`
    : normalized;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Extract the exact visible answer produced by `botmux send` from either the
 * send or reply outbound hook. Older forwarded payloads may lack `turnId`, so
 * the authenticated IPC origin is accepted as a narrow fallback. */
export function getFeedbackSurveyOutboundDelivery(
  event: string,
  payload: Readonly<Record<string, unknown>>,
  originTurnId?: string,
): { sessionId: string; turnId: string; answerMessageId: string } | undefined {
  if (event !== 'outbound.send' && event !== 'outbound.reply') return undefined;
  if (payload.source !== 'botmux_send' || payload.feedbackEligible === false) return undefined;
  if (payload.msgType !== 'text' && payload.msgType !== 'interactive') return undefined;

  const sessionId = nonEmptyString(payload.sessionId);
  const turnId = nonEmptyString(payload.turnId)
    ?? nonEmptyString(payload.originTurnId)
    ?? nonEmptyString(originTurnId);
  const answerMessageId = nonEmptyString(
    event === 'outbound.reply' ? payload.replyId : payload.messageId,
  );
  return sessionId && turnId && answerMessageId
    ? { sessionId, turnId, answerMessageId }
    : undefined;
}

export class FeedbackSurveyManager {
  private readonly config: NormalizedFeedbackSurveyConfig;
  private readonly records = new Map<string, FeedbackSurveyRecord>();
  private readonly callers = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly baseSyncs = new Map<string, Promise<void>>();
  private started = false;

  constructor(private readonly options: FeedbackSurveyManagerOptions) {
    this.config = normalizeFeedbackSurveyConfig(options.config);
  }

  start(): void {
    if (this.started || !this.config.enabled) return;
    this.started = true;
    this.load();
    for (const record of this.records.values()) {
      if (record.status === 'scheduled') this.arm(record);
      else if (record.status === 'sent'
        || record.status === 'answered'
        || record.status === 'timed_out'
        || record.status === 'invalidated') {
        void this.recoverPostDispatchHooks(record);
      }
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.started = false;
  }

  listRecords(): FeedbackSurveyRecord[] {
    return [...this.records.values()].sort((a, b) => a.scheduledAt - b.scheduledAt);
  }

  noteUserActivity(input: { sessionId: string; turnId: string; senderOpenId: string }): void {
    if (!this.config.enabled) return;
    this.callers.set(input.turnId, input.senderOpenId);
    for (const record of this.records.values()) {
      if (record.sessionId !== input.sessionId || record.turnId === input.turnId || record.status !== 'scheduled') continue;
      this.cancel(record, 'continued_by_user');
    }
  }

  scheduleForTurn(input: {
    sessionId: string;
    turnId: string;
    chatId: string;
    rootMessageId: string | null;
    chatType?: 'group' | 'p2p';
    title?: string;
    cliId?: string;
    respondentOpenId?: string;
    answerMessageId?: string;
  }): void {
    if (!this.config.enabled) return;
    const respondentOpenId = input.respondentOpenId ?? this.callers.get(input.turnId);
    const recipient = respondentOpenId ? this.recipientFor(respondentOpenId) : undefined;
    if (!respondentOpenId || !recipient) return;

    const now = this.now();
    const surveyId = stableSurveyId(this.options.larkAppId, input.sessionId, input.turnId);
    const previous = this.records.get(surveyId);
    if (previous && previous.status !== 'scheduled') return;
    const record: FeedbackSurveyRecord = {
      surveyId,
      larkAppId: this.options.larkAppId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      chatId: input.chatId,
      rootMessageId: input.rootMessageId,
      chatType: input.chatType,
      respondentOpenId,
      title: input.title,
      cliId: input.cliId,
      answerMessageId: input.answerMessageId ?? previous?.answerMessageId,
      status: 'scheduled',
      scheduledAt: now,
      dueAt: now + recipient.idleDelayMs,
      updatedAt: now,
    };
    this.records.set(surveyId, record);
    this.persist();
    this.arm(record);
  }

  private arm(record: FeedbackSurveyRecord): void {
    if (!this.config.enabled || record.status !== 'scheduled') return;
    const current = this.timers.get(record.surveyId);
    if (current) clearTimeout(current);
    const timer = setTimeout(() => {
      this.timers.delete(record.surveyId);
      void this.dispatch(record.surveyId);
    }, Math.max(0, record.dueAt - this.now()));
    timer.unref?.();
    this.timers.set(record.surveyId, timer);
  }

  private async dispatch(surveyId: string): Promise<void> {
    const record = this.records.get(surveyId);
    if (!record || record.status !== 'scheduled') return;
    const version = record.updatedAt;
    const recap = await this.buildRecap(record);
    const current = this.records.get(surveyId);
    if (!current || current.status !== 'scheduled' || current.updatedAt !== version) return;

    current.recap = formatRecap(recap.prompt, recap.answer);
    current.status = 'sending';
    current.updatedAt = this.now();
    this.persist();
    try {
      const registered = this.options.registerAsk({
        larkAppId: current.larkAppId,
        chatId: current.chatId,
        rootMessageId: current.rootMessageId,
        sessionId: current.sessionId,
        chatType: current.chatType,
        timeoutMs: this.config.askTtlMs,
        purpose: 'feedback_survey',
        expectedResponderOpenIds: [current.respondentOpenId],
        allowCustomReply: false,
        metadata: {
          surveyId: current.surveyId,
          turnId: current.turnId,
          title: current.title,
          recapPrompt: recap.prompt || undefined,
          recapAnswer: recap.answer || undefined,
        },
        questions: [{
          prompt: '这次回答对你的帮助有多大？',
          options: [
            { key: '1', label: '⭐ 很不满意' },
            { key: '2', label: '⭐⭐ 不满意' },
            { key: '3', label: '⭐⭐⭐ 一般' },
            { key: '4', label: '⭐⭐⭐⭐ 满意' },
            { key: '5', label: '⭐⭐⭐⭐⭐ 非常满意' },
          ],
          multiSelect: false,
        }],
        onDispatched: async ({ askId, messageId }) => {
          const live = this.records.get(surveyId);
          if (!live || live.status !== 'sending') return;
          live.askId = askId;
          live.cardMessageId = messageId;
          live.sentAt = this.now();
          live.status = 'sent';
          live.updatedAt = this.now();
          this.persist();
          this.queueBaseSync(live);
          void Promise.resolve(this.options.onDispatched?.({ ...live })).catch(error => {
            logger.warn(`feedback survey ${live.surveyId} post-dispatch hook failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        },
        onSettled: async (result) => {
          this.settleFromAsk(surveyId, result);
        },
      });
      current.askId = registered.askId;
      current.updatedAt = this.now();
      this.persist();
      void registered.result.then(result => this.settleFromAsk(surveyId, result)).catch(err => {
        logger.warn(`feedback survey ${surveyId} result rejected: ${err instanceof Error ? err.message : String(err)}`);
      });
    } catch (err) {
      current.status = 'failed';
      current.failureReason = err instanceof Error ? err.message : String(err);
      current.updatedAt = this.now();
      this.persist();
    }
  }

  private settleFromAsk(surveyId: string, result: FeedbackSurveyAskResult): void {
    const record = this.records.get(surveyId);
    if (!record || ['answered', 'timed_out', 'invalidated'].includes(record.status)) return;
    if (result.kind === 'answered') {
      record.status = 'answered';
      record.rating = Number(result.answers[0]?.[0]) || undefined;
      record.answeredAt = this.now();
    } else if (result.kind === 'timedOut') {
      record.status = 'timed_out';
    } else {
      record.status = 'invalidated';
      record.failureReason = result.reason;
    }
    record.updatedAt = this.now();
    this.persist();
    this.queueBaseSync(record);
    void Promise.resolve(this.options.onSettled?.({ ...record })).catch(error => {
      logger.warn(`feedback survey ${record.surveyId} post-settlement hook failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private cancel(record: FeedbackSurveyRecord, reason: string): void {
    const timer = this.timers.get(record.surveyId);
    if (timer) clearTimeout(timer);
    this.timers.delete(record.surveyId);
    record.status = 'cancelled';
    record.failureReason = reason;
    record.updatedAt = this.now();
    this.persist();
  }

  private async recoverPostDispatchHooks(record: FeedbackSurveyRecord): Promise<void> {
    try {
      await this.options.onDispatched?.({ ...record });
      if (record.status === 'answered'
        || record.status === 'timed_out'
        || record.status === 'invalidated') {
        await this.options.onSettled?.({ ...record });
      }
    } catch (error) {
      logger.warn(`feedback survey ${record.surveyId} recovered post-dispatch hook failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private recipientFor(openId: string): FeedbackSurveyRecipient | undefined {
    const explicit = this.config.recipients.find(recipient => recipient.openId === openId);
    if (explicit) return explicit;
    return this.config.defaultIdleDelayMs
      ? { openId, idleDelayMs: this.config.defaultIdleDelayMs }
      : undefined;
  }

  private async buildRecap(record: FeedbackSurveyRecord): Promise<{ prompt: string; answer: string }> {
    const prompt = record.turnId.startsWith('om_')
      ? await this.readMessage(record, record.turnId, 160)
      : '';
    const answer = record.answerMessageId
      ? await this.readMessage(record, record.answerMessageId, 220)
      : '';
    return {
      prompt: prompt || sanitizeFeedbackRecap(record.title ?? '', 160),
      answer,
    };
  }

  private async readMessage(record: FeedbackSurveyRecord, messageId: string, maxChars: number): Promise<string> {
    try {
      const message = await this.options.getMessage(messageId);
      return message.chatId === record.chatId ? sanitizeFeedbackRecap(message.content, maxChars) : '';
    } catch (err) {
      logger.debug(`feedback survey recap fetch failed for ${messageId}: ${err instanceof Error ? err.message : String(err)}`);
      return '';
    }
  }

  private load(): void {
    const path = this.storePath();
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as FeedbackSurveyStore;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) return;
      for (const record of parsed.records) {
        if (record.larkAppId === this.options.larkAppId) this.records.set(record.surveyId, record);
      }
    } catch (err) {
      logger.warn(`feedback survey store load failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private persist(): void {
    if (!this.config.enabled) return;
    const dir = join(this.options.dataDir, 'feedback-surveys');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(this.storePath(), JSON.stringify({
      version: 1,
      records: this.listRecords(),
    } satisfies FeedbackSurveyStore), { mode: 0o600, durable: true });
  }

  private queueBaseSync(record: FeedbackSurveyRecord): void {
    if (!this.config.larkBase || !this.options.upsertBase) return;
    const prior = this.baseSyncs.get(record.surveyId) ?? Promise.resolve();
    const run = prior
      .catch(() => undefined)
      .then(async () => {
        const live = this.records.get(record.surveyId);
        if (!live) return;
        try {
          const result = await this.options.upsertBase!({
            config: this.config.larkBase!,
            record: { ...live },
          });
          if (result.recordId) live.baseRecordId = result.recordId;
          if (live.baseSyncError) delete live.baseSyncError;
          live.updatedAt = this.now();
          this.persist();
        } catch (err) {
          live.baseSyncError = err instanceof Error ? err.message : String(err);
          live.updatedAt = this.now();
          this.persist();
          logger.warn(`feedback survey ${live.surveyId} Base sync failed: ${live.baseSyncError}`);
        }
      })
      .finally(() => {
        if (this.baseSyncs.get(record.surveyId) === run) this.baseSyncs.delete(record.surveyId);
      });
    this.baseSyncs.set(record.surveyId, run);
  }

  private storePath(): string {
    return join(this.options.dataDir, 'feedback-surveys', `${safeFilePart(this.options.larkAppId)}.json`);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function stableSurveyId(larkAppId: string, sessionId: string, turnId: string): string {
  return createHash('sha256').update(`${larkAppId}\0${sessionId}\0${turnId}`).digest('hex');
}

function safeFilePart(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function formatRecap(prompt: string, answer: string): string | undefined {
  if (!prompt && !answer) return undefined;
  return [
    prompt ? `目标：${prompt}` : '',
    answer ? `结论 / 产出：${answer}` : '',
  ].filter(Boolean).join('\n');
}

const feedbackSurveyManagers = new Map<string, FeedbackSurveyManager>();

export function startFeedbackSurveyManager(options: FeedbackSurveyManagerOptions): FeedbackSurveyManager {
  feedbackSurveyManagers.get(options.larkAppId)?.stop();
  const manager = new FeedbackSurveyManager(options);
  feedbackSurveyManagers.set(options.larkAppId, manager);
  manager.start();
  return manager;
}

export function stopFeedbackSurveyManager(larkAppId: string): void {
  feedbackSurveyManagers.get(larkAppId)?.stop();
  feedbackSurveyManagers.delete(larkAppId);
}

export function noteFeedbackUserActivity(input: {
  larkAppId: string;
  sessionId: string;
  turnId: string;
  senderOpenId: string;
}): void {
  feedbackSurveyManagers.get(input.larkAppId)?.noteUserActivity(input);
}

export function scheduleFeedbackSurveyForTurn(input: {
  larkAppId: string;
  sessionId: string;
  turnId: string;
  chatId: string;
  rootMessageId: string | null;
  chatType?: 'group' | 'p2p';
  title?: string;
  cliId?: string;
  respondentOpenId?: string;
  answerMessageId?: string;
}): void {
  const { larkAppId, ...turn } = input;
  feedbackSurveyManagers.get(larkAppId)?.scheduleForTurn(turn);
}
