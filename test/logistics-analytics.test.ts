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

function record(): LogisticsSessionMasterRecord {
  return {
    masterKey: 'oc_chat:session-1', larkAppId: 'cli_logistics', sessionId: 'session-1',
    turnId: 'om_turn', surveyId: 'survey-1', settledSurveyIds: [], ratingCount: 0,
    chatId: 'oc_chat', rootMessageId: 'om_root', respondentOpenId: '', title: '会话',
    surveyStatus: 'scheduled', dueAt: 1, ratingState: 'awaiting',
    transcript: '用户：问\n助手：答', transcriptHash: 'a'.repeat(64), captureState: 'complete',
    messages: [{ role: 'user', content: '问' }, { role: 'assistant', content: '答' }],
    taggingState: 'tagged', businessCategory: 'LB02', problemType: 'LP01',
    resolutionStatus: 'resolved', overallConfidence: 'high', needsReview: false,
    modelAttempts: 1, baseSyncAttempts: 0, createdAt: 1_000, updatedAt: 2_000,
  };
}

describe('standalone logistics analytics server', () => {
  it('serves an authenticated overview page and read-only APIs', async () => {
    const dataDir = await tempDir();
    const store = new LogisticsConversationStore({ dataDir });
    store.upsert(record());
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
      const overview = await fetch(`${base}/api/overview`, { headers });
      expect(overview.status).toBe(200);
      await expect(overview.json()).resolves.toMatchObject({ conversations: 1, resolved: 1 });
      const page = await fetch(`${base}/overview`, { headers });
      expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(await page.text()).toContain('物流专家 · 数据概览');
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
