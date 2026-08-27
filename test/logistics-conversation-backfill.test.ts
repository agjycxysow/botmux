import { describe, expect, it } from 'vitest';

import { inferLogisticsBackfillBoundaries } from '../src/cli/logistics-conversation.js';

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
