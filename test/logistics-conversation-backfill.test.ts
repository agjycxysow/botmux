import { describe, expect, it } from 'vitest';

import {
  buildLogisticsCapturedMessages,
  inferLogisticsBackfillBoundaries,
  logisticsBackfillErrorReason,
  logisticsSessionCatalogInput,
  mergeLogisticsAnswerPreview,
  paginateLogisticsBackfillSessions,
  paginateLogisticsLabelCandidates,
} from '../src/cli/logistics-conversation.js';
import type { LogisticsSessionMasterRecord } from '../src/services/logistics-session-master.js';
import type { Session } from '../src/types.js';

describe('logistics conversation history boundary inference', () => {
  const messages = [
    { messageId: 'om_root', senderType: 'user', content: '第一问' },
    { messageId: 'om_a1', senderType: 'app', content: '第一答' },
    { messageId: 'om_turn', senderType: 'user', content: '第二问' },
    { messageId: 'om_answer', senderType: 'app', content: '第二答' },
    { messageId: 'om_survey', senderType: 'app', content: '这次回答对你的帮助有多大？' },
  ];

  it('prefers exact persisted ids when they are present', () => {
    expect(inferLogisticsBackfillBoundaries(messages, 'om_turn', 'om_answer')).toEqual({
      turnId: 'om_turn',
      answerMessageId: 'om_answer',
    });
  });

  it('falls back to the last substantive assistant message and preceding user turn', () => {
    expect(inferLogisticsBackfillBoundaries(messages)).toEqual({
      turnId: 'om_turn',
      answerMessageId: 'om_answer',
    });
  });

  it('keeps the Lark business error code for failed history reads', () => {
    expect(logisticsBackfillErrorReason({
      message: 'Request failed with status code 400',
      response: { data: { code: 230002, msg: 'Bot/User can NOT be out of the chat.' } },
    })).toBe('lark_230002:Bot/User can NOT be out of the chat.');
  });
});


function session(index: number, at = index): Session {
  return {
    sessionId: `session-${String(index).padStart(4, '0')}`,
    chatId: 'oc_chat',
    rootMessageId: `om_root_${index}`,
    scope: 'thread',
    title: `会话 ${index}`,
    status: index % 2 ? 'active' : 'closed',
    createdAt: new Date(at * 1_000).toISOString(),
    lastMessageAt: new Date(at * 1_000).toISOString(),
    larkAppId: 'cli_logistics',
    cliId: 'codex',
    workingDir: '/tmp',
  } as Session;
}

describe('logistics backfill cursor pagination', () => {
  it('walks more than 500 sessions without duplicates or omissions', () => {
    const sessions = Array.from({ length: 603 }, (_, index) => session(index + 1));
    const first = paginateLogisticsBackfillSessions(sessions, {
      apply: false, bot: 'cli_logistics', limit: 500,
    });
    expect(first.sessions).toHaveLength(500);
    expect(first.totalCandidates).toBe(603);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    const second = paginateLogisticsBackfillSessions(sessions, {
      apply: false, bot: 'cli_logistics', limit: 500, cursor: first.nextCursor,
    });
    expect(second.sessions).toHaveLength(103);
    expect(second.hasMore).toBe(false);
    const ids = [...first.sessions, ...second.sessions].map(item => item.sessionId);
    expect(new Set(ids).size).toBe(603);
  });

  it('fails closed for an invalid or mismatched cursor', () => {
    const sessions = [session(1), session(2)];
    expect(() => paginateLogisticsBackfillSessions(sessions, {
      apply: false, limit: 1, cursor: 'invalid',
    })).toThrow('invalid_backfill_cursor');
    const first = paginateLogisticsBackfillSessions(sessions, {
      apply: false, bot: 'cli_logistics', limit: 1,
    });
    expect(() => paginateLogisticsBackfillSessions(sessions, {
      apply: false, bot: 'other_bot', limit: 1, cursor: first.nextCursor,
    })).toThrow('invalid_backfill_cursor');
  });

  it('maps durable session metadata without exposing runtime-only fields', () => {
    expect(logisticsSessionCatalogInput(session(1))).toMatchObject({
      larkAppId: 'cli_logistics', sessionId: 'session-0001', scope: 'thread', sessionStatus: 'active',
    });
  });
});

function labelCandidate(index: number) {
  const record: LogisticsSessionMasterRecord = {
    masterKey: `oc_chat:session-${String(index).padStart(4, '0')}`,
    larkAppId: 'cli_logistics',
    sessionId: `session-${String(index).padStart(4, '0')}`,
    turnId: `om_turn_${index}`,
    surveyId: `survey-${index}`,
    settledSurveyIds: [],
    ratingCount: 0,
    chatId: 'oc_chat',
    rootMessageId: `om_root_${index}`,
    respondentOpenId: '',
    surveyStatus: 'scheduled',
    dueAt: index,
    ratingState: 'awaiting',
    transcript: `用户：问题 ${index}`,
    transcriptHash: String(index).padStart(64, '0'),
    captureState: 'complete',
    messages: [{ role: 'user', content: `问题 ${index}` }],
    taggingState: 'needs_review',
    needsReview: false,
    modelAttempts: 0,
    baseSyncAttempts: 0,
    createdAt: index,
    updatedAt: index,
  };
  return { record, attempt: 1, truncated: false };
}

describe('logistics label cursor pagination', () => {
  const revision = 'a'.repeat(64);
  const options = {
    apply: false,
    force: false,
    bot: 'cli_logistics',
    limit: 2,
    concurrency: 1,
  };

  it('walks the stable master-key order without duplicate model candidates', () => {
    const candidates = [labelCandidate(3), labelCandidate(1), labelCandidate(2)];
    const first = paginateLogisticsLabelCandidates(candidates, options, revision);
    expect(first.candidates.map(candidate => candidate.record.sessionId)).toEqual([
      'session-0001',
      'session-0002',
    ]);
    expect(first.hasMore).toBe(true);
    const second = paginateLogisticsLabelCandidates(candidates, {
      ...options,
      cursor: first.nextCursor,
    }, revision);
    expect(second.candidates.map(candidate => candidate.record.sessionId)).toEqual(['session-0003']);
    expect(second.hasMore).toBe(false);
  });

  it('fails closed when the label filter or Harness revision changes', () => {
    const first = paginateLogisticsLabelCandidates([labelCandidate(1), labelCandidate(2)], {
      ...options,
      limit: 1,
    }, revision);
    expect(() => paginateLogisticsLabelCandidates([labelCandidate(1), labelCandidate(2)], {
      ...options,
      force: true,
      limit: 1,
      cursor: first.nextCursor,
    }, revision)).toThrow('invalid_label_cursor');
    expect(() => paginateLogisticsLabelCandidates([labelCandidate(1), labelCandidate(2)], {
      ...options,
      limit: 1,
      cursor: first.nextCursor,
    }, 'b'.repeat(64))).toThrow('invalid_label_cursor');
  });
});

describe('logistics answer preview hydration', () => {
  it('replaces a non-terminal card placeholder with the delivered final text', async () => {
    expect(mergeLogisticsAnswerPreview([
      { messageId: 'om_turn', senderType: 'user', content: '帮我定位问题' },
      { messageId: 'om_answer', senderType: 'app', content: '[卡片: Codex 工作中]' },
    ], 'om_answer', {
      messageId: 'om_answer', contentLength: 48,
      previewText: '结论：问题已经定位，并给出了可核验的修复路径。',
    })).toEqual([
      { messageId: 'om_turn', senderType: 'user', content: '帮我定位问题' },
      { messageId: 'om_answer', senderType: 'app', content: '结论：问题已经定位，并给出了可核验的修复路径。' },
    ]);
  });

  it('does not replace an existing substantive answer with a shorter preview', async () => {
    const messages = [{ messageId: 'om_answer', senderType: 'app', content: '这是已经完整投递且可核验的最终回答内容。' }];
    expect(mergeLogisticsAnswerPreview(messages, 'om_answer', {
      messageId: 'om_answer', previewText: '简短摘要', contentLength: 4,
    })).toEqual(messages);
  });

  it('adds a delivered answer that is absent from visible Lark history', () => {
    expect(mergeLogisticsAnswerPreview([
      {
        messageId: 'om_turn',
        senderType: 'user',
        content: '帮我定位问题',
        createTime: '1000',
      },
    ], 'om_answer', {
      messageId: 'om_answer',
      sentAtMs: 2_000,
      previewText: '已经通过 BotMux send 投递的最终回答',
    })).toEqual([
      {
        messageId: 'om_turn',
        senderType: 'user',
        content: '帮我定位问题',
        createTime: '1000',
      },
      {
        messageId: 'om_answer',
        senderType: 'app',
        content: '已经通过 BotMux send 投递的最终回答',
        createTime: '2000',
      },
    ]);
  });
});

describe('logistics captured message facts', () => {
  it('keeps full sanitized content and links assistant messages to the latest user turn', () => {
    const longContent = `第一行\n${'内容'.repeat(2_500)}\n13800000000`;
    const captured = buildLogisticsCapturedMessages({
      larkAppId: 'cli_logistics',
      sessionId: 'session-1',
      finalAnswerMessageId: 'om_answer',
      markerHydratedMessageId: 'om_answer',
      messages: [
        {
          messageId: 'om_turn',
          senderType: 'user',
          senderId: 'ou_sender',
          senderName: '提问用户',
          content: longContent,
          createTime: '1000',
        },
        {
          messageId: 'om_answer',
          senderType: 'app',
          senderId: 'cli_bot',
          senderName: '物流 Bot',
          content: '最终回答',
          createTime: '2000',
        },
      ],
    });

    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({
      role: 'user',
      turnId: 'om_turn',
      occurredAt: 1_000,
      senderId: 'ou_sender',
      senderName: '提问用户',
      source: 'lark_history',
    });
    expect(captured[0]!.content).toContain('\n');
    expect(captured[0]!.content).toContain('[手机号]');
    expect(captured[0]!.content.length).toBeGreaterThan(4_000);
    expect(captured[1]).toMatchObject({
      role: 'assistant',
      turnId: 'om_turn',
      triggerMessageId: 'om_turn',
      responseKind: 'final',
      senderId: 'cli_bot',
      senderName: '物流 Bot',
      source: 'botmux_send_marker',
    });
  });
});
