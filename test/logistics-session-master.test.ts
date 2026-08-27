import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fallbackLogisticsTagging,
  LogisticsSessionMasterManager,
  normalizeLogisticsSessionMasterConfig,
  stableLogisticsSessionMasterKey,
} from '../src/services/logistics-session-master.js';
import type { FeedbackSurveyRecord } from '../src/services/feedback-survey.js';

const tempDirs: string[] = [];

async function makeDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), 'botmux-logistics-master-'));
  tempDirs.push(dataDir);
  return dataDir;
}

function survey(overrides: Partial<FeedbackSurveyRecord> = {}): FeedbackSurveyRecord {
  return {
    surveyId: 'survey-1',
    larkAppId: 'cli_logistics',
    sessionId: 'session-1',
    turnId: 'turn-1',
    chatId: 'oc_logistics',
    rootMessageId: 'om_root',
    respondentOpenId: 'ou_user',
    status: 'sent',
    scheduledAt: 1_000,
    dueAt: 2_000,
    sentAt: 2_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('logistics session master', () => {
  it('uses one master key per chat/session rather than creating one row per survey', () => {
    expect(stableLogisticsSessionMasterKey('cli_a', 'session-1', 'turn-1', 'oc_1'))
      .toBe(stableLogisticsSessionMasterKey('cli_a', 'session-1', 'turn-2', 'oc_1'));
    expect(stableLogisticsSessionMasterKey('cli_a', 'session-1', 'turn-1', 'oc_1'))
      .not.toBe(stableLogisticsSessionMasterKey('cli_a', 'session-1', 'turn-1', 'oc_2'));
  });

  it('uses a single overall confidence and keeps the fallback review-safe', () => {
    expect(fallbackLogisticsTagging('missing')).toMatchObject({
      businessCategory: 'LB99',
      problemType: 'LP99',
      resolutionStatus: 'unknown',
      overallConfidence: 'low',
      needsReview: true,
    });
  });


  it('creates a SQLite-backed row on final delivery without waiting for a survey card', async () => {
    const dataDir = await makeDataDir();
    const manager = new LogisticsSessionMasterManager({
      dataDir,
      larkAppId: 'cli_logistics',
      config: { enabled: true, modelTask: { enabled: true } },
      captureSession: vi.fn(async () => ({
        transcript: '用户：问\n助手：答',
        transcriptHash: 'd'.repeat(64),
        captureState: 'complete' as const,
        messageCount: 2,
        messages: [{ role: 'user' as const, content: '问' }, { role: 'assistant' as const, content: '答' }],
      })),
      runModelTask: vi.fn(async () => ({
        businessCategory: 'LB02', problemType: 'LP01', resolutionStatus: 'resolved' as const,
        overallConfidence: 'high' as const, needsReview: false,
      })),
    });
    manager.start();
    manager.noteTurnCompleted({
      larkAppId: 'cli_logistics', sessionId: 'session-final', turnId: 'om_turn',
      chatId: 'oc_final', rootMessageId: 'om_root', answerMessageId: 'om_answer', title: 'final',
    });
    await vi.waitFor(() => expect(manager.listRecords()[0]).toMatchObject({
      sessionId: 'session-final', taggingState: 'tagged', resolutionStatus: 'resolved',
    }));
    const { LogisticsConversationStore } = await import('../src/services/logistics-conversation-store.js');
    const store = new LogisticsConversationStore({ dataDir, readOnly: true });
    expect(store.summary()).toMatchObject({ conversations: 1, resolved: 1 });
    store.close();
    manager.stop();
  });

  it('writes once after dispatch and updates the same row when a rating arrives', async () => {
    const dataDir = await makeDataDir();
    const upsertBase = vi.fn(async () => ({ recordId: 'rec_master_1' }));
    const manager = new LogisticsSessionMasterManager({
      dataDir,
      larkAppId: 'cli_logistics',
      config: {
        enabled: true,
        larkBase: { appToken: 'base_token', tableId: 'tbl_master', identity: 'user' },
        modelTask: { enabled: true },
      },
      captureSession: vi.fn(async () => ({
        transcript: '用户：问\n助手：答',
        transcriptHash: 'a'.repeat(64),
        captureState: 'complete' as const,
        messageCount: 2,
      })),
      runModelTask: vi.fn(async () => ({
        businessCategory: 'LB02',
        problemType: 'LP03',
        resolutionStatus: 'resolved' as const,
        overallConfidence: 'medium' as const,
        needsReview: false,
      })),
      upsertBase,
    });
    manager.start();
    manager.noteSurveyDispatched(survey());
    await vi.waitFor(() => expect(upsertBase).toHaveBeenCalled());

    manager.noteSurveySettled(survey({
      status: 'answered',
      rating: 5,
      answeredAt: 3_000,
      updatedAt: 3_000,
    }));
    await vi.waitFor(() => expect(upsertBase.mock.calls.length).toBeGreaterThanOrEqual(2));

    const [record] = manager.listRecords();
    expect(manager.listRecords()).toHaveLength(1);
    expect(record).toMatchObject({
      baseRecordId: 'rec_master_1',
      rating: 5,
      ratingCount: 1,
      overallConfidence: 'medium',
      taggingState: 'tagged',
    });
    manager.stop();
  });

  it('queues the master-row write at dispatch before a slow capture completes', async () => {
    const dataDir = await makeDataDir();
    const upsertBase = vi.fn(async () => ({ recordId: 'rec_dispatched' }));
    const manager = new LogisticsSessionMasterManager({
      dataDir,
      larkAppId: 'cli_logistics',
      config: {
        enabled: true,
        larkBase: { appToken: 'base_token', tableId: 'tbl_master', identity: 'user' },
        modelTask: { enabled: true },
      },
      captureSession: vi.fn(() => new Promise<never>(() => undefined)),
      upsertBase,
    });
    manager.start();
    manager.noteSurveyDispatched(survey());
    await vi.waitFor(() => expect(upsertBase).toHaveBeenCalledTimes(1));
    expect(upsertBase.mock.calls[0]?.[0].record).toMatchObject({
      taggingState: 'pending_capture',
      surveyStatus: 'sent',
    });
    manager.stop();
  });

  it('degrades failed model work to the review-safe fallback without losing the master row', async () => {
    const dataDir = await makeDataDir();
    const manager = new LogisticsSessionMasterManager({
      dataDir,
      larkAppId: 'cli_logistics',
      config: {
        enabled: true,
        larkBase: { appToken: 'base_token', tableId: 'tbl_master', identity: 'user' },
        modelTask: { enabled: true },
      },
      captureSession: vi.fn(async () => ({
        transcript: '用户：问',
        transcriptHash: 'b'.repeat(64),
        captureState: 'complete' as const,
        messageCount: 1,
      })),
      runModelTask: vi.fn(async () => {
        throw new Error('model unavailable');
      }),
      upsertBase: vi.fn(async () => ({ recordId: 'rec_master_2' })),
    });
    manager.start();
    manager.noteSurveyDispatched(survey());
    await vi.waitFor(() => expect(manager.listRecords()[0]).toMatchObject({
      taggingState: 'needs_review',
      businessCategory: 'LB99',
      problemType: 'LP99',
      resolutionStatus: 'unknown',
      overallConfidence: 'low',
      needsReview: true,
    }));
    manager.stop();
  });

  it('serializes Base writes from concurrent session processing', async () => {
    const dataDir = await makeDataDir();
    let inFlight = 0;
    let maxInFlight = 0;
    const upsertBase = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 15));
      inFlight -= 1;
      return { recordId: `rec_${upsertBase.mock.calls.length}` };
    });
    const manager = new LogisticsSessionMasterManager({
      dataDir,
      larkAppId: 'cli_logistics',
      config: {
        enabled: true,
        larkBase: { appToken: 'base_token', tableId: 'tbl_master', identity: 'user' },
        modelTask: { enabled: true },
      },
      captureSession: vi.fn(async () => ({
        transcript: '用户：问\n助手：答',
        transcriptHash: 'c'.repeat(64),
        captureState: 'complete' as const,
        messageCount: 2,
      })),
      runModelTask: vi.fn(async () => ({
        businessCategory: 'LB02',
        problemType: 'LP03',
        resolutionStatus: 'unknown' as const,
        overallConfidence: 'medium' as const,
        needsReview: false,
      })),
      upsertBase,
    });
    manager.start();
    manager.noteSurveyDispatched(survey({ sessionId: 'session-a', chatId: 'oc_a' }));
    manager.noteSurveyDispatched(survey({ sessionId: 'session-b', chatId: 'oc_b' }));
    await vi.waitFor(() => expect(upsertBase.mock.calls.length).toBeGreaterThanOrEqual(4));
    expect(maxInFlight).toBe(1);
    manager.stop();
  });

  it('enables SQLite without requiring a Base binding', () => {
    expect(normalizeLogisticsSessionMasterConfig({ enabled: true })).toMatchObject({
      enabled: true,
      sqlite: { enabled: true },
      modelTask: { enabled: false },
    });
    expect(normalizeLogisticsSessionMasterConfig({
      enabled: true,
      sqlite: { enabled: false },
    }).enabled).toBe(false);
  });
});
