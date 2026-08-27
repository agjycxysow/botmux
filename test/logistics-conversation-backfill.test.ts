import { describe, expect, it } from 'vitest';

import {
  inferLogisticsBackfillBoundaries,
  logisticsSessionCatalogInput,
  paginateLogisticsBackfillSessions,
} from '../src/cli/logistics-conversation.js';
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
      apply: false, bot: 'cli_logistics', limit: 500, noLabel: true,
    });
    expect(first.sessions).toHaveLength(500);
    expect(first.totalCandidates).toBe(603);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    const second = paginateLogisticsBackfillSessions(sessions, {
      apply: false, bot: 'cli_logistics', limit: 500, noLabel: true, cursor: first.nextCursor,
    });
    expect(second.sessions).toHaveLength(103);
    expect(second.hasMore).toBe(false);
    const ids = [...first.sessions, ...second.sessions].map(item => item.sessionId);
    expect(new Set(ids).size).toBe(603);
  });

  it('fails closed for an invalid or mismatched cursor', () => {
    const sessions = [session(1), session(2)];
    expect(() => paginateLogisticsBackfillSessions(sessions, {
      apply: false, limit: 1, noLabel: true, cursor: 'invalid',
    })).toThrow('invalid_backfill_cursor');
    const first = paginateLogisticsBackfillSessions(sessions, {
      apply: false, bot: 'cli_logistics', limit: 1, noLabel: true,
    });
    expect(() => paginateLogisticsBackfillSessions(sessions, {
      apply: false, bot: 'other_bot', limit: 1, noLabel: true, cursor: first.nextCursor,
    })).toThrow('invalid_backfill_cursor');
  });

  it('maps durable session metadata without exposing runtime-only fields', () => {
    expect(logisticsSessionCatalogInput(session(1))).toMatchObject({
      larkAppId: 'cli_logistics', sessionId: 'session-0001', scope: 'thread', sessionStatus: 'active',
    });
  });
});

describe('logistics answer preview hydration', () => {
  it('replaces a non-terminal card placeholder with the delivered final text', async () => {
    const { mergeLogisticsAnswerPreview } = await import('../src/cli/logistics-conversation.js');
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
    const { mergeLogisticsAnswerPreview } = await import('../src/cli/logistics-conversation.js');
    const messages = [{ messageId: 'om_answer', senderType: 'app', content: '这是已经完整投递且可核验的最终回答内容。' }];
    expect(mergeLogisticsAnswerPreview(messages, 'om_answer', {
      messageId: 'om_answer', previewText: '简短摘要', contentLength: 4,
    })).toEqual(messages);
  });
});
