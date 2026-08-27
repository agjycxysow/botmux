import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLogisticsAnalyticsServer } from '../src/cli/logistics-analytics.js';
import { LogisticsConversationStore } from '../src/services/logistics-conversation-store.js';
import type { LogisticsSessionMasterRecord } from '../src/services/logistics-session-master.js';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'botmux-analytics-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function record(overrides: Partial<LogisticsSessionMasterRecord> = {}): LogisticsSessionMasterRecord {
  return {
    masterKey: 'oc_chat:session-1', larkAppId: 'cli_logistics', sessionId: 'session-1',
    turnId: 'om_turn', surveyId: 'survey-1', settledSurveyIds: [], ratingCount: 0,
    chatId: 'oc_chat', rootMessageId: 'om_root', respondentOpenId: '', title: '会话',
    surveyStatus: 'scheduled', dueAt: 1, ratingState: 'awaiting',
    transcript: '用户：问\n助手：答', transcriptHash: 'a'.repeat(64), captureState: 'complete',
    messages: [{ role: 'user', content: '问' }, { role: 'assistant', content: '答' }],
    taggingState: 'tagged', businessCategory: 'LB02', problemType: 'LP01',
    resolutionStatus: 'resolved', overallConfidence: 'high', needsReview: false,
    harnessRevision: 'c'.repeat(64),
    modelAttempts: 1, baseSyncAttempts: 0, createdAt: 1_000, updatedAt: 2_000,
    ...overrides,
  };
}

describe('standalone logistics analytics server', () => {
  it('serves an authenticated overview page and read-only APIs', async () => {
    const dataDir = await tempDir();
    const store = new LogisticsConversationStore({ dataDir });
    store.syncSessionCatalog([
      {
        larkAppId: 'cli_logistics', sessionId: 'session-1', chatId: 'oc_chat', rootMessageId: 'om_root',
        scope: 'thread', sessionStatus: 'active', title: '会话', createdAt: 1_000, lastMessageAt: 2_000,
      },
      {
        larkAppId: 'cli_logistics', sessionId: 'session-2', chatId: 'oc_chat_2', rootMessageId: 'om_root_2',
        scope: 'thread', sessionStatus: 'closed', title: '待回溯会话', createdAt: 3_000, lastMessageAt: 4_000,
      },
    ]);
    store.upsert(record());
    store.upsert(record({
      masterKey: 'oc_chat_3:session-3',
      sessionId: 'session-3',
      turnId: 'om_turn_3',
      surveyId: 'survey-3',
      chatId: 'oc_chat_3',
      rootMessageId: 'om_root_3',
      title: '仅助手消息',
      transcript: '助手：历史回复',
      transcriptHash: 'b'.repeat(64),
      messages: [{ role: 'assistant', content: '历史回复' }],
      businessCategory: 'LB99',
      problemType: 'LP99',
      updatedAt: 5_000,
    }));
    store.close();

    const server = createLogisticsAnalyticsServer({ dataDir, accessToken: 'secret' });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(`${base}/api/overview`)).status).toBe(401);
      const headers = { authorization: 'Bearer secret' };
      expect((await fetch(`${base}/favicon.ico`, { headers })).status).toBe(204);
      const overview = await fetch(`${base}/api/overview`, { headers });
      expect(overview.status).toBe(200);
      await expect(overview.json()).resolves.toMatchObject({
        totalSessions: 3, conversations: 1, labeled: 1, pendingBackfill: 1,
        surveyRecords: 0, answeredSurveys: 0,
        analysisCoverage: 1 / 3, labelCoverage: 1, resolved: 1,
      });
      const distributions = await fetch(`${base}/api/distributions`, { headers });
      await expect(distributions.json()).resolves.toMatchObject({
        business: [{ key: 'LB02', count: 1 }],
        problem: [{ key: 'LP01', count: 1 }],
        resolution: [{ key: 'resolved', count: 1 }],
      });
      const pending = await fetch(`${base}/api/sessions?dataStatus=pending`, { headers });
      await expect(pending.json()).resolves.toMatchObject({
        total: 1,
        items: [expect.objectContaining({ dataStatus: 'pending', title: '待回溯会话' })],
      });
      const page = await fetch(`${base}/overview`, { headers });
      expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      const pageText = await page.text();
      expect(pageText).toContain('物流专家 · 数据概览');
      expect(pageText).toContain('已解决问题');
      expect(pageText).toContain('分析覆盖率');
      expect(pageText).toContain('全部数据状态');
      expect(pageText).toContain('已采集');
      expect(pageText).toContain('电子面单 / 在线寄件');
      expect(pageText).toContain('LB / LP 枚举速查');
      const exchange = await fetch(`${base}/overview?t=secret`, {
        redirect: 'manual',
        headers: { 'x-forwarded-proto': 'https' },
      });
      expect(exchange.status).toBe(302);
      expect(exchange.headers.get('location')).toBe('/overview');
      expect(exchange.headers.get('set-cookie')).toContain('HttpOnly');
      expect(exchange.headers.get('set-cookie')).toContain('Secure');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
