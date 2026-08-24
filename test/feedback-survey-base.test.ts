import { describe, expect, it, vi } from 'vitest';

import { createFeedbackSurveyBaseUpserter } from '../src/services/feedback-survey-base.js';
import type { FeedbackSurveyRecord } from '../src/services/feedback-survey.js';

function makeRecord(overrides: Partial<FeedbackSurveyRecord> = {}): FeedbackSurveyRecord {
  return {
    surveyId: 'survey-1',
    larkAppId: 'cli_feedback',
    sessionId: 'session-1',
    turnId: 'om_turn',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    respondentOpenId: 'ou_owner',
    recap: '目标：检查灰度\n结论 / 产出：已完成',
    status: 'answered',
    dueAt: Date.parse('2026-08-18T12:00:00Z'),
    scheduledAt: Date.parse('2026-08-18T11:59:00Z'),
    sentAt: Date.parse('2026-08-18T12:01:00Z'),
    answeredAt: Date.parse('2026-08-18T12:02:00Z'),
    rating: 5,
    updatedAt: Date.parse('2026-08-18T12:02:00Z'),
    ...overrides,
  };
}

describe('feedback survey Base upsert', () => {
  it('creates then updates one Base record with typed people/date fields', async () => {
    const runner = vi.fn(async () => ({
      stdout: JSON.stringify({ data: { record: { record_id: 'rec_feedback_1' } } }),
    }));
    const upsert = createFeedbackSurveyBaseUpserter(runner);
    const config = { appToken: 'base_token', tableId: 'tbl_feedback', identity: 'bot' as const };

    await expect(upsert({ config, record: makeRecord() })).resolves.toEqual({ recordId: 'rec_feedback_1' });
    const firstArgs = runner.mock.calls[0]![1];
    expect(firstArgs).toEqual(expect.arrayContaining([
      'base', '+record-upsert', '--as', 'bot', '--base-token', 'base_token', '--table-id', 'tbl_feedback',
    ]));
    expect(firstArgs).not.toContain('--record-id');
    const fields = JSON.parse(firstArgs[firstArgs.indexOf('--json') + 1]!) as Record<string, unknown>;
    expect(fields['提问者']).toEqual([{ id: 'ou_owner' }]);
    expect(fields['评分']).toBe(5);
    expect(fields['计划发送时间']).toBe('2026-08-18 20:00:00');

    await upsert({ config, record: makeRecord({ baseRecordId: 'rec_feedback_1', rating: 4 }) });
    const updateArgs = runner.mock.calls[1]![1];
    expect(updateArgs.slice(updateArgs.indexOf('--record-id'), updateArgs.indexOf('--record-id') + 2))
      .toEqual(['--record-id', 'rec_feedback_1']);
  });
});
