import { createHash } from 'node:crypto';

import type { LogisticsProjectBaseSourceRow } from './logistics-conversation-store.js';

export const LOGISTICS_PROJECT_BASE_TABLE = '会话事实_v2';
export const LOGISTICS_PROJECT_BASE_KEY = '会话唯一键';
export const LOGISTICS_PROJECT_BASE_BATCH_SIZE = 200;

type FieldValue = string | number | boolean | null;
export type LogisticsProjectBaseFields = Record<string, FieldValue>;

export interface LogisticsProjectBaseFieldSpec {
  name: string;
  type: number;
  uiType: string;
  options?: string[];
  formatter?: string;
}

export const LOGISTICS_PROJECT_BASE_FIELDS: LogisticsProjectBaseFieldSpec[] = [
  { name: LOGISTICS_PROJECT_BASE_KEY, type: 1, uiType: 'Text' },
  { name: 'Session 公共 ID', type: 1, uiType: 'Text' },
  { name: 'Bot', type: 1, uiType: 'Text' },
  { name: '会话发起人', type: 1, uiType: 'Text' },
  { name: '标题', type: 1, uiType: 'Text' },
  { name: '会话时间', type: 5, uiType: 'DateTime', formatter: 'yyyy-MM-dd HH:mm' },
  { name: '采集状态', type: 3, uiType: 'SingleSelect', options: ['完整', '部分', '待采集', '采集中', '缺少用户轮次', '缺少回答', '历史读取失败', '已跳过'] },
  { name: '打标状态', type: 3, uiType: 'SingleSelect', options: ['待采集', '打标中', '已完成', '待复核'] },
  { name: 'LB', type: 3, uiType: 'SingleSelect', options: ['LB01', 'LB02', 'LB03', 'LB04', 'LB05', 'LB06', 'LB99'] },
  { name: 'LP', type: 3, uiType: 'SingleSelect', options: ['LP01', 'LP02', 'LP03', 'LP04', 'LP05', 'LP06', 'LP07', 'LP99'] },
  { name: '解决状态', type: 3, uiType: 'SingleSelect', options: ['已解决', '处理中', '未知'] },
  { name: '业务 Reason Code', type: 1, uiType: 'Text' },
  { name: '问题 Reason Code', type: 1, uiType: 'Text' },
  { name: '解决 Reason Code', type: 1, uiType: 'Text' },
  { name: '置信度', type: 3, uiType: 'SingleSelect', options: ['高', '中', '低'] },
  { name: 'needs_review', type: 7, uiType: 'Checkbox' },
  { name: '复核原因', type: 1, uiType: 'Text' },
  { name: 'Harness Revision', type: 1, uiType: 'Text' },
  { name: '满意度', type: 2, uiType: 'Rating' },
  { name: '问卷状态', type: 3, uiType: 'SingleSelect', options: ['待发送', '发送中', '已发送', '已评分', '已超时', '已失效', '已取消', '发送失败', '未知'] },
  { name: '更新时间', type: 5, uiType: 'DateTime', formatter: 'yyyy-MM-dd HH:mm' },
  { name: '数据来源', type: 1, uiType: 'Text' },
];

export interface LogisticsProjectBaseRemoteRecord {
  recordId: string;
  fields: Record<string, unknown>;
}

export interface LogisticsProjectBaseClient {
  listTables(input: { baseToken: string; pageToken?: string; pageSize: number }): Promise<{
    items: Array<{ tableId: string; name: string }>;
    hasMore: boolean;
    pageToken?: string;
  }>;
  listFields(input: { baseToken: string; tableId: string; pageToken?: string; pageSize: number }): Promise<{
    items: Array<{ name: string; type: number }>;
    hasMore: boolean;
    pageToken?: string;
  }>;
  listRecords(input: { baseToken: string; tableId: string; pageToken?: string; pageSize: number }): Promise<{
    items: LogisticsProjectBaseRemoteRecord[];
    hasMore: boolean;
    pageToken?: string;
  }>;
  createTable(input: { baseToken: string; name: string; fields: LogisticsProjectBaseFieldSpec[] }): Promise<{ tableId: string }>;
  batchCreate(input: { baseToken: string; tableId: string; records: LogisticsProjectBaseFields[]; clientToken: string }): Promise<void>;
  batchUpdate(input: { baseToken: string; tableId: string; records: Array<{ recordId: string; fields: LogisticsProjectBaseFields }> }): Promise<void>;
}

export interface LogisticsProjectBasePlan {
  create: Array<{ key: string; fields: LogisticsProjectBaseFields }>;
  update: Array<{ key: string; recordId: string; fields: LogisticsProjectBaseFields }>;
  unchanged: string[];
  conflicts: Array<{ key: string; reason: string }>;
}

const BUSINESS = new Set(['LB01', 'LB02', 'LB03', 'LB04', 'LB05', 'LB06', 'LB99']);
const PROBLEM = new Set(['LP01', 'LP02', 'LP03', 'LP04', 'LP05', 'LP06', 'LP07', 'LP99']);

function captureStatus(row: LogisticsProjectBaseSourceRow): string {
  if (row.captureState === 'complete') return '完整';
  if (row.captureState === 'partial') return '部分';
  const labels: Record<string, string> = {
    pending: '待采集', processing: '采集中', captured: '完整', missing_turn: '缺少用户轮次',
    missing_answer: '缺少回答', history_failed: '历史读取失败', skipped: '已跳过',
  };
  return labels[row.dataStatus] ?? '待采集';
}

function taggingStatus(value: string): string {
  return ({ pending_capture: '待采集', tagging: '打标中', tagged: '已完成', needs_review: '待复核' } as Record<string, string>)[value] ?? '待复核';
}

export function logisticsResolutionLabel(value: string | undefined): string {
  return ({ resolved: '已解决', in_progress: '处理中', unknown: '未知' } as Record<string, string>)[value ?? ''] ?? '未知';
}

function confidence(value: string | undefined): string | null {
  return ({ high: '高', medium: '中', low: '低' } as Record<string, string>)[value ?? ''] ?? null;
}

function surveyStatus(value: string | undefined): string {
  return ({
    scheduled: '待发送', sending: '发送中', sent: '已发送', answered: '已评分',
    timed_out: '已超时', invalidated: '已失效', cancelled: '已取消', failed: '发送失败',
  } as Record<string, string>)[value ?? ''] ?? '未知';
}

export function fieldsForLogisticsProjectBase(
  row: LogisticsProjectBaseSourceRow,
  botLabel: string,
): LogisticsProjectBaseFields {
  return {
    [LOGISTICS_PROJECT_BASE_KEY]: row.conversationKey,
    'Session 公共 ID': row.sessionPublicId,
    'Bot': botLabel,
    '会话发起人': row.initiatorName ?? '',
    '标题': row.title ?? '',
    '会话时间': row.conversationAt,
    '采集状态': captureStatus(row),
    '打标状态': taggingStatus(row.taggingState),
    'LB': row.businessCategory && BUSINESS.has(row.businessCategory) ? row.businessCategory : '',
    'LP': row.problemType && PROBLEM.has(row.problemType) ? row.problemType : '',
    '解决状态': logisticsResolutionLabel(row.resolutionStatus),
    '业务 Reason Code': row.businessReasonCode ?? '',
    '问题 Reason Code': row.problemReasonCode ?? '',
    '解决 Reason Code': row.resolutionReasonCode ?? '',
    '置信度': confidence(row.overallConfidence),
    'needs_review': row.needsReview,
    '复核原因': row.reviewReason ?? '',
    'Harness Revision': row.harnessRevision ?? '',
    '满意度': row.rating ?? null,
    '问卷状态': surveyStatus(row.surveyStatus),
    '更新时间': row.updatedAt,
    '数据来源': 'BotMux SQLite',
  };
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (typeof object.text === 'string' && Object.keys(object).every(key => key === 'text' || key === 'type')) return object.text;
    return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalized(item)]));
  }
  return value ?? null;
}

function sameFieldValue(expected: unknown, actual: unknown): boolean {
  const normalizedExpected = normalized(expected);
  const normalizedActual = normalized(actual);
  if (
    (normalizedExpected === '' || normalizedExpected === null)
    && (normalizedActual === '' || normalizedActual === null)
  ) return true;
  if (
    typeof normalizedExpected === 'number'
    && typeof normalizedActual === 'string'
    && normalizedActual.trim() !== ''
    && Number(normalizedActual) === normalizedExpected
  ) return true;
  return JSON.stringify(normalizedActual) === JSON.stringify(normalizedExpected);
}

function sameFields(expected: LogisticsProjectBaseFields, actual: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([name, value]) => sameFieldValue(value, actual[name]));
}

export function planLogisticsProjectBase(
  rows: LogisticsProjectBaseSourceRow[],
  remote: LogisticsProjectBaseRemoteRecord[],
  botLabel: string,
): LogisticsProjectBasePlan {
  const plan: LogisticsProjectBasePlan = { create: [], update: [], unchanged: [], conflicts: [] };
  const sourceCounts = new Map<string, number>();
  for (const row of rows) sourceCounts.set(row.conversationKey, (sourceCounts.get(row.conversationKey) ?? 0) + 1);
  const remoteByKey = new Map<string, LogisticsProjectBaseRemoteRecord[]>();
  for (const record of remote) {
    const key = normalized(record.fields[LOGISTICS_PROJECT_BASE_KEY]);
    if (typeof key !== 'string' || !key) {
      plan.conflicts.push({ key: record.recordId, reason: 'base_record_missing_unique_key' });
      continue;
    }
    const records = remoteByKey.get(key) ?? [];
    records.push(record);
    remoteByKey.set(key, records);
  }
  for (const row of rows) {
    const key = row.conversationKey;
    if ((sourceCounts.get(key) ?? 0) > 1) {
      if (!plan.conflicts.some(item => item.key === key)) plan.conflicts.push({ key, reason: 'sqlite_duplicate_unique_key' });
      continue;
    }
    const matches = remoteByKey.get(key) ?? [];
    if (matches.length > 1) {
      plan.conflicts.push({ key, reason: 'base_duplicate_unique_key' });
      continue;
    }
    const fields = fieldsForLogisticsProjectBase(row, botLabel);
    if (!matches.length) plan.create.push({ key, fields });
    else if (sameFields(fields, matches[0]!.fields)) plan.unchanged.push(key);
    else plan.update.push({ key, recordId: matches[0]!.recordId, fields });
  }
  return plan;
}

async function allPages<T>(load: (pageToken?: string) => Promise<{ items: T[]; hasMore: boolean; pageToken?: string }>): Promise<T[]> {
  const result: T[] = [];
  let token: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await load(token);
    result.push(...page.items);
    if (!page.hasMore) break;
    if (!page.pageToken || seen.has(page.pageToken)) throw new Error('logistics_project_base_invalid_pagination');
    seen.add(page.pageToken);
    token = page.pageToken;
  } while (true);
  return result;
}

function chunks<T>(items: T[], size = LOGISTICS_PROJECT_BASE_BATCH_SIZE): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function stableUuidV4(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function larkErrorCode(error: unknown): number | undefined {
  const object = error as any;
  const values = [object?.code, object?.response?.data?.code, object?.cause?.code];
  return values.find(value => typeof value === 'number');
}

async function retryConflict(action: () => Promise<void>, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try { await action(); return; } catch (error) {
      if (larkErrorCode(error) !== 1254291 || attempt === 3) throw error;
      await sleep(500 * 2 ** attempt);
    }
  }
}

export async function runLogisticsProjectBase(input: {
  client: LogisticsProjectBaseClient;
  baseToken: string;
  tableName?: string;
  rows: LogisticsProjectBaseSourceRow[];
  botLabel: string;
  apply: boolean;
  assumeTableMissing?: boolean;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{
  mode: 'dry-run' | 'apply'; tableName: string; tableId?: string; tableExists: boolean;
  source: number; create: number; update: number; unchanged: number; conflict: number;
  conflicts: LogisticsProjectBasePlan['conflicts']; fields: LogisticsProjectBaseFieldSpec[];
}> {
  if (input.apply && input.assumeTableMissing) throw new Error('logistics_project_base_apply_cannot_assume_missing');
  const tableName = input.tableName ?? LOGISTICS_PROJECT_BASE_TABLE;
  const tables = input.assumeTableMissing ? [] : await allPages(token => input.client.listTables({ baseToken: input.baseToken, pageToken: token, pageSize: 100 }));
  const matches = tables.filter(table => table.name === tableName);
  if (matches.length > 1) throw new Error('logistics_project_base_duplicate_table_name');
  let tableId = matches[0]?.tableId;
  let remote: LogisticsProjectBaseRemoteRecord[] = [];
  if (tableId) {
    const actualFields = await allPages(token => input.client.listFields({ baseToken: input.baseToken, tableId: tableId!, pageToken: token, pageSize: 100 }));
    const byName = new Map(actualFields.map(field => [field.name, field.type]));
    const mismatch = LOGISTICS_PROJECT_BASE_FIELDS.filter(field => byName.get(field.name) !== field.type);
    if (mismatch.length) throw new Error(`logistics_project_base_schema_mismatch:${mismatch.map(field => field.name).join(',')}`);
    remote = await allPages(token => input.client.listRecords({ baseToken: input.baseToken, tableId: tableId!, pageToken: token, pageSize: 200 }));
  }
  const plan = planLogisticsProjectBase(input.rows, remote, input.botLabel);
  if (input.apply && plan.conflicts.length) throw new Error('logistics_project_base_conflicts_require_review');
  if (input.apply) {
    if (!tableId) tableId = (await input.client.createTable({ baseToken: input.baseToken, name: tableName, fields: LOGISTICS_PROJECT_BASE_FIELDS })).tableId;
    const sleep = input.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    for (const batch of chunks(plan.create)) {
      const clientToken = stableUuidV4(batch.map(item => item.key).join('\n'));
      await retryConflict(() => input.client.batchCreate({
        baseToken: input.baseToken, tableId: tableId!,
        records: batch.map(item => item.fields), clientToken,
      }), sleep);
    }
    for (const batch of chunks(plan.update)) {
      await retryConflict(() => input.client.batchUpdate({ baseToken: input.baseToken, tableId: tableId!, records: batch.map(item => ({ recordId: item.recordId, fields: item.fields })) }), sleep);
    }
  }
  return {
    mode: input.apply ? 'apply' : 'dry-run', tableName, ...(tableId ? { tableId } : {}),
    tableExists: matches.length === 1, source: input.rows.length,
    create: plan.create.length, update: plan.update.length, unchanged: plan.unchanged.length,
    conflict: plan.conflicts.length, conflicts: plan.conflicts, fields: LOGISTICS_PROJECT_BASE_FIELDS,
  };
}
