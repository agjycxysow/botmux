import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLogisticsAnalyticsServer } from '../src/cli/logistics-analytics.js';
import { buildLogisticsTopicKey } from '../src/services/logistics-analysis-topic.js';
import { LogisticsAnalysisStore } from '../src/services/logistics-analysis-store.js';

const require = createRequire(import.meta.url);
const CURRENT_REVISION = 'a'.repeat(64);
const OLD_REVISION = 'b'.repeat(64);
const resources: Array<{ dir: string; server?: ReturnType<typeof createLogisticsAnalyticsServer> }> = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'botmux-logistics-analytics-v1-'));
  resources.push({ dir });
  return dir;
}

async function closeServer(server: ReturnType<typeof createLogisticsAnalyticsServer>): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    if (resource.server) await closeServer(resource.server);
    await rm(resource.dir, { recursive: true, force: true });
  }
});

interface SeededData {
  dbPath: string;
  topicPublicIds: Record<number, string>;
}

function addSession(
  store: LogisticsAnalysisStore,
  index: number,
  status: 'pending' | 'running' | 'captured' | 'partial' | 'failed',
  label?: { revision: string; lb: string; lp: string; resolutionStatus: 'resolved' | 'in_progress' | 'unknown'; needsReview?: boolean; runStatus?: 'running' | 'failed' },
): string {
  const base = Date.parse('2025-01-01T00:00:00+08:00') + index * 24 * 60 * 60_000;
  const botId = index === 3 ? 'cli_logistics_alt' : 'cli_logistics';
  const sessionKey = buildLogisticsTopicKey({ botId, chatId: `chat-${index}`, rootMessageId: `root-${index}` });
  store.syncSessions([{
    sessionKey,
    botId,
    botName: index === 3 ? '物流助手 B' : '物流助手 A',
    chatId: `chat-${index}`,
    chatName: `物流测试群 ${index}`,
    scope: 'thread',
    rootMessageId: `root-${index}`,
    title: index === 3 ? '<script>alert(1)</script>异常话题' : `测试话题 ${index}`,
    createdAt: base,
    lastMessageAt: base + 1_000,
    updatedAt: base + 2_000,
  }]);
  if (status === 'captured' || status === 'partial') {
    store.upsertMessages([
      {
        sessionKey,
        platformMessageId: `user-${index}`,
        role: 'user',
        senderName: '脱敏用户',
        content: index === 3 ? '<script>alert("message")</script> 发货问题' : `用户问题 ${index}`,
        occurredAt: base,
        source: 'lark_history',
      },
      {
        sessionKey,
        platformMessageId: `assistant-${index}`,
        role: 'assistant',
        senderName: '物流助手',
        content: `助手答复 ${index}`,
        occurredAt: base + 1_000,
        responseKind: 'final',
        source: 'codex_rollout',
      },
    ], base + 2_000);
  }
  store.markCaptureResult({ sessionKey, status, updatedAt: base + 3_000 });
  if (label) {
    const current = store.getSession(sessionKey)!;
    const contentHash = current.contentHash!;
    const run = store.registerLabelRun({
      sessionKey,
      contentHash,
      labelerRevision: label.revision,
      now: base + 4_000,
    });
    if (label.runStatus === 'running') return current.publicId;
    if (label.runStatus === 'failed') {
      store.failLabelRun({ runId: run.runId, error: 'fixture_failure', completedAt: base + 5_000 });
    } else {
      store.commitLabel({
        runId: run.runId,
        sessionKey,
        contentHash,
        labelerRevision: label.revision,
        lb: label.lb,
        lp: label.lp,
        resolutionStatus: label.resolutionStatus,
        confidence: 'high',
        needsReview: label.needsReview ?? false,
        labelReason: 'fixture',
        labeledAt: base + 5_000,
      });
    }
  }
  return store.getSession(sessionKey)!.publicId;
}

async function seed(): Promise<SeededData> {
  const dir = await tempDir();
  const dbPath = join(dir, 'logistics-analysis.sqlite');
  const store = new LogisticsAnalysisStore({ dataDir: dir, path: dbPath });
  const topicPublicIds: Record<number, string> = {};
  topicPublicIds[1] = addSession(store, 1, 'captured', {
    revision: CURRENT_REVISION, lb: 'LB02', lp: 'LP01', resolutionStatus: 'resolved',
  });
  topicPublicIds[2] = addSession(store, 2, 'captured', {
    revision: OLD_REVISION, lb: 'LB03', lp: 'LP02', resolutionStatus: 'resolved',
  });
  topicPublicIds[3] = addSession(store, 3, 'captured', {
    revision: CURRENT_REVISION, lb: 'LB99', lp: 'LP99', resolutionStatus: 'unknown', needsReview: true,
  });
  topicPublicIds[4] = addSession(store, 4, 'captured', {
    revision: CURRENT_REVISION, lb: 'LB04', lp: 'LP05', resolutionStatus: 'in_progress', runStatus: 'running',
  });
  topicPublicIds[5] = addSession(store, 5, 'captured', {
    revision: CURRENT_REVISION, lb: 'LB05', lp: 'LP04', resolutionStatus: 'unknown', runStatus: 'failed',
  });
  topicPublicIds[6] = addSession(store, 6, 'partial');
  topicPublicIds[7] = addSession(store, 7, 'failed');
  topicPublicIds[8] = addSession(store, 8, 'pending');
  topicPublicIds[9] = addSession(store, 9, 'running');
  for (let index = 10; index <= 58; index += 1) addSession(store, index, 'pending');
  store.close();
  return { dbPath, topicPublicIds };
}

async function startServer(data: SeededData, token = 'secret') {
  const dir = resources.find(resource => data.dbPath.startsWith(resource.dir))!.dir;
  const server = createLogisticsAnalyticsServer({
    dataDir: dir,
    databasePath: data.dbPath,
    accessToken: token,
    labelerRevision: CURRENT_REVISION,
  });
  resources.find(resource => resource.dir === dir)!.server = server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing_address');
  return `http://127.0.0.1:${address.port}`;
}

describe('standalone logistics analytics v1 server', () => {
  it('serves the four-table overview with current-revision filters, paging, auth, and safe detail', async () => {
    const data = await seed();
    const before = readFileSync(data.dbPath);
    const base = await startServer(data);
    const headers = { authorization: 'Bearer secret' };

    expect((await fetch(`${base}/api/overview`)).status).toBe(401);
    expect((await fetch(`${base}/healthz`, { headers })).status).toBe(200);
    await expect((await fetch(`${base}/api/overview`, { headers })).json()).resolves.toMatchObject({
      totalTopics: 58,
      capturedTopics: 5,
      labeledTopics: 2,
      resolved: 1,
      unknown: 1,
      needsReview: 1,
      capturePartial: 1,
      captureFailed: 1,
    });

    const page = await fetch(`${base}/api/sessions?limit=50&offset=50`, { headers });
    await expect(page.json()).resolves.toMatchObject({ total: 58, limit: 50, offset: 50, items: expect.any(Array) });
    const exactPage = await fetch(`${base}/api/sessions?dataStatus=missing_turn`, { headers });
    await expect(exactPage.json()).resolves.toMatchObject({ total: 1, items: [expect.objectContaining({ captureStatus: 'partial' })] });
    const failed = await fetch(`${base}/api/sessions?dataStatus=history_failed`, { headers });
    await expect(failed.json()).resolves.toMatchObject({ total: 1, items: [expect.objectContaining({ captureStatus: 'failed' })] });
    const running = await fetch(`${base}/api/sessions?dataStatus=processing`, { headers });
    await expect(running.json()).resolves.toMatchObject({ total: 1, items: [expect.objectContaining({ captureStatus: 'running' })] });
    const labels = await fetch(`${base}/api/sessions?labelStatus=labeled&lb=LB99&lp=LP99&resolution=unknown&needsReview=true`, { headers });
    await expect(labels.json()).resolves.toMatchObject({ total: 1, items: [expect.objectContaining({ lb: 'LB99', lp: 'LP99', resolutionStatus: 'unknown', labelStatus: 'labeled' })] });
    const oldRevision = await fetch(`${base}/api/sessions?labelStatus=pending`, { headers });
    await expect(oldRevision.json()).resolves.toMatchObject({ total: 1, items: [expect.objectContaining({ labelStatus: 'pending', lb: null, lp: null })] });
    const combined = await fetch(`${base}/api/sessions?dataStatus=captured&labelStatus=pending`, { headers });
    await expect(combined.json()).resolves.toMatchObject({ total: 1 });

    for (const query of ['limit=0', 'offset=-1', 'from=2020-01-01&to=2022-01-01', 'needsReview=maybe', 'dataStatus=skipped']) {
      expect((await fetch(`${base}/api/sessions?${query}`, { headers })).status).toBe(400);
    }

    const detailResponse = await fetch(`${base}/api/sessions/${data.topicPublicIds[3]}`, { headers });
    const detailText = await detailResponse.text();
    expect(detailResponse.status).toBe(200);
    expect(detailText).not.toContain('<script>');
    expect(detailText).toContain('\\u003cscript\\u003e');
    const detail = JSON.parse(detailText) as Record<string, unknown>;
    expect(detail).toMatchObject({ lb: 'LB99', lp: 'LP99', resolutionStatus: 'unknown' });
    for (const forbidden of ['sessionKey', 'cliSessionId', 'messageKey', 'labelRuns', 'platformMessageId', 'source', 'larkMessageUrl']) {
      expect(detail).not.toHaveProperty(forbidden);
    }
    expect(Object.keys((detail.messages as Array<Record<string, unknown>>)[0]!)).toEqual(['role', 'content', 'occurredAt']);

    const html = await fetch(`${base}/overview`, { headers });
    const htmlText = await html.text();
    expect(html.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(htmlText).toContain('物流专家 · 会话概览');
    expect(htmlText).toContain('标签处理状态');
    expect(htmlText).toContain('全部历史');
    for (const forbidden of ['满意度', '问卷', '人效', '人工改标', '原话题']) {
      expect(htmlText).not.toContain(forbidden);
    }

    const exchange = await fetch(`${base}/overview?t=secret`, {
      redirect: 'manual',
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(exchange.status).toBe(302);
    expect(exchange.headers.get('location')).toBe('/overview');
    expect(exchange.headers.get('set-cookie')).toContain('HttpOnly');
    expect(exchange.headers.get('set-cookie')).toContain('Secure');

    await closeServer(resources.find(resource => data.dbPath.startsWith(resource.dir))!.server!);
    resources.find(resource => data.dbPath.startsWith(resource.dir))!.server = undefined;
    expect(readFileSync(data.dbPath).equals(before)).toBe(true);
  });

  it('returns unavailable, partial, and invalid run-state projections without writing the status file', async () => {
    const data = await seed();
    const base = await startServer(data);
    const headers = { authorization: 'Bearer secret' };
    const statusPath = `${data.dbPath}.run.json`;

    await expect((await fetch(`${base}/api/status`, { headers })).json()).resolves.toEqual({
      available: false,
      message: '尚无调度记录/状态不可用',
    });
    await writeFile(statusPath, JSON.stringify({
      schemaVersion: 1,
      status: 'partial',
      startedAt: 1_000,
      finishedAt: 2_000,
      lastSuccessfulSyncAt: 1_500,
      lastSuccessfulCaptureAt: 1_600,
      lastSuccessfulLabelAt: 1_700,
      pendingCapture: 3,
      pendingLabel: 4,
      errorCode: 'label_failed',
      internalSecret: 'must_not_project',
    }));
    const partial = await fetch(`${base}/api/status`, { headers });
    await expect(partial.json()).resolves.toEqual({
      available: true,
      schemaVersion: 1,
      status: 'partial',
      startedAt: 1_000,
      finishedAt: 2_000,
      lastSuccessfulSyncAt: 1_500,
      lastSuccessfulCaptureAt: 1_600,
      lastSuccessfulLabelAt: 1_700,
      pendingCapture: 3,
      pendingLabel: 4,
      errorCode: 'label_failed',
    });
    await writeFile(statusPath, '{not-json');
    await expect((await fetch(`${base}/api/status`, { headers })).json()).resolves.toEqual({
      available: false,
      message: '尚无调度记录/状态不可用',
    });
  });

  it('rejects missing revisions and old v5 databases without migration', async () => {
    const data = await seed();
    const dir = resources.find(resource => data.dbPath.startsWith(resource.dir))!.dir;
    expect(() => createLogisticsAnalyticsServer({ dataDir: dir, databasePath: data.dbPath })).toThrow('analysis_labeler_revision_required');
    expect(() => createLogisticsAnalyticsServer({ dataDir: dir, databasePath: data.dbPath, host: '0.0.0.0', labelerRevision: CURRENT_REVISION })).toThrow('BOTMUX_ANALYTICS_TOKEN is required');

    const oldPath = join(dir, 'old-v5.sqlite');
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const oldDb = new DatabaseSync(oldPath);
    oldDb.exec('CREATE TABLE conversations (id TEXT); CREATE TABLE conversation_messages (id TEXT); CREATE TABLE session_catalog (id TEXT); CREATE TABLE conversation_labels (id TEXT); PRAGMA user_version=5;');
    oldDb.close();
    expect(() => createLogisticsAnalyticsServer({ dataDir: dir, databasePath: oldPath, labelerRevision: CURRENT_REVISION })).toThrow('analytics_database_unsupported_four_table_only');
  });
});
