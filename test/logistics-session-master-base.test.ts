import { describe, expect, it, vi } from 'vitest';

import { createLogisticsSessionMasterBaseUpserter } from '../src/services/logistics-session-master-base.js';
import type { LogisticsSessionMasterRecord } from '../src/services/logistics-session-master.js';

function record(overrides: Partial<LogisticsSessionMasterRecord> = {}): LogisticsSessionMasterRecord {
  return {
    masterKey: 'oc_chat:session-1',
    larkAppId: 'cli_logistics',
    sessionId: 'session-1',
    turnId: 'turn-1',
    surveyId: 'survey-1',
    settledSurveyIds: ['survey-1'],
    ratingCount: 1,
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    respondentOpenId: 'ou_user',
    surveyStatus: 'answered',
    dueAt: Date.parse('2026-08-20T12:00:00Z'),
    sentAt: Date.parse('2026-08-20T12:15:00Z'),
    rating: 5,
    answeredAt: Date.parse('2026-08-20T12:16:00Z'),
    ratingState: 'rated',
    transcript: '用户：问题\n助手：回答',
    transcriptHash: 'a'.repeat(64),
    captureState: 'complete',
    taggingState: 'tagged',
    businessCategory: 'LB02',
    problemType: 'LP03',
    resolutionStatus: 'resolved',
    overallConfidence: 'medium',
    needsReview: false,
    modelAttempts: 1,
    baseSyncAttempts: 0,
    createdAt: Date.parse('2026-08-20T12:00:00Z'),
    updatedAt: Date.parse('2026-08-20T12:16:00Z'),
    ...overrides,
  };
}

describe('logistics session master Base upsert', () => {
  it('looks up the business key then batch-updates one existing master row with the existing taxonomy fields', async () => {
    const runner = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes('+record-list')) {
        return {
          stdout: JSON.stringify({
            data: {
              fields: ['会话唯一键'],
              data: [['oc_chat:session-1']],
              record_id_list: ['rec_existing'],
            },
          }),
        };
      }
      return { stdout: JSON.stringify({ data: { record: { record_id: 'rec_existing' } } }) };
    });
    const upsert = createLogisticsSessionMasterBaseUpserter(runner);
    await expect(upsert({
      config: { appToken: 'base_token', tableId: 'tbl_master', identity: 'user' },
      record: record(),
    })).resolves.toEqual({ recordId: 'rec_existing' });

    const writeArgs = runner.mock.calls[1]![1] as string[];
    expect(writeArgs).toEqual(expect.arrayContaining(['+record-batch-update']));
    const payload = JSON.parse(writeArgs[writeArgs.indexOf('--json') + 1]!) as {
      update_records: Record<string, Record<string, unknown>>;
    };
    const fields = payload.update_records.rec_existing!;
    expect(fields).toMatchObject({
      '业务分组（LB）': ['LB02 发货 / 履约'],
      '功能分组（LP）': ['LP03 页面 / 代码 / 接口链路定位'],
      '总置信度': ['中'],
      '满意度': 5,
      '评价次数': 1,
      '复核原因': '',
    });
  });

  it('batch-creates one master row when the business key is absent', async () => {
    const runner = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes('+record-list')) {
        return {
          stdout: JSON.stringify({
            data: {
              fields: ['会话唯一键'],
              data: [],
              record_id_list: [],
            },
          }),
        };
      }
      return { stdout: JSON.stringify({ data: { record_id_list: ['rec_created'] } }) };
    });
    const upsert = createLogisticsSessionMasterBaseUpserter(runner);
    await expect(upsert({
      config: { appToken: 'base_token', tableId: 'tbl_master', identity: 'user' },
      record: record(),
    })).resolves.toEqual({ recordId: 'rec_created' });

    const writeArgs = runner.mock.calls[1]![1] as string[];
    expect(writeArgs).toEqual(expect.arrayContaining(['+record-batch-create']));
    const payload = JSON.parse(writeArgs[writeArgs.indexOf('--json') + 1]!) as {
      create_records: Array<Record<string, unknown>>;
    };
    expect(payload.create_records).toHaveLength(1);
    expect(payload.create_records[0]).toMatchObject({
      '会话唯一键': 'oc_chat:session-1',
      '问卷状态': ['已评分'],
      '评分状态': ['已评分'],
    });
  });

  it('refuses to write when the business key lookup finds duplicate rows', async () => {
    const runner = vi.fn(async () => ({
      stdout: JSON.stringify({
        data: {
          fields: ['会话唯一键'],
          data: [['oc_chat:session-1'], ['oc_chat:session-1']],
          record_id_list: ['rec_a', 'rec_b'],
        },
      }),
    }));
    const upsert = createLogisticsSessionMasterBaseUpserter(runner);
    await expect(upsert({
      config: { appToken: 'base_token', tableId: 'tbl_master', identity: 'user' },
      record: record(),
    })).rejects.toThrow('logistics_session_master_duplicate_key');
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
