import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';
import type { FeedbackSurveyRecord } from './feedback-survey.js';
import type { LogisticsSessionSnapshot, LogisticsSnapshotMessage } from './logistics-session-capture.js';
import { LogisticsConversationStore } from './logistics-conversation-store.js';

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

export type LogisticsSessionMasterBaseUpsert = (input: {
  config: NonNullable<NormalizedLogisticsSessionMasterConfig['larkBase']>;
  record: LogisticsSessionMasterRecord;
}) => Promise<{ recordId?: string }>;

export type LogisticsSessionSnapshotLoader = (input: {
  record: FeedbackSurveyRecord;
  maxTranscriptChars: number;
}) => Promise<LogisticsSessionSnapshot>;

export type LogisticsSessionModelTaskRunner = (input: {
  record: LogisticsSessionMasterRecord;
}) => Promise<LogisticsModelTagging>;

export interface LogisticsSessionTurnCompletedInput {
  larkAppId: string;
  sessionId: string;
  turnId: string;
  chatId: string;
  rootMessageId: string | null;
  respondentOpenId?: string;
  title?: string;
  answerMessageId?: string;
}

export interface LogisticsSessionMasterManagerOptions {
  dataDir: string;
  larkAppId: string;
  config?: LogisticsSessionMasterConfig;
  captureSession: LogisticsSessionSnapshotLoader;
  upsertBase?: LogisticsSessionMasterBaseUpsert;
  runModelTask?: LogisticsSessionModelTaskRunner;
  now?: () => number;
}

interface LogisticsSessionMasterStore {
  version: 1;
  records: LogisticsSessionMasterRecord[];
}

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

function ratingStateFor(record: FeedbackSurveyRecord): LogisticsSessionMasterRecord['ratingState'] {
  if (record.status === 'answered' && record.rating !== undefined) return 'rated';
  if (record.status === 'timed_out') return 'timed_out';
  if (record.status === 'invalidated') return 'invalidated';
  return 'awaiting';
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

export class LogisticsSessionMasterManager {
  private readonly config: NormalizedLogisticsSessionMasterConfig;
  private readonly records = new Map<string, LogisticsSessionMasterRecord>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly baseSyncs = new Map<string, Promise<void>>();
  private readonly baseRetryTimers = new Map<string, NodeJS.Timeout>();
  private baseWriteTail: Promise<void> = Promise.resolve();
  private conversationStore?: LogisticsConversationStore;
  private readonly sqliteFingerprints = new Map<string, string>();
  private started = false;

  constructor(private readonly options: LogisticsSessionMasterManagerOptions) {
    this.config = normalizeLogisticsSessionMasterConfig(options.config);
    if (this.config.enabled && this.config.sqlite.enabled) {
      this.conversationStore = new LogisticsConversationStore({
        dataDir: options.dataDir,
        ...(this.config.sqlite.path ? { path: this.config.sqlite.path } : {}),
      });
    }
  }

  start(): void {
    if (this.started || !this.config.enabled) return;
    this.started = true;
    this.load();
    this.conversationStore?.importLegacyJson(this.options.dataDir, this.options.larkAppId);
    for (const record of this.records.values()) {
      if (record.taggingState === 'pending_capture') this.queue(record.masterKey);
      if (record.taggingState === 'tagging') {
        record.taggingState = 'needs_review';
        record.needsReview = true;
        record.reviewReason = mergeReviewReason(record.reviewReason, '模型任务在进程重启时状态不明');
        record.updatedAt = this.now();
        this.persist();
        this.queueBaseSync(record.masterKey);
      }
    }
  }

  stop(): void {
    this.started = false;
    for (const timer of this.baseRetryTimers.values()) clearTimeout(timer);
    this.baseRetryTimers.clear();
    this.conversationStore?.close();
    this.conversationStore = undefined;
  }

  listRecords(): LogisticsSessionMasterRecord[] {
    return [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  noteSurveyDispatched(survey: FeedbackSurveyRecord): void {
    if (!this.config.enabled) return;
    const masterKey = stableLogisticsSessionMasterKey(
      survey.larkAppId,
      survey.sessionId,
      survey.turnId,
      survey.chatId,
    );
    const now = this.now();
    const prior = this.records.get(masterKey);
    const isNewTurn = !!prior && prior.turnId !== survey.turnId;
    const record: LogisticsSessionMasterRecord = {
      masterKey,
      larkAppId: survey.larkAppId,
      sessionId: survey.sessionId,
      turnId: survey.turnId,
      surveyId: survey.surveyId,
      settledSurveyIds: prior?.settledSurveyIds ?? [],
      ratingCount: prior?.ratingCount ?? 0,
      chatId: survey.chatId,
      rootMessageId: survey.rootMessageId,
      respondentOpenId: survey.respondentOpenId || prior?.respondentOpenId || '',
      title: survey.title ?? prior?.title,
      recap: survey.recap ?? prior?.recap,
      answerMessageId: survey.answerMessageId,
      surveyStatus: survey.status,
      dueAt: survey.dueAt,
      sentAt: survey.sentAt,
      rating: survey.rating,
      answeredAt: survey.answeredAt,
      ratingState: ratingStateFor(survey),
      taggingState: isNewTurn ? 'pending_capture' : prior?.taggingState ?? 'pending_capture',
      businessCategory: isNewTurn ? undefined : prior?.businessCategory,
      problemType: isNewTurn ? undefined : prior?.problemType,
      resolutionStatus: isNewTurn ? undefined : prior?.resolutionStatus,
      overallConfidence: isNewTurn ? undefined : prior?.overallConfidence,
      needsReview: isNewTurn ? false : prior?.needsReview ?? false,
      reviewReason: isNewTurn ? undefined : prior?.reviewReason,
      transcript: isNewTurn ? undefined : prior?.transcript,
      transcriptHash: isNewTurn ? undefined : prior?.transcriptHash,
      captureState: isNewTurn ? undefined : prior?.captureState,
      messages: isNewTurn ? undefined : prior?.messages,
      harnessRevision: isNewTurn ? undefined : prior?.harnessRevision,
      businessReasonCode: isNewTurn ? undefined : prior?.businessReasonCode,
      problemReasonCode: isNewTurn ? undefined : prior?.problemReasonCode,
      resolutionReasonCode: isNewTurn ? undefined : prior?.resolutionReasonCode,
      evidenceAnchors: isNewTurn ? undefined : prior?.evidenceAnchors,
      manualReviewStatus: prior?.manualReviewStatus ?? 'pending',
      modelAttempts: isNewTurn ? 0 : prior?.modelAttempts ?? 0,
      modelError: isNewTurn ? undefined : prior?.modelError,
      baseRecordId: prior?.baseRecordId,
      baseSyncError: prior?.baseSyncError,
      baseSyncAttempts: prior?.baseSyncAttempts ?? 0,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    this.records.set(masterKey, record);
    this.persist();
    // The card has reached the user: create/update its master row immediately.
    // Capture and semantic tagging update the same row asynchronously afterwards.
    if (this.config.larkBase) this.queueBaseSync(masterKey);
    this.queue(masterKey);
  }

  noteTurnCompleted(input: LogisticsSessionTurnCompletedInput): void {
    if (!this.config.enabled) return;
    const masterKey = stableLogisticsSessionMasterKey(
      input.larkAppId,
      input.sessionId,
      input.turnId,
      input.chatId,
    );
    const now = this.now();
    const prior = this.records.get(masterKey);
    const isNewTurn = !!prior && prior.turnId !== input.turnId;
    const shouldCapture = !!input.answerMessageId
      && (isNewTurn || !prior?.transcriptHash || prior.answerMessageId !== input.answerMessageId);
    const record: LogisticsSessionMasterRecord = {
      masterKey,
      larkAppId: input.larkAppId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      surveyId: prior?.surveyId ?? `turn_${input.turnId}`,
      settledSurveyIds: prior?.settledSurveyIds ?? [],
      ratingCount: prior?.ratingCount ?? 0,
      chatId: input.chatId,
      rootMessageId: input.rootMessageId,
      respondentOpenId: input.respondentOpenId ?? prior?.respondentOpenId ?? '',
      title: input.title ?? prior?.title,
      recap: prior?.recap,
      answerMessageId: input.answerMessageId ?? prior?.answerMessageId,
      surveyStatus: prior?.surveyStatus ?? 'scheduled',
      dueAt: prior?.dueAt ?? now,
      sentAt: prior?.sentAt,
      rating: prior?.rating,
      answeredAt: prior?.answeredAt,
      ratingState: prior?.ratingState ?? 'awaiting',
      transcript: shouldCapture ? undefined : prior?.transcript,
      transcriptHash: shouldCapture ? undefined : prior?.transcriptHash,
      captureState: shouldCapture ? undefined : prior?.captureState,
      messages: shouldCapture ? undefined : prior?.messages,
      taggingState: shouldCapture ? 'pending_capture' : prior?.taggingState ?? 'pending_capture',
      businessCategory: isNewTurn ? undefined : prior?.businessCategory,
      problemType: isNewTurn ? undefined : prior?.problemType,
      resolutionStatus: isNewTurn ? undefined : prior?.resolutionStatus,
      overallConfidence: isNewTurn ? undefined : prior?.overallConfidence,
      needsReview: isNewTurn ? false : prior?.needsReview ?? false,
      reviewReason: isNewTurn ? undefined : prior?.reviewReason,
      harnessRevision: isNewTurn ? undefined : prior?.harnessRevision,
      businessReasonCode: isNewTurn ? undefined : prior?.businessReasonCode,
      problemReasonCode: isNewTurn ? undefined : prior?.problemReasonCode,
      resolutionReasonCode: isNewTurn ? undefined : prior?.resolutionReasonCode,
      evidenceAnchors: isNewTurn ? undefined : prior?.evidenceAnchors,
      manualReviewStatus: prior?.manualReviewStatus ?? 'pending',
      modelAttempts: isNewTurn ? 0 : prior?.modelAttempts ?? 0,
      modelError: isNewTurn ? undefined : prior?.modelError,
      baseRecordId: prior?.baseRecordId,
      baseSyncError: prior?.baseSyncError,
      baseSyncAttempts: prior?.baseSyncAttempts ?? 0,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    this.records.set(masterKey, record);
    this.persist();
    if (this.config.larkBase) this.queueBaseSync(masterKey);
    if (input.answerMessageId) this.queue(masterKey);
  }

  noteSurveySettled(survey: FeedbackSurveyRecord): void {
    if (!this.config.enabled) return;
    const masterKey = stableLogisticsSessionMasterKey(
      survey.larkAppId,
      survey.sessionId,
      survey.turnId,
      survey.chatId,
    );
    const record = this.records.get(masterKey);
    if (!record) return;
    if (!record.settledSurveyIds.includes(survey.surveyId)) {
      record.settledSurveyIds.push(survey.surveyId);
      if (survey.status === 'answered' && survey.rating !== undefined) record.ratingCount += 1;
    }
    if (record.surveyId === survey.surveyId) {
      record.surveyStatus = survey.status;
      record.ratingState = ratingStateFor(survey);
    }
    if (survey.status === 'answered'
      && survey.rating !== undefined
      && (record.answeredAt === undefined || (survey.answeredAt ?? 0) >= record.answeredAt)) {
      record.rating = survey.rating;
      record.answeredAt = survey.answeredAt;
    }
    record.updatedAt = this.now();
    this.persist();
    if (this.config.larkBase) this.queueBaseSync(masterKey);
  }

  private queue(masterKey: string): void {
    const prior = this.jobs.get(masterKey) ?? Promise.resolve();
    const run = prior
      .catch(() => undefined)
      .then(() => this.process(masterKey))
      .catch(error => {
        logger.warn(`[logistics-session-master] processing failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (this.jobs.get(masterKey) === run) this.jobs.delete(masterKey);
      });
    this.jobs.set(masterKey, run);
  }

  private async process(masterKey: string): Promise<void> {
    const record = this.records.get(masterKey);
    if (!record || !this.started) return;
    if (record.taggingState === 'pending_capture') {
      try {
        const snapshot = await this.options.captureSession({
          record: toSurveyRecord(record),
          maxTranscriptChars: this.config.maxTranscriptChars,
        });
        const live = this.records.get(masterKey);
        if (!live) return;
        live.transcript = snapshot.transcript;
        live.transcriptHash = snapshot.transcriptHash;
        live.captureState = snapshot.captureState;
        live.messages = snapshot.messages;
        if (snapshot.reviewReason) {
          live.needsReview = true;
          live.reviewReason = mergeReviewReason(live.reviewReason, snapshot.reviewReason);
        }
        live.taggingState = 'tagging';
        live.updatedAt = this.now();
        this.persist();
        if (this.config.larkBase) await this.syncBaseBestEffort(masterKey);
      } catch (error) {
        const live = this.records.get(masterKey);
        if (!live) return;
        this.applyTagging(live, fallbackLogisticsTagging(
          `会话采集失败：${error instanceof Error ? error.message : String(error)}`,
        ));
        live.captureState = 'partial';
        live.taggingState = 'needs_review';
        live.updatedAt = this.now();
        this.persist();
        if (this.config.larkBase) await this.syncBaseBestEffort(masterKey);
        return;
      }
    }

    const live = this.records.get(masterKey);
    if (!live || live.taggingState !== 'tagging') return;
    if (!this.config.modelTask.enabled || !this.options.runModelTask) {
      this.applyTagging(live, fallbackLogisticsTagging('实时模型任务未启用'));
      live.taggingState = 'needs_review';
      live.updatedAt = this.now();
      this.persist();
      if (this.config.larkBase) await this.syncBaseBestEffort(masterKey);
      return;
    }

    try {
      live.modelAttempts += 1;
      live.updatedAt = this.now();
      this.persist();
      const startedAt = this.now();
      const tagging = await this.options.runModelTask({ record: { ...live } });
      const current = this.records.get(masterKey);
      if (!current) return;
      this.applyTagging(current, tagging);
      current.taggingState = current.needsReview ? 'needs_review' : 'tagged';
      current.harnessRevision = tagging.harnessRevision;
      current.businessReasonCode = tagging.businessReasonCode;
      current.problemReasonCode = tagging.problemReasonCode;
      current.resolutionReasonCode = tagging.resolutionReasonCode;
      current.evidenceAnchors = tagging.evidenceAnchors;
      current.manualReviewStatus = tagging.manualReviewStatus ?? 'pending';
      current.updatedAt = this.now();
      if (current.transcriptHash) this.conversationStore?.recordLabelRun({
        masterKey: current.masterKey,
        transcriptHash: current.transcriptHash,
        harnessRevision: current.harnessRevision,
        status: 'completed',
        attempt: current.modelAttempts,
        createdAt: startedAt,
        completedAt: current.updatedAt,
      });
      this.persist();
      if (this.config.larkBase) await this.syncBaseBestEffort(masterKey);
    } catch (error) {
      const current = this.records.get(masterKey);
      if (!current) return;
      const message = error instanceof Error ? error.message : String(error);
      current.modelError = message;
      this.applyTagging(current, fallbackLogisticsTagging(`模型任务失败：${message}`));
      current.taggingState = 'needs_review';
      current.updatedAt = this.now();
      if (current.transcriptHash) this.conversationStore?.recordLabelRun({
        masterKey: current.masterKey,
        transcriptHash: current.transcriptHash,
        harnessRevision: current.harnessRevision,
        status: 'failed',
        attempt: current.modelAttempts,
        error: message,
        createdAt: current.updatedAt,
        completedAt: current.updatedAt,
      });
      this.persist();
      if (this.config.larkBase) await this.syncBaseBestEffort(masterKey);
    }
  }

  private applyTagging(record: LogisticsSessionMasterRecord, tagging: LogisticsModelTagging): void {
    record.businessCategory = tagging.businessCategory;
    record.problemType = tagging.problemType;
    record.resolutionStatus = tagging.resolutionStatus;
    record.overallConfidence = tagging.overallConfidence;
    record.needsReview = record.needsReview || tagging.needsReview;
    record.reviewReason = mergeReviewReason(record.reviewReason, tagging.reviewReason);
    record.harnessRevision = tagging.harnessRevision ?? record.harnessRevision;
    record.businessReasonCode = tagging.businessReasonCode ?? record.businessReasonCode;
    record.problemReasonCode = tagging.problemReasonCode ?? record.problemReasonCode;
    record.resolutionReasonCode = tagging.resolutionReasonCode ?? record.resolutionReasonCode;
    record.evidenceAnchors = tagging.evidenceAnchors ?? record.evidenceAnchors;
    record.manualReviewStatus = tagging.manualReviewStatus ?? record.manualReviewStatus ?? 'pending';
  }

  private queueBaseSync(masterKey: string): void {
    const prior = this.baseSyncs.get(masterKey) ?? Promise.resolve();
    const run = prior
      .catch(() => undefined)
      .then(() => this.serializeBaseWrite(masterKey))
      .catch(error => {
        logger.warn(`[logistics-session-master] Base sync failed: ${error instanceof Error ? error.message : String(error)}`);
        this.scheduleBaseRetry(masterKey);
      })
      .finally(() => {
        if (this.baseSyncs.get(masterKey) === run) this.baseSyncs.delete(masterKey);
      });
    this.baseSyncs.set(masterKey, run);
  }

  private async syncBaseBestEffort(masterKey: string): Promise<void> {
    try {
      await this.serializeBaseWrite(masterKey);
    } catch (error) {
      logger.warn(`[logistics-session-master] Base sync failed: ${error instanceof Error ? error.message : String(error)}`);
      this.scheduleBaseRetry(masterKey);
    }
  }

  /**
   * Feishu Base rejects concurrent writes to the same table. Session processing
   * may run in parallel, but every write for this bot's one master table stays
   * in one FIFO chain.
   */
  private serializeBaseWrite(masterKey: string): Promise<void> {
    const run = this.baseWriteTail
      .catch(() => undefined)
      .then(() => this.upsertBase(masterKey));
    this.baseWriteTail = run.catch(() => undefined);
    return run;
  }

  private scheduleBaseRetry(masterKey: string): void {
    if (!this.started) return;
    const record = this.records.get(masterKey);
    if (!record) return;
    const previous = this.baseRetryTimers.get(masterKey);
    if (previous) clearTimeout(previous);
    const attempts = Math.max(1, record.baseSyncAttempts);
    const delay = Math.min(15_000 * 2 ** Math.min(attempts - 1, 5), 5 * 60_000);
    const timer = setTimeout(() => {
      this.baseRetryTimers.delete(masterKey);
      this.queueBaseSync(masterKey);
    }, delay);
    timer.unref?.();
    this.baseRetryTimers.set(masterKey, timer);
  }

  private async upsertBase(masterKey: string): Promise<void> {
    const record = this.records.get(masterKey);
    if (!record || !this.config.larkBase || !this.options.upsertBase) return;
    try {
      const result = await this.options.upsertBase({
        config: this.config.larkBase,
        record: { ...record },
      });
      const live = this.records.get(masterKey);
      if (!live) return;
      if (result.recordId) live.baseRecordId = result.recordId;
      delete live.baseSyncError;
      live.baseSyncAttempts = 0;
      live.updatedAt = this.now();
      this.persist();
    } catch (error) {
      const live = this.records.get(masterKey);
      if (!live) return;
      live.baseSyncError = error instanceof Error ? error.message : String(error);
      live.baseSyncAttempts += 1;
      live.updatedAt = this.now();
      this.persist();
      throw error;
    }
  }

  private load(): void {
    const path = this.storePath();
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as LogisticsSessionMasterStore;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) return;
      for (const record of parsed.records) {
        if (record.larkAppId === this.options.larkAppId && record.masterKey) {
          const legacyResolution = String((record as { resolutionStatus?: unknown }).resolutionStatus ?? '');
          this.records.set(record.masterKey, {
            ...record,
            ...(legacyResolution === 'unresolved' ? {
              resolutionStatus: 'unknown' as const,
              needsReview: true,
              reviewReason: mergeReviewReason(record.reviewReason, '旧未解决状态迁移为 unknown'),
            } : {}),
            manualReviewStatus: record.manualReviewStatus ?? 'pending',
            settledSurveyIds: Array.isArray(record.settledSurveyIds) ? record.settledSurveyIds : [],
            ratingCount: Number.isSafeInteger(record.ratingCount) && record.ratingCount >= 0
              ? record.ratingCount
              : 0,
            baseSyncAttempts: Number.isSafeInteger(record.baseSyncAttempts) && record.baseSyncAttempts >= 0
              ? record.baseSyncAttempts
              : 0,
          });
        }
      }
    } catch (error) {
      logger.warn(`[logistics-session-master] store load failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persist(): void {
    if (!this.config.enabled) return;
    const dir = join(this.options.dataDir, 'logistics-session-master');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(this.storePath(), JSON.stringify({
      version: 1,
      records: this.listRecords(),
    } satisfies LogisticsSessionMasterStore), { mode: 0o600, durable: true });
    for (const record of this.records.values()) {
      const fingerprint = JSON.stringify(record);
      if (this.sqliteFingerprints.get(record.masterKey) === fingerprint) continue;
      try {
        this.conversationStore?.upsert(record);
        this.sqliteFingerprints.set(record.masterKey, fingerprint);
      } catch (error) {
        logger.warn(`[logistics-session-master] SQLite sync failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private storePath(): string {
    return join(this.options.dataDir, 'logistics-session-master', `${safeFilePart(this.options.larkAppId)}.json`);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function toSurveyRecord(record: LogisticsSessionMasterRecord): FeedbackSurveyRecord {
  return {
    surveyId: record.surveyId,
    larkAppId: record.larkAppId,
    sessionId: record.sessionId,
    turnId: record.turnId,
    chatId: record.chatId,
    rootMessageId: record.rootMessageId,
    respondentOpenId: record.respondentOpenId,
    title: record.title,
    recap: record.recap,
    answerMessageId: record.answerMessageId,
    status: record.surveyStatus,
    scheduledAt: record.createdAt,
    dueAt: record.dueAt,
    sentAt: record.sentAt,
    rating: record.rating,
    answeredAt: record.answeredAt,
    updatedAt: record.updatedAt,
  };
}

function mergeReviewReason(current: string | undefined, next: string | undefined): string | undefined {
  if (!next) return current;
  if (!current) return next;
  return current.includes(next) ? current : `${current}；${next}`;
}

function safeFilePart(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, '_');
}

const logisticsSessionMasterManagers = new Map<string, LogisticsSessionMasterManager>();

export function startLogisticsSessionMasterManager(
  options: LogisticsSessionMasterManagerOptions,
): LogisticsSessionMasterManager {
  logisticsSessionMasterManagers.get(options.larkAppId)?.stop();
  const manager = new LogisticsSessionMasterManager(options);
  logisticsSessionMasterManagers.set(options.larkAppId, manager);
  manager.start();
  return manager;
}

export function stopLogisticsSessionMasterManager(larkAppId: string): void {
  logisticsSessionMasterManagers.get(larkAppId)?.stop();
  logisticsSessionMasterManagers.delete(larkAppId);
}

export function noteLogisticsSessionTurnCompleted(input: LogisticsSessionTurnCompletedInput): void {
  logisticsSessionMasterManagers.get(input.larkAppId)?.noteTurnCompleted(input);
}

export function noteLogisticsSessionSurveyDispatched(record: FeedbackSurveyRecord): void {
  logisticsSessionMasterManagers.get(record.larkAppId)?.noteSurveyDispatched(record);
}

export function noteLogisticsSessionSurveySettled(record: FeedbackSurveyRecord): void {
  logisticsSessionMasterManagers.get(record.larkAppId)?.noteSurveySettled(record);
}
