import { writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LogisticsConversationStore } from '../src/services/logistics-conversation-store.js';
import type { LogisticsSessionMasterRecord } from '../src/services/logistics-session-master.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'botmux-conversation-store-'));
  dirs.push(dir);
  return dir;
}

function record(overrides: Partial<LogisticsSessionMasterRecord> = {}): LogisticsSessionMasterRecord {
  return {
    masterKey: 'oc_chat:session-1',
    larkAppId: 'cli_logistics',
    sessionId: 'session-1',
    turnId: 'om_turn',
    surveyId: 'survey-1',
    settledSurveyIds: [],
    ratingCount: 1,
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    respondentOpenId: 'ou_private',
    title: '发货问题排查',
    answerMessageId: 'om_answer',
    surveyStatus: 'answered',
    dueAt: 1_000,
    sentAt: 2_000,
    rating: 5,
    answeredAt: 3_000,
    ratingState: 'rated',
    transcript: '用户：问题\n助手：回答',
    transcriptHash: 'a'.repeat(64),
    captureState: 'complete',
    messages: [
      { role: 'user', content: '问题', messageId: 'om_turn', createdAt: 1_000 },
      { role: 'assistant', content: '回答', messageId: 'om_answer', createdAt: 2_000 },
    ],
    taggingState: 'tagged',
    businessCategory: 'LB02',
    problemType: 'LP05',
    resolutionStatus: 'resolved',
    overallConfidence: 'high',
    needsReview: false,
    harnessRevision: 'b'.repeat(64),
    businessReasonCode: 'primary_domain_fulfillment',
    problemReasonCode: 'incident_diagnosis_requested',
    resolutionReasonCode: 'evidence_backed_root_cause_delivered',
    evidenceAnchors: [
      { role: 'goal', messageIndex: 0 },
      { role: 'outcome', messageIndex: 1 },
    ],
    manualReviewStatus: 'pending',
    modelAttempts: 1,
    baseSyncAttempts: 0,
    createdAt: Date.parse('2026-08-20T00:00:00+08:00'),
    updatedAt: Date.parse('2026-08-20T01:00:00+08:00'),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('logistics conversation SQLite store', () => {
  it('persists current projections, immutable snapshots, labels and analytics', async () => {
    const dataDir = await tempDir();
    const store = new LogisticsConversationStore({ dataDir });
    store.upsert(record());
    store.upsert(record({
      masterKey: 'oc_chat:session-2',
      sessionId: 'session-2',
      turnId: 'om_turn_2',
      title: '订单接口定位',
      transcriptHash: 'c'.repeat(64),
      rating: undefined,
      ratingCount: 0,
      ratingState: 'awaiting',
      businessCategory: 'LB03',
      problemType: 'LP03',
      resolutionStatus: 'unknown',
      overallConfidence: 'low',
      needsReview: true,
      reviewReason: '证据不足',
      updatedAt: Date.parse('2026-08-21T01:00:00+08:00'),
    }));

    expect(store.summary()).toMatchObject({
      conversations: 2,
      messages: 4,
      resolved: 1,
      unknown: 1,
      needsReview: 1,
      rated: 1,
      averageRating: 5,
      resolutionRate: 0.5,
    });
    expect(store.trend()).toEqual([
      expect.objectContaining({ day: '2026-08-20', conversations: 1, resolved: 1 }),
      expect.objectContaining({ day: '2026-08-21', conversations: 1, resolved: 0 }),
    ]);
    expect(store.distributions().business).toEqual(expect.arrayContaining([
      { key: 'LB02', count: 1 },
      { key: 'LB03', count: 1 },
    ]));
    expect(store.list({ needsReview: true }).items).toHaveLength(1);
    expect(store.list().items[0]).not.toHaveProperty('sessionId');
    expect(store.list().items[0]).not.toHaveProperty('chatId');
    expect(store.detail('oc_chat:session-1')).toBeUndefined();
    expect(store.detail('conv_21c9e882b55ee6e94b898e21d3ce80d5')).toMatchObject({
      harnessRevision: 'b'.repeat(64),
      manualReviewStatus: 'pending',
      messages: [
        { role: 'user', content: '问题', createdAt: 1_000 },
        { role: 'assistant', content: '回答', createdAt: 2_000 },
      ],
      snapshots: [expect.objectContaining({ captureState: 'complete' })],
    });
    store.close();
  });

  it('imports legacy JSON idempotently and maps unresolved to review-safe unknown', async () => {
    const dataDir = await tempDir();
    const legacyDir = join(dataDir, 'logistics-session-master');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(legacyDir, { recursive: true }));
    await writeFile(join(legacyDir, 'cli_logistics.json'), JSON.stringify({
      version: 1,
      records: [{ ...record(), resolutionStatus: 'unresolved', needsReview: false }],
    }));
    const store = new LogisticsConversationStore({ dataDir });
    expect(store.importLegacyJson(dataDir, 'cli_logistics')).toEqual({ files: 1, records: 1 });
    expect(store.importLegacyJson(dataDir, 'cli_logistics')).toEqual({ files: 1, records: 1 });
    expect(store.detail('conv_21c9e882b55ee6e94b898e21d3ce80d5')).toMatchObject({
      resolutionStatus: 'unknown',
      needsReview: true,
      reviewReason: expect.stringContaining('迁移'),
    });
    store.close();
  });
});
