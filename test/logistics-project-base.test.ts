import { describe, expect, it, vi } from 'vitest';

import {
  LOGISTICS_PROJECT_BASE_BATCH_SIZE,
  LOGISTICS_PROJECT_BASE_FIELDS,
  fieldsForLogisticsProjectBase,
  logisticsResolutionLabel,
  planLogisticsProjectBase,
  runLogisticsProjectBase,
  type LogisticsProjectBaseClient,
} from '../src/services/logistics-project-base.js';
import { baseV3FieldForLogisticsProjectBase } from '../src/cli/logistics-project-base.js';
import type { LogisticsProjectBaseSourceRow } from '../src/services/logistics-conversation-store.js';

function row(overrides: Partial<LogisticsProjectBaseSourceRow> = {}): LogisticsProjectBaseSourceRow {
  return {
    conversationKey: 'conv_safe_1', sessionPublicId: 'sess_safe_1', larkAppId: 'cli_bot',
    title: '物流问题', conversationAt: 1_000, dataStatus: 'captured', captureState: 'complete',
    taggingState: 'tagged', businessCategory: 'LB02', problemType: 'LP05',
    resolutionStatus: 'resolved', overallConfidence: 'high', needsReview: false,
    businessReasonCode: 'domain', problemReasonCode: 'incident', resolutionReasonCode: 'resolved',
    harnessRevision: 'revision', rating: 5, surveyStatus: 'answered', updatedAt: 2_000,
    ...overrides,
  };
}

function client(overrides: Partial<LogisticsProjectBaseClient> = {}): LogisticsProjectBaseClient {
  return {
    listTables: vi.fn(async () => ({ items: [], hasMore: false })),
    listFields: vi.fn(async () => ({ items: [], hasMore: false })),
    listRecords: vi.fn(async () => ({ items: [], hasMore: false })),
    createTable: vi.fn(async () => ({ tableId: 'tbl_new' })),
    batchCreate: vi.fn(async () => undefined),
    batchUpdate: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('logistics project Base projection', () => {
  it('maps only safe public identifiers and fixed status labels', () => {
    const fields = fieldsForLogisticsProjectBase(row(), '物流 Bot');
    expect(fields).toMatchObject({
      '会话唯一键': 'conv_safe_1', 'Session 公共 ID': 'sess_safe_1', Bot: '物流 Bot',
      '解决状态': '已解决', LB: 'LB02', LP: 'LP05', needs_review: false,
    });
    expect(Object.keys(fields)).not.toEqual(expect.arrayContaining(['open_id', 'Chat ID', '会话内容', 'Token', 'Cookie']));
    expect(logisticsResolutionLabel('in_progress')).toBe('处理中');
    expect(logisticsResolutionLabel('unknown')).toBe('未知');
    expect(logisticsResolutionLabel('unresolved')).toBe('未知');
    expect(LOGISTICS_PROJECT_BASE_FIELDS.find(field => field.name === '解决状态')?.options).toEqual(['已解决', '处理中', '未知']);
  });

  it('builds Base v3 fields for every projection column', () => {
    const resolution = LOGISTICS_PROJECT_BASE_FIELDS.find(field => field.name === '解决状态')!;
    const conversationAt = LOGISTICS_PROJECT_BASE_FIELDS.find(field => field.name === '会话时间')!;
    const rating = LOGISTICS_PROJECT_BASE_FIELDS.find(field => field.name === '满意度')!;
    expect(LOGISTICS_PROJECT_BASE_FIELDS.map(baseV3FieldForLogisticsProjectBase)).toHaveLength(21);
    expect(baseV3FieldForLogisticsProjectBase(resolution)).toEqual({
      name: '解决状态',
      type: 'select',
      multiple: false,
      options: [{ name: '已解决' }, { name: '处理中' }, { name: '未知' }],
    });
    expect(baseV3FieldForLogisticsProjectBase(conversationAt)).toMatchObject({
      type: 'datetime',
      style: { format: 'yyyy-MM-dd HH:mm' },
    });
    expect(baseV3FieldForLogisticsProjectBase(rating)).toMatchObject({
      type: 'number',
      style: { type: 'rating', min: 1, max: 5 },
    });
  });

  it('plans create/update/unchanged/conflict idempotently', () => {
    const first = row();
    const same = fieldsForLogisticsProjectBase(first, 'Bot');
    const plan = planLogisticsProjectBase([
      first,
      row({ conversationKey: 'conv_update', sessionPublicId: 'sess_2' }),
      row({ conversationKey: 'conv_new', sessionPublicId: 'sess_3' }),
      row({ conversationKey: 'conv_dup', sessionPublicId: 'sess_4' }),
    ], [
      { recordId: 'rec_same', fields: same },
      { recordId: 'rec_update', fields: { ...fieldsForLogisticsProjectBase(row({ conversationKey: 'conv_update', sessionPublicId: 'sess_2' }), 'Bot'), 标题: '旧标题' } },
      { recordId: 'rec_dup_1', fields: { 会话唯一键: 'conv_dup' } },
      { recordId: 'rec_dup_2', fields: { 会话唯一键: 'conv_dup' } },
    ], 'Bot');
    expect({ create: plan.create.length, update: plan.update.length, unchanged: plan.unchanged.length, conflict: plan.conflicts.length }).toEqual({ create: 1, update: 1, unchanged: 1, conflict: 1 });
  });

  it('treats Base empty cells and numeric strings as unchanged', () => {
    const source = row();
    delete source.businessCategory;
    delete source.problemType;
    delete source.businessReasonCode;
    delete source.problemReasonCode;
    delete source.resolutionReasonCode;
    delete source.harnessRevision;
    const actual: Record<string, unknown> = fieldsForLogisticsProjectBase(source, 'Bot');
    for (const name of ['LB', 'LP', '业务 Reason Code', '问题 Reason Code', '解决 Reason Code', '复核原因', 'Harness Revision']) {
      actual[name] = null;
    }
    actual['满意度'] = '5';
    const plan = planLogisticsProjectBase([source], [{ recordId: 'rec_same', fields: actual }], 'Bot');
    expect({ update: plan.update.length, unchanged: plan.unchanged.length }).toEqual({ update: 0, unchanged: 1 });
  });

  it('reads every page and caps serialized writes at 200 records', async () => {
    const creates = Array.from({ length: LOGISTICS_PROJECT_BASE_BATCH_SIZE + 1 }, (_, index) => row({ conversationKey: `conv_${index}`, sessionPublicId: `sess_${index}` }));
    const api = client({
      listTables: vi.fn(async ({ pageToken }) => pageToken
        ? { items: [{ tableId: 'tbl_v2', name: '会话事实_v2' }], hasMore: false }
        : { items: [], hasMore: true, pageToken: 'tables-2' }),
      listFields: vi.fn(async ({ pageToken }) => pageToken
        ? { items: LOGISTICS_PROJECT_BASE_FIELDS.slice(10).map(field => ({ name: field.name, type: field.type })), hasMore: false }
        : { items: LOGISTICS_PROJECT_BASE_FIELDS.slice(0, 10).map(field => ({ name: field.name, type: field.type })), hasMore: true, pageToken: 'fields-2' }),
      listRecords: vi.fn(async ({ pageToken }) => pageToken
        ? { items: [], hasMore: false }
        : { items: [], hasMore: true, pageToken: 'records-2' }),
    });
    const result = await runLogisticsProjectBase({ client: api, baseToken: 'base', rows: creates, botLabel: 'Bot', apply: true, sleep: async () => undefined });
    expect(result.create).toBe(201);
    expect(api.batchCreate).toHaveBeenCalledTimes(2);
    expect((api.batchCreate as any).mock.calls[0][0].records).toHaveLength(200);
    expect((api.batchCreate as any).mock.calls[1][0].records).toHaveLength(1);
    const tokens = (api.batchCreate as any).mock.calls.map((call: any[]) => call[0].clientToken);
    expect(tokens.every((token: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token))).toBe(true);
    expect(new Set(tokens).size).toBe(2);
  });

  it('retries finite Base write conflicts and then recovers', async () => {
    let attempts = 0;
    const api = client({
      batchCreate: vi.fn(async () => {
        attempts += 1;
        if (attempts < 3) throw { response: { data: { code: 1254291 } } };
      }),
    });
    const waits: number[] = [];
    await runLogisticsProjectBase({ client: api, baseToken: 'base', rows: [row()], botLabel: 'Bot', apply: true, assumeTableMissing: false, sleep: async ms => { waits.push(ms); } });
    expect(attempts).toBe(3);
    expect(waits).toEqual([500, 1_000]);
    const tokens = (api.batchCreate as any).mock.calls.map((call: any[]) => call[0].clientToken);
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
