import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  captureLogisticsAnalysis,
  labelLogisticsAnalysis,
  type LogisticsAnalysisCollectionBot,
  type LogisticsAnalysisCollectionDeps,
} from '../src/cli/logistics-analysis-collection.js';
import {
  buildLogisticsTopicKey,
} from '../src/services/logistics-analysis-topic.js';
import { LogisticsAnalysisStore } from '../src/services/logistics-analysis-store.js';
import type { Session } from '../src/types.js';

const bot: LogisticsAnalysisCollectionBot = { larkAppId: 'cli_logistics', cliId: 'codex' };
const revision = 'b'.repeat(64);
const oldAt = 1_700_000_000_000;
const trustedAnswer = '可信恢复答案：' + '已根据订单、履约和发货状态完成核查。'.repeat(8);

function makeSession(rootMessageId = 'om_root'): Session {
  return {
    sessionId: 'session-1',
    chatId: 'oc_chat',
    rootMessageId,
    scope: 'thread',
    title: '物流问题',
    status: 'closed',
    createdAt: new Date(oldAt - 60 * 60_000).toISOString(),
    lastMessageAt: new Date(oldAt).toISOString(),
    larkAppId: bot.larkAppId,
    cliId: 'codex',
  } as Session;
}

function larkHistory(answer = '工作中，请稍候', extra: unknown[] = []) {
  return [
    {
      message_id: 'om_user',
      msg_type: 'text',
      body: { content: '请查询发货状态' },
      sender: { id: 'ou_user', sender_type: 'user' },
      create_time: String(oldAt - 20 * 60_000),
    },
    {
      message_id: 'om_answer',
      msg_type: 'text',
      body: { content: answer },
      sender: { id: bot.larkAppId, sender_type: 'app' },
      create_time: String(oldAt),
    },
    ...extra,
  ];
}

function larkHistoryWithoutAnswer(extra: unknown[] = []) {
  return larkHistory('工作中，请稍候', extra).filter(item => (
    typeof item === 'object' && item !== null && (item as { message_id?: unknown }).message_id !== 'om_answer'
  ));
}

function paths() {
  const dataDir = mkdtempSync(join(tmpdir(), 'logistics-analysis-source-recovery-'));
  return { dataDir, dbPath: join(dataDir, 'logistics-analysis.sqlite') };
}

function sourceDeps(
  sourceSession: Session,
  fetchHistory: LogisticsAnalysisCollectionDeps['fetchThreadMessages'],
  onModel?: () => void,
): LogisticsAnalysisCollectionDeps {
  return {
    loadSessions: () => new Map([[sourceSession.sessionId, sourceSession]]),
    fetchThreadMessages: fetchHistory,
    resolveAnswer: () => undefined,
    findDaemon: () => null,
    inspectQueue: () => ({ known: true, pending: false }),
    resolveHarnessRevision: () => revision,
    createModelRunner: () => async () => {
      onModel?.();
      return {
        businessCategory: 'LB02',
        problemType: 'LP01',
        resolutionStatus: 'resolved',
        overallConfidence: 'high',
        needsReview: false,
      };
    },
  };
}

function seedTrustedCandidate(dataDir: string, dbPath: string, sourceSession: Session): string {
  const sessionKey = buildLogisticsTopicKey({
    botId: bot.larkAppId,
    chatId: sourceSession.chatId,
    rootMessageId: sourceSession.rootMessageId,
  });
  const store = new LogisticsAnalysisStore({ dataDir, path: dbPath });
  try {
    store.syncSessions([{
      sessionKey,
      botmuxSessionId: sourceSession.sessionId,
      botId: bot.larkAppId,
      chatId: sourceSession.chatId,
      scope: 'thread',
      rootMessageId: sourceSession.rootMessageId,
      sessionStatus: 'closed',
      createdAt: oldAt - 60 * 60_000,
      lastMessageAt: oldAt,
      updatedAt: oldAt,
    }]);
    store.upsertMessages([
      {
        sessionKey,
        platformMessageId: 'om_user',
        role: 'user',
        content: '请查询发货状态',
        occurredAt: oldAt - 20 * 60_000,
        source: 'lark_history',
      },
      {
        sessionKey,
        platformMessageId: 'om_answer',
        role: 'assistant',
        content: '工作中，请稍候',
        occurredAt: oldAt,
        source: 'lark_history',
      },
    ], oldAt);
    store.upsertMessages([{
      sessionKey,
      platformMessageId: 'om_answer',
      role: 'assistant',
      content: trustedAnswer,
      occurredAt: oldAt,
      responseKind: 'final',
      source: 'codex_rollout',
    }], oldAt + 1);
    store.markCaptureResult({ sessionKey, status: 'captured', updatedAt: oldAt + 2 });
  } finally {
    store.close();
  }
  return sessionKey;
}

async function labelWithCurrentHistory(
  answer: string,
  extra: unknown[] = [],
  omitAnswer = false,
) {
  const { dataDir, dbPath } = paths();
  const sourceSession = makeSession();
  const sessionKey = seedTrustedCandidate(dataDir, dbPath, sourceSession);
  let modelCalls = 0;
  const deps = sourceDeps(sourceSession, async () => (
    omitAnswer ? larkHistoryWithoutAnswer(extra) : larkHistory(answer, extra)
  ), () => { modelCalls += 1; });
  const result = await labelLogisticsAnalysis({
    dataDir,
    dbPath,
    bot,
    apply: true,
    harnessRoot: '/fixture',
    now: oldAt + 30 * 60_000,
  }, deps);
  return { dataDir, dbPath, sessionKey, result, modelCalls };
}

describe('logistics analysis source recovery alignment', () => {
  it('keeps the trusted recovery during capture and labels when fresh Lark is a placeholder', async () => {
    const { dataDir, dbPath } = paths();
    const sourceSession = makeSession();
    const sessionKey = seedTrustedCandidate(dataDir, dbPath, sourceSession);
    const deps = sourceDeps(sourceSession, async () => larkHistory());
    await captureLogisticsAnalysis({ dataDir, dbPath, bot, apply: true, now: oldAt + 30 * 60_000 }, deps);
    const afterCapture = new LogisticsAnalysisStore({ dataDir, path: dbPath, readOnly: true });
    try {
      expect(afterCapture.getMessages(sessionKey).find(message => message.platformMessageId === 'om_answer')?.content)
        .toBe(trustedAnswer);
    } finally {
      afterCapture.close();
    }

    let modelCalls = 0;
    const result = await labelLogisticsAnalysis({
      dataDir,
      dbPath,
      bot,
      apply: true,
      harnessRoot: '/fixture',
      now: oldAt + 30 * 60_000,
    }, sourceDeps(sourceSession, async () => larkHistory(), () => { modelCalls += 1; }));
    expect(result.labeled).toBe(1);
    expect(result.gateSkipped).toBe(0);
    expect(modelCalls).toBe(1);
  });

  it('rejects a meaningful replacement under the same platform message id', async () => {
    const { result, modelCalls } = await labelWithCurrentHistory('新的真实答案');
    expect(result.labeled).toBe(0);
    expect(result.gateSkipped).toBe(1);
    expect(result.failures[0]?.code).toBe('source_snapshot_stale');
    expect(modelCalls).toBe(0);
  });

  it('rejects when the trusted platform message disappears from fresh history', async () => {
    const { result, modelCalls } = await labelWithCurrentHistory('工作中，请稍候', [], true);
    expect(result.labeled).toBe(0);
    expect(result.gateSkipped).toBe(1);
    expect(result.failures[0]?.code).toBe('source_snapshot_stale');
    expect(modelCalls).toBe(0);
  });

  it('rejects when fresh history adds a new platform message', async () => {
    const { result, modelCalls } = await labelWithCurrentHistory('工作中，请稍候', [{
      message_id: 'om_new',
      msg_type: 'text',
      body: { content: '补充问题' },
      sender: { id: 'ou_user', sender_type: 'user' },
      create_time: String(oldAt + 1_000),
    }]);
    expect(result.labeled).toBe(0);
    expect(result.gateSkipped).toBe(1);
    expect(result.failures[0]?.code).toBe('source_snapshot_stale');
    expect(modelCalls).toBe(0);
  });
});
