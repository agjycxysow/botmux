import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildLogisticsTopicKey,
  type LogisticsTopicIdentity,
} from '../src/services/logistics-analysis-topic.js';
import {
  LogisticsAnalysisStore,
  type LogisticsAnalysisMessageInput,
  type LogisticsAnalysisSessionInput,
} from '../src/services/logistics-analysis-store.js';

const dirs: string[] = [];
const revision = 'revision-a';

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'botmux-logistics-analysis-'));
  dirs.push(dir);
  return dir;
}

function identity(overrides: Partial<LogisticsTopicIdentity> = {}): LogisticsTopicIdentity {
  return {
    botId: 'bot-a',
    chatId: 'chat-a',
    rootMessageId: 'root-a',
    ...overrides,
  };
}

function session(
  topic: LogisticsTopicIdentity = identity(),
  overrides: Partial<LogisticsAnalysisSessionInput> = {},
): LogisticsAnalysisSessionInput {
  return {
    botId: topic.botId,
    botName: topic.botId === 'bot-a' ? '物流 Bot A' : '物流 Bot B',
    chatId: topic.chatId,
    chatName: '物流群',
    scope: 'thread',
    rootMessageId: topic.rootMessageId,
    title: '发货问题',
    sessionStatus: 'closed',
    createdAt: 1_000,
    lastMessageAt: 2_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

function message(
  sessionKey: string,
  platformMessageId: string | null,
  role: 'user' | 'assistant',
  content: string,
  overrides: Partial<LogisticsAnalysisMessageInput> = {},
): LogisticsAnalysisMessageInput {
  return {
    sessionKey,
    platformMessageId,
    role,
    content,
    occurredAt: role === 'user' ? 1_000 : 2_000,
    source: 'lark_history',
    ...overrides,
  };
}

async function capturedStore(): Promise<{
  dataDir: string;
  store: LogisticsAnalysisStore;
  sessionKey: string;
  contentHash: string;
}> {
  const dataDir = await tempDir();
  const store = new LogisticsAnalysisStore({ dataDir });
  const sessionKey = buildLogisticsTopicKey(identity());
  store.syncSessions([session(identity(), { botmuxSessionId: 'bm-1', cliSessionId: 'cli-1' })]);
  store.upsertMessages([
    message(sessionKey, 'om-question', 'user', '我的包裹什么时候发货？'),
    message(sessionKey, 'om-answer', 'assistant', '我会根据当前履约状态说明处理结果。', {
      responseKind: 'final',
    }),
  ], 2_000);
  const captured = store.markCaptureResult({ sessionKey, status: 'captured', updatedAt: 3_000 });
  return { dataDir, store, sessionKey, contentHash: captured.contentHash! };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('four-table logistics analysis store', () => {
  it('groups multiple BotMux sessions by bot/chat/root, isolates bots, and reports message conflicts', async () => {
    const dataDir = await tempDir();
    const store = new LogisticsAnalysisStore({ dataDir });
    const topicA = identity();
    const topicB = identity({ botId: 'bot-b' });
    const keyA = buildLogisticsTopicKey(topicA);
    const keyB = buildLogisticsTopicKey(topicB);
    const sync = store.syncSessions([
      session(topicA, { botmuxSessionId: 'bm-old', cliSessionId: 'cli-old', updatedAt: 1_000 }),
      session(topicA, { botmuxSessionId: 'bm-latest', cliSessionId: 'cli-latest', updatedAt: 2_000 }),
      session(topicB, { botmuxSessionId: 'bm-other' }),
      { ...session(topicA), scope: 'chat', rootMessageId: null, botmuxSessionId: 'chat-session' },
    ]);
    expect(sync).toMatchObject({
      total: 4,
      included: 3,
      excluded: 1,
      excludedByReason: { chat_scope: 1 },
    });
    expect(store.getSession(keyA)).toMatchObject({
      botmuxSessionId: 'bm-latest',
      cliSessionId: 'cli-latest',
      publicId: expect.stringMatching(/^topic_[a-f0-9]{32}$/),
    });

    const firstWrite = store.upsertMessages([
      message(keyA, 'om-q', 'user', '问题'),
      message(keyA, 'om-a', 'assistant', '[图片]请升级至最新版本客户端，以查看内容'),
      message(keyB, 'om-q', 'user', '问题'),
      message(keyA, 'om-q', 'user', '问题'),
    ], 3_000);
    expect(firstWrite).toMatchObject({ total: 4, inserted: 3, unchanged: 1 });

    const recovered = store.upsertMessages([message(keyA, 'om-a', 'assistant', '这是绑定到同一平台消息的可靠回复。', {
      responseKind: 'final',
      source: 'codex_rollout',
    })], 4_000);
    expect(recovered.conflicts).toMatchObject([{
      resolution: 'replaced_by_trusted_recovery',
      existingSource: 'lark_history',
      incomingSource: 'codex_rollout',
    }]);
    const unresolved = store.upsertMessages([message(keyA, 'om-a', 'assistant', '另一份有意义但无法证明更新关系的正文')], 5_000);
    expect(unresolved.conflicts).toMatchObject([{
      resolution: 'unresolved',
    }]);
    expect(store.getMessages(keyA).find(item => item.platformMessageId === 'om-a')?.content)
      .toBe('这是绑定到同一平台消息的可靠回复。');

    const missingId = store.upsertMessages([
      message(keyA, null, 'user', '无平台 ID 的相同消息'),
      message(keyA, null, 'user', '无平台 ID 的相同消息'),
    ], 6_000);
    expect(missingId).toMatchObject({
      inserted: 2,
      missingPlatformMessageIds: 2,
      diagnostics: [
        { type: 'missing_platform_message_id' },
        { type: 'missing_platform_message_id' },
      ],
    });
    expect(store.getMessages(keyA)).toHaveLength(4);
    expect(store.getMessages(keyB)).toHaveLength(1);
    store.close();
  });

  it('invalidates labels on full content or capture-version changes and enforces conditional runs', async () => {
    const { store, sessionKey, contentHash } = await capturedStore();
    const run = store.registerLabelRun({ sessionKey, contentHash, labelerRevision: revision, model: 'test', now: 4_000 });
    expect(run).toMatchObject({ attempt: 1, outcome: 'created', status: 'running' });
    expect(store.registerLabelRun({ sessionKey, contentHash, labelerRevision: revision, now: 4_001 }))
      .toMatchObject({ runId: run.runId, attempt: 1, outcome: 'reused' });
    store.commitLabel({
      runId: run.runId,
      sessionKey,
      contentHash,
      labelerRevision: revision,
      lb: 'LB02',
      lp: 'LP05',
      resolutionStatus: 'resolved',
      confidence: 'high',
      needsReview: false,
      labelReason: '有完整证据',
      labeledAt: 5_000,
    });
    const publicId = store.getSession(sessionKey)!.publicId;
    expect(store.list({ labelerRevision: revision })).toMatchObject({
      total: 1,
      items: [{ labelStatus: 'labeled', lb: 'LB02', resolutionStatus: 'resolved' }],
    });

    const oldCaptureVersion = store.getSession(sessionKey)!.captureVersion;
    store.markCaptureResult({ sessionKey, status: 'partial', updatedAt: 6_000 });
    expect(store.getSession(sessionKey)!.captureVersion).toBe(oldCaptureVersion + 1);
    store.markCaptureResult({ sessionKey, status: 'captured', updatedAt: 7_000 });
    expect(store.list({ labelerRevision: revision }).items[0]).toMatchObject({
      labelStatus: 'pending',
      lb: null,
      resolutionStatus: null,
    });
    const relabelHash = store.getSession(sessionKey)!.contentHash!;
    const relabelRun = store.registerLabelRun({ sessionKey, contentHash: relabelHash, labelerRevision: revision, now: 7_500 });
    store.commitLabel({
      runId: relabelRun.runId,
      sessionKey,
      contentHash: relabelHash,
      labelerRevision: revision,
      lb: 'LB02',
      lp: 'LP05',
      resolutionStatus: 'resolved',
      confidence: 'high',
      needsReview: false,
      labeledAt: 7_600,
    });
    expect(store.list({ labelerRevision: 'older-revision' }).items[0]).toMatchObject({
      labelStatus: 'pending',
      lb: null,
      resolutionStatus: null,
    });
    store.markCaptureResult({ sessionKey, status: 'failed', error: 'temporary history failure', updatedAt: 7_700 });
    expect(store.list({ labelerRevision: revision }).items[0]).toMatchObject({ labelStatus: 'not_ready', lb: null });
    store.markCaptureResult({ sessionKey, status: 'captured', updatedAt: 7_800 });
    expect(store.list({ labelerRevision: revision }).items[0]).toMatchObject({
      labelStatus: 'labeled',
      lb: 'LB02',
      resolutionStatus: 'resolved',
    });
    expect(store.detail(publicId, { labelerRevision: revision })).toMatchObject({
      labelerRevision: revision,
      messages: expect.arrayContaining([expect.objectContaining({ platformMessageId: 'om-question' })]),
    });

    const currentHash = store.getSession(sessionKey)!.contentHash!;
    const staleRun = store.registerLabelRun({ sessionKey, contentHash: currentHash, labelerRevision: 'stale-revision', now: 8_000 });
    store.upsertMessages([message(sessionKey, 'om-new', 'assistant', '新的完整消息', {
      source: 'lark_history',
      responseKind: 'final',
    })], 9_000);
    store.markCaptureResult({ sessionKey, status: 'captured', updatedAt: 10_000 });
    expect(() => store.commitLabel({
      runId: staleRun.runId,
      sessionKey,
      contentHash: currentHash,
      labelerRevision: 'stale-revision',
      lb: 'LB01',
      lp: 'LP01',
      resolutionStatus: 'unknown',
      confidence: 'low',
      needsReview: true,
      labeledAt: 11_000,
    })).toThrow('analysis_label_content_stale');
    const verified = new DatabaseSync(store.path, { readOnly: true });
    expect((verified.prepare('SELECT status FROM label_runs WHERE run_id=?').get(staleRun.runId) as { status: string }).status)
      .toBe('expired');
    verified.close();
    store.close();
  });

  it('limits automatic attempts, recovers orphaned running rows, and prunes only old versions', async () => {
    const { store, sessionKey, contentHash } = await capturedStore();
    let now = 10_000;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const run = store.registerLabelRun({ sessionKey, contentHash, labelerRevision: revision, now });
      expect(run.attempt).toBe(attempt);
      store.failLabelRun({ runId: run.runId, error: `failure-${attempt}`, completedAt: now + 1 });
      now += 10;
    }
    expect(() => store.registerLabelRun({ sessionKey, contentHash, labelerRevision: revision, now }))
      .toThrow('analysis_label_attempt_limit');
    expect(store.labelRunState(sessionKey, contentHash, revision)).toMatchObject({
      attempts: 3,
      remainingAttempts: 0,
      completed: false,
      latestStatus: 'failed',
    });

    const stale = store.registerLabelRun({ sessionKey, contentHash, labelerRevision: 'revision-stale', now: 20_000 });
    expect(store.recoverStaleLabelRuns({ now: 20_000 + 60_000, staleAfterMs: 30_000 })).toEqual({ expired: 1 });
    const retry = store.registerLabelRun({ sessionKey, contentHash, labelerRevision: 'revision-stale', now: 81_000 });
    expect(retry).toMatchObject({ attempt: 2, outcome: 'created' });
    expect(stale.runId).not.toBe(retry.runId);

    const oldVersion = store.registerLabelRun({ sessionKey, contentHash, labelerRevision: 'revision-old', now: 1_000 });
    store.failLabelRun({ runId: oldVersion.runId, error: 'old', completedAt: 1_001 });
    store.upsertMessages([message(sessionKey, 'om-version-2', 'assistant', '内容版本二')], 90_000);
    store.markCaptureResult({ sessionKey, status: 'captured', updatedAt: 90_001 });
    const newHash = store.getSession(sessionKey)!.contentHash!;
    const current = store.registerLabelRun({ sessionKey, contentHash: newHash, labelerRevision: revision, now: 2_000 });
    store.failLabelRun({ runId: current.runId, error: 'current', completedAt: 2_001 });
    const cleanup = store.cleanupOldLabelRuns({ now: 31 * 24 * 60 * 60_000, retentionMs: 30 * 24 * 60 * 60_000 });
    expect(cleanup.deleted).toBeGreaterThanOrEqual(1);
    expect(store.labelRunState(sessionKey, newHash, revision)).toMatchObject({ attempts: 1, latestStatus: 'failed' });
    store.close();
  });

  it('keeps summary, trend, distributions, detail, and pagination read-only and consistent', async () => {
    const dataDir = await tempDir();
    const writable = new LogisticsAnalysisStore({ dataDir });
    const sessions = Array.from({ length: 55 }, (_, index) => session(identity({
      chatId: `chat-${index}`,
      rootMessageId: `root-${index}`,
    }), {
      title: `问题 ${index}`,
      botmuxSessionId: `bm-${index}`,
      createdAt: 1_000 + index,
      updatedAt: 2_000 + index,
    }));
    writable.syncSessions(sessions);
    const firstKey = buildLogisticsTopicKey(identity({ chatId: 'chat-0', rootMessageId: 'root-0' }));
    writable.upsertMessages([message(firstKey, 'om-0', 'user', '问题 0')], 3_000);
    writable.markCaptureResult({ sessionKey: firstKey, status: 'captured', updatedAt: 3_001 });
    writable.close();

    const path = join(dataDir, 'logistics-analysis.sqlite');
    const before = new DatabaseSync(path, { readOnly: true });
    const beforeCount = Number((before.prepare('SELECT COUNT(*) count FROM sessions').get() as { count: number }).count);
    before.close();
    const readOnly = new LogisticsAnalysisStore({ dataDir, readOnly: true });
    expect(readOnly.summary({ labelerRevision: revision })).toMatchObject({ totalTopics: 55, capturedTopics: 1, messages: 1 });
    expect(readOnly.list({ labelerRevision: revision })).toMatchObject({ total: 55, limit: 50, offset: 0, items: expect.any(Array) });
    expect(readOnly.list({ labelerRevision: revision }, { offset: 50 })).toMatchObject({ total: 55, limit: 50, offset: 50, items: expect.any(Array) });
    expect(readOnly.trend({ labelerRevision: revision })).toEqual(expect.arrayContaining([expect.objectContaining({ totalTopics: 55 })]));
    expect(readOnly.distributions({ labelerRevision: revision }).captureStatus).toEqual(expect.arrayContaining([
      { key: 'pending', count: 54 },
      { key: 'captured', count: 1 },
    ]));
    expect(readOnly.detail(readOnly.getSession(firstKey)!.publicId, { labelerRevision: revision })).toMatchObject({
      captureStatus: 'captured',
      labelStatus: 'pending',
      messages: [{ platformMessageId: 'om-0' }],
    });
    expect(() => readOnly.summary({} as never)).toThrow('analysis_labeler_revision_required');
    readOnly.close();
    const after = new DatabaseSync(path, { readOnly: true });
    expect(Number((after.prepare('SELECT COUNT(*) count FROM sessions').get() as { count: number }).count)).toBe(beforeCount);
    expect((after.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name))
      .toEqual(['label_runs', 'labels', 'messages', 'sessions']);
    after.close();
  });
});
