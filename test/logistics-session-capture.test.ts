import { describe, expect, it } from 'vitest';

import {
  buildLogisticsSessionSnapshot,
  sanitizeLogisticsMessageText,
  sanitizeLogisticsSessionText,
} from '../src/services/logistics-session-capture.js';

describe('logistics session capture', () => {
  it('captures the bounded session segment and redacts sensitive patterns', () => {
    const snapshot = buildLogisticsSessionSnapshot({
      rootMessageId: 'om_root',
      turnId: 'om_turn',
      answerMessageId: 'om_answer',
      sessionStartedAt: '2026-08-19T14:40:00.000Z',
      messages: [
        { messageId: 'om_old', senderType: 'user', createTime: '1787145540000', content: '上一段会话' },
        { messageId: 'om_root', senderType: 'user', createTime: '1787150800000', content: '请查 13800000000 https://example.com' },
        { messageId: 'om_turn', senderType: 'user', createTime: '1787150810000', content: '继续补充' },
        { messageId: 'om_answer', senderType: 'app', createTime: '1787150820000', content: '处理完成 ou_secret' },
      ],
    });

    expect(snapshot).toMatchObject({
      captureState: 'complete',
      messageCount: 3,
    });
    expect(snapshot.transcript).not.toContain('上一段会话');
    expect(snapshot.transcript).toContain('[手机号]');
    expect(snapshot.transcript).toContain('[链接]');
    expect(snapshot.transcript).toContain('[成员]');
    expect(snapshot.transcriptHash).toMatch(/^[a-f0-9]{64}$/);
  });


  it('treats an explicit chat-scope user/assistant turn window as complete', () => {
    expect(buildLogisticsSessionSnapshot({
      rootMessageId: null,
      turnId: 'om_turn',
      answerMessageId: 'om_answer',
      messages: [
        { messageId: 'om_old', senderType: 'app', content: '旧答' },
        { messageId: 'om_turn', senderType: 'user', content: '新问' },
        { messageId: 'om_answer', senderType: 'app', content: '新答' },
      ],
    })).toMatchObject({
      captureState: 'complete',
      messages: [{ role: 'user', content: '新问' }, { role: 'assistant', content: '新答' }],
    });
  });

  it('marks missing boundaries as partial rather than claiming a complete segment', () => {
    expect(buildLogisticsSessionSnapshot({
      turnId: 'om_missing',
      messages: [{ messageId: 'om_answer', senderType: 'app', content: 'answer' }],
    })).toMatchObject({
      captureState: 'partial',
      reviewReason: expect.any(String),
    });
    expect(sanitizeLogisticsSessionText('a@b.com 13900000000 ou_secret')).toBe('[邮箱] [手机号] [成员]');
  });

  it('keeps full message text and line breaks outside the bounded snapshot', () => {
    const text = `第一行\n${'内容'.repeat(7_000)}\n13800000000`;
    const sanitized = sanitizeLogisticsMessageText(text);
    expect(sanitized).toContain('第一行\n');
    expect(sanitized).toContain('\n[手机号]');
    expect(sanitized.length).toBeGreaterThan(12_000);
    expect(sanitizeLogisticsSessionText(text)).toHaveLength(12_000);
  });
});
