import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  captureLogisticsAnalysis,
  checkLogisticsAnalysisLabelGate,
  paginateLogisticsAnalysisTopics,
  peekLogisticsAnalysisQueue,
  runLogisticsAnalysis,
  type LogisticsAnalysisCollectionBot,
  type LogisticsAnalysisCollectionDeps,
} from '../src/cli/logistics-analysis-collection.js';
import { LogisticsAnalysisStore } from '../src/services/logistics-analysis-store.js';
import type { Session } from '../src/types.js';

const bot: LogisticsAnalysisCollectionBot = {
  larkAppId: 'cli_logistics',
  cliId: 'codex',
};

const oldAt = 1_700_000_000_000;
const revision = 'a'.repeat(64);

function session(
  sessionId: string,
  rootMessageId = 'om_root',
  status: Session['status'] = 'closed',
  extra: Partial<Session> = {},
): Session {
  return {
    sessionId,
    chatId: 'oc_chat',
    rootMessageId,
    scope: 'thread',
    title: '物流问题',
    status,
    createdAt: new Date(oldAt - 60 * 60_000).toISOString(),
    lastMessageAt: new Date(oldAt).toISOString(),
    larkAppId: bot.larkAppId,
    cliId: 'codex',
    ...extra,
  } as Session;
}

function history(answer = '已完成处理') {
  return [
    { message_id: 'om_user', msg_type: 'text', body: { content: '请查询发货状态' }, sender: { id: 'ou_user', sender_type: 'user', sender_name: '用户' }, create_time: String(oldAt - 20 * 60_000) },
    { message_id: 'om_answer', msg_type: 'text', body: { content: answer }, sender: { id: 'cli_logistics', sender_type: 'app', sender_name: '物流 Bot' }, create_time: String(oldAt) },
  ];
}

function baseDeps(
  sessions: Session[],
  fetchHistory: LogisticsAnalysisCollectionDeps['fetchThreadMessages'],
  overrides: LogisticsAnalysisCollectionDeps = {},
): LogisticsAnalysisCollectionDeps {
  return {
    loadSessions: () => new Map(sessions.map(item => [item.sessionId, item])),
    fetchThreadMessages: fetchHistory,
    resolveAnswer: () => undefined,
    findDaemon: () => null,
    inspectQueue: () => ({ known: true, pending: false }),
    resolveHarnessRevision: () => revision,
    createModelRunner: () => async () => ({
      businessCategory: 'LB02',
      problemType: 'LP01',
      resolutionStatus: 'resolved',
      overallConfidence: 'high',
      needsReview: false,
    }),
    now: () => oldAt + 30 * 60_000,
    ...overrides,
  };
}

function paths() {
  const dataDir = mkdtempSync(join(tmpdir(), 'logistics-analysis-collection-'));
  return { dataDir, dbPath: join(dataDir, 'logistics-analysis.sqlite') };
}

function writeMarker(dataDir: string, sessionId: string) {
  mkdirSync(join(dataDir, 'turn-sends'), { recursive: true });
  writeFileSync(join(dataDir, 'turn-sends', `${sessionId}.jsonl`), `${JSON.stringify({
    messageId: 'om_answer',
    sentAtMs: oldAt,
    previewText: '工作中',
    contentLength: 3,
  })}\n`);
}
describe('logistics analysis collection', () => {
  it('groups multiple BotMux sessions into one topic and fetches visible history once', async () => {
    const { dataDir, dbPath } = paths();
    const sessions = [session('session-a'), session('session-b')];
    let historyCalls = 0;
    let recoveryCalls = 0;
    const result = await captureLogisticsAnalysis({ dataDir, dbPath, bot, apply: true, now: oldAt + 30 * 60_000 }, baseDeps(
      sessions,
      async () => { historyCalls += 1; return history(); },
      {
        resolveAnswer: (item) => {
          recoveryCalls += 1;
          return {
            content: item.sessionId === 'session-a' ? '来自旧运行的完整答案 A' : '来自新运行的完整答案 B',
            source: 'codex_assistant_final',
            occurredAt: oldAt,
          };
        },
      },
    ));
    expect(result.processed).toBe(1);
    expect(result.partial).toBe(1);
    expect(historyCalls).toBe(1);
    expect(recoveryCalls).toBe(2);

    const store = new LogisticsAnalysisStore({ dataDir, path: dbPath, readOnly: true });
    try {
      const rows = store.getMessages(result.page.candidates[0]!.sessionKey);
      expect(rows.map(row => row.content)).toEqual(expect.arrayContaining([
        '请查询发货状态',
        '已完成处理',
        '来自旧运行的完整答案 A',
        '来自新运行的完整答案 B',
      ]));
    } finally {
      store.close();
    }
  });

  it('keeps the source boundary based on visible Lark times, not BotMux lastMessageAt', async () => {
    const { dataDir, dbPath } = paths();
    const source = session('active', 'om_silent', 'active', { lastMessageAt: new Date(oldAt + 2 * 60 * 60_000).toISOString() });
    let modelCalls = 0;
    const deps = baseDeps([source], async () => history(), {
      findDaemon: () => ({ larkAppId: bot.larkAppId, ipcPort: 17950 }),
      fetchRuntimeSession: async () => ({ httpStatus: 200, body: { session: { status: 'working', queued: false, pendingRepo: false } } }),
      createModelRunner: () => async () => {
        modelCalls += 1;
        return { businessCategory: 'LB02', problemType: 'LP01', resolutionStatus: 'resolved', overallConfidence: 'high', needsReview: false };
      },
    });
    const result = await runLogisticsAnalysis({ dataDir, dbPath, bot, apply: true, harnessRoot: '/fixture', now: oldAt + 30 * 60_000 }, deps);
    expect(result.status).toBe('partial');
    expect((result.label as { gateSkipped?: number }).gateSkipped).toBe(1);
    expect(modelCalls).toBe(0);
  });

  it('rejects unknown runtime state and unread queue without consuming its offset', async () => {
    const { dataDir } = paths();
    const root = 'om_queue';
    const queuePath = join(dataDir, 'queues', `${root}.jsonl`);
    const offsetPath = join(dataDir, 'queues', `${root}.offset`);
    const queueText = '你好🙂\n';
    mkdirSync(join(dataDir, 'queues'));
    writeFileSync(queuePath, queueText);
    writeFileSync(offsetPath, String(queueText.length));
    const closed = session('closed', root);
    const allowed = await checkLogisticsAnalysisLabelGate(
      { dataDir, botId: bot.larkAppId, now: oldAt + 30 * 60_000, group: { sessions: [closed], rootMessageId: root } },
      { findDaemon: () => null },
      oldAt,
    );
    expect(allowed.allowed).toBe(true);
    expect(readFileSync(offsetPath, 'utf8')).toBe(String(queueText.length));

    writeFileSync(queuePath, `${queueText}未消费`);
    expect(peekLogisticsAnalysisQueue(dataDir, root)).toMatchObject({ known: true, pending: true });
    const pending = await checkLogisticsAnalysisLabelGate(
      { dataDir, botId: bot.larkAppId, now: oldAt + 30 * 60_000, group: { sessions: [closed], rootMessageId: root } },
      { findDaemon: () => null },
      oldAt,
    );
    expect(pending.allowed).toBe(true);
    expect(pending.reason).toBeUndefined();
    expect(readFileSync(offsetPath, 'utf8')).toBe(String(queueText.length));

    writeFileSync(offsetPath, String(queueText.length + 100));
    expect(peekLogisticsAnalysisQueue(dataDir, root)).toMatchObject({ known: false, pending: false });

    const active = session('active', root, 'active');
    const unknown = await checkLogisticsAnalysisLabelGate(
      { dataDir, botId: bot.larkAppId, now: oldAt + 30 * 60_000, group: { sessions: [active], rootMessageId: root } },
      {
        findDaemon: () => ({ larkAppId: bot.larkAppId, ipcPort: 17950 }),
        fetchRuntimeSession: async () => ({ httpStatus: 200, body: { session: { status: 'mystery' } } }),
        inspectQueue: () => ({ known: true, pending: false }),
      },
      oldAt,
    );
    expect(unknown.allowed).toBe(false);
    expect(unknown.reason).toBe('runtime_state_unknown');
  });

  it('keeps all sessions in a prefix-selected topic for recovery and the busy gate', async () => {
    const { dataDir, dbPath } = paths();
    const sessions = [session('session-a'), session('session-b', 'om_root', 'active')];
    writeMarker(dataDir, 'session-a');
    writeMarker(dataDir, 'session-b');
    let recoveryCalls = 0;
    let modelCalls = 0;
    const result = await runLogisticsAnalysis({
      dataDir,
      dbPath,
      bot,
      apply: true,
      sessionPrefix: 'session-a',
      harnessRoot: '/fixture',
      now: oldAt + 30 * 60_000,
    }, baseDeps(sessions, async () => history('工作中'), {
      resolveAnswer: () => {
        recoveryCalls += 1;
        return { content: '来自恢复的完整答案', source: 'codex_assistant_final', occurredAt: oldAt };
      },
      findDaemon: () => ({ larkAppId: bot.larkAppId, ipcPort: 17950 }),
      fetchRuntimeSession: async (_daemon, sessionId) => ({
        httpStatus: 200,
        body: { session: { status: sessionId === 'session-b' ? 'working' : 'idle' } },
      }),
      createModelRunner: () => async () => {
        modelCalls += 1;
        return { businessCategory: 'LB02', problemType: 'LP01', resolutionStatus: 'resolved', overallConfidence: 'high', needsReview: false };
      },
    }));
    expect(result.status).toBe('partial');
    expect(recoveryCalls).toBe(4);
    expect((result.label as { gateSkipped?: number }).gateSkipped).toBe(1);
    expect(modelCalls).toBe(0);
  });

  it('does not rerun the model when the content hash is unchanged', async () => {
    const { dataDir, dbPath } = paths();
    let modelCalls = 0;
    const deps = baseDeps([session('same')], async () => history(), {
      createModelRunner: () => async () => {
        modelCalls += 1;
        return { businessCategory: 'LB02', problemType: 'LP01', resolutionStatus: 'resolved', overallConfidence: 'high', needsReview: false };
      },
    });
    const first = await runLogisticsAnalysis({ dataDir, dbPath, bot, apply: true, harnessRoot: '/fixture', now: oldAt + 30 * 60_000 }, deps);
    const second = await runLogisticsAnalysis({ dataDir, dbPath, bot, apply: true, harnessRoot: '/fixture', now: oldAt + 31 * 60_000 }, deps);
    expect(first.status).toBe('succeeded');
    expect(second.status).toBe('succeeded');
    expect(modelCalls).toBe(1);
  });

  it('expires a model result when visible history changes during model execution', async () => {
    const { dataDir, dbPath } = paths();
    let calls = 0;
    let modelCalls = 0;
    const deps = baseDeps([session('changes')], async () => {
      calls += 1;
      return calls >= 3 ? [
        ...history(),
        { message_id: 'om_new', msg_type: 'text', body: { content: '补充问题' }, sender: { id: 'ou_user', sender_type: 'user' }, create_time: String(oldAt + 1_000) },
      ] : history();
    }, {
      createModelRunner: () => async () => {
        modelCalls += 1;
        return { businessCategory: 'LB02', problemType: 'LP01', resolutionStatus: 'resolved', overallConfidence: 'high', needsReview: false };
      },
    });
    const result = await runLogisticsAnalysis({ dataDir, dbPath, bot, apply: true, harnessRoot: '/fixture', now: oldAt + 30 * 60_000 }, deps);
    expect(modelCalls).toBe(1);
    expect(result.status).toBe('partial');
    expect((result.label as { expired?: number }).expired).toBe(1);
    const store = new LogisticsAnalysisStore({ dataDir, path: dbPath, readOnly: true });
    try { expect(store.detail('topic_missing', { labelerRevision: revision })).toBeUndefined(); }
    finally { store.close(); }
  });

  it('continues capture after one topic history failure', async () => {
    const { dataDir, dbPath } = paths();
    const sessions = [session('ok', 'om_ok'), session('bad', 'om_bad')];
    const result = await captureLogisticsAnalysis({ dataDir, dbPath, bot, apply: true, now: oldAt + 30 * 60_000 }, baseDeps(
      sessions,
      async (_botId, _chatId, root) => {
        if (root === 'om_bad') throw new Error('provider timeout');
        return history();
      },
    ));
    expect(result.processed).toBe(2);
    expect(result.captured).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('uses a stable topic cursor even when non-key metadata changes', () => {
    const candidates = [{ sessionKey: 'topic_b' }, { sessionKey: 'topic_a' }];
    const first = paginateLogisticsAnalysisTopics(candidates, { limit: 1 });
    candidates[1]!.sessionKey = 'topic_a';
    const second = paginateLogisticsAnalysisTopics(candidates, { limit: 1, cursor: first.nextCursor });
    expect(first.candidates.map(item => item.sessionKey)).toEqual(['topic_a']);
    expect(second.candidates.map(item => item.sessionKey)).toEqual(['topic_b']);
  });

  it('writes only the specified run-state fields with mode 0600', async () => {
    const { dataDir, dbPath } = paths();
    const result = await runLogisticsAnalysis({ dataDir, dbPath, bot, apply: true, harnessRoot: '/fixture', now: oldAt + 30 * 60_000 }, baseDeps(
      [session('state')], async () => history(),
    ));
    expect(result.status).toBe('succeeded');
    const statePath = `${dbPath}.run.json`;
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual([
      'errorCode', 'finishedAt', 'lastSuccessfulCaptureAt', 'lastSuccessfulLabelAt',
      'lastSuccessfulSyncAt', 'pendingCapture', 'pendingLabel', 'schemaVersion', 'startedAt', 'status',
    ]);
  });
});
  it('caps run model starts at 50 and resumes from the persisted label cursor', async () => {
    const { dataDir, dbPath } = paths();
    const sessions = Array.from({ length: 55 }, (_, index) => session(`budget-${index}`, `om_budget_${index}`));
    let modelCalls = 0;
    const deps = baseDeps(sessions, async () => history(), {
      createModelRunner: () => async () => {
        modelCalls += 1;
        return { businessCategory: 'LB02', problemType: 'LP01', resolutionStatus: 'resolved', overallConfidence: 'high', needsReview: false };
      },
    });
    const first = await runLogisticsAnalysis({ dataDir, dbPath, bot, apply: true, harnessRoot: '/fixture', now: oldAt + 30 * 60_000 }, deps);
    const firstState = JSON.parse(readFileSync(`${dbPath}.run.json`, 'utf8')) as Record<string, unknown>;
    expect(first.status).toBe('partial');
    expect((first.label as { created?: number }).created).toBe(50);
    expect((first as { pendingLabel?: number }).pendingLabel).toBe(5);
    expect(typeof firstState.nextLabelCursor).toBe('string');

    const second = await runLogisticsAnalysis({ dataDir, dbPath, bot, apply: true, harnessRoot: '/fixture', now: oldAt + 31 * 60_000 }, deps);
    const secondState = JSON.parse(readFileSync(`${dbPath}.run.json`, 'utf8')) as Record<string, unknown>;
    expect(second.status).toBe('succeeded');
    expect((second.label as { created?: number }).created).toBe(5);
    expect(modelCalls).toBe(55);
    expect(secondState.nextLabelCursor).toBeUndefined();
  });
