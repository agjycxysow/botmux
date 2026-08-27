import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  LogisticsSessionMasterBaseUpsert,
  LogisticsSessionMasterRecord,
} from './logistics-session-master.js';

const execFileAsync = promisify(execFile);

export type LogisticsSessionMasterBaseRunner = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

function formatShanghai(value: number | undefined): string | null {
  if (!value) return null;
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find(part => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function select(value: string | undefined): string[] | null {
  return value ? [value] : null;
}

function fieldsForBase(record: LogisticsSessionMasterRecord): Record<string, unknown> {
  return {
    '会话唯一键': record.masterKey,
    'Session ID': record.sessionId,
    'Turn ID': record.turnId,
    'Survey ID': record.surveyId,
    '评价次数': record.ratingCount,
    'Bot App ID': record.larkAppId,
    '来源群 Chat ID': record.chatId,
    '话题根消息 ID': record.rootMessageId ?? null,
    '会话内容': record.transcript ?? '',
    '会话摘要': record.recap ?? '',
    '采集状态': select(captureStateLabel(record.captureState)),
    '问卷状态': select(surveyStatusLabel(record.surveyStatus)),
    '打标状态': select(taggingStateLabel(record.taggingState)),
    '业务分组（LB）': select(businessLabel(record.businessCategory)),
    '功能分组（LP）': select(problemLabel(record.problemType)),
    '解决状态': select(resolutionLabel(record.resolutionStatus)),
    '总置信度': select(confidenceLabel(record.overallConfidence)),
    '复核原因': record.reviewReason ?? '',
    '满意度': record.rating ?? null,
    '评分状态': select(ratingStateLabel(record.ratingState)),
    '计划发送时间': formatShanghai(record.dueAt),
    '实际发送时间': formatShanghai(record.sentAt),
    '评价时间': formatShanghai(record.answeredAt),
  };
}

function captureStateLabel(value: LogisticsSessionMasterRecord['captureState']): string | undefined {
  if (value === 'complete') return '完整';
  if (value === 'partial') return '部分';
  return undefined;
}

function surveyStatusLabel(value: LogisticsSessionMasterRecord['surveyStatus']): string {
  const labels: Record<LogisticsSessionMasterRecord['surveyStatus'], string> = {
    scheduled: '待发送',
    sending: '发送中',
    sent: '已发送',
    answered: '已评分',
    timed_out: '已超时',
    invalidated: '已失效',
    cancelled: '已取消',
    failed: '发送失败',
  };
  return labels[value];
}

function taggingStateLabel(value: LogisticsSessionMasterRecord['taggingState']): string {
  const labels: Record<LogisticsSessionMasterRecord['taggingState'], string> = {
    pending_capture: '待采集',
    tagging: '打标中',
    tagged: '已完成',
    needs_review: '待复核',
  };
  return labels[value];
}

function businessLabel(value: string | undefined): string | undefined {
  const labels: Record<string, string> = {
    LB01: 'LB01 电子面单 / 在线寄件',
    LB02: 'LB02 发货 / 履约',
    LB03: 'LB03 订单 / 售后 / 协商',
    LB04: 'LB04 物流工具 / 页面平台',
    LB05: 'LB05 数据 / 报表业务',
    LB06: 'LB06 研发与助手运行环境',
    LB99: 'LB99 其他 / 待复核',
  };
  return value ? labels[value] : undefined;
}

function problemLabel(value: string | undefined): string | undefined {
  const labels: Record<string, string> = {
    LP01: 'LP01 规则或能力咨询',
    LP02: 'LP02 操作指导',
    LP03: 'LP03 页面 / 代码 / 接口链路定位',
    LP04: 'LP04 数据查询与分析',
    LP05: 'LP05 线上异常 / 故障排查',
    LP06: 'LP06 需求方案 / 研发协作',
    LP07: 'LP07 配置 / 权限 / 运行环境',
    LP99: 'LP99 其他 / 待复核',
  };
  return value ? labels[value] : undefined;
}

function resolutionLabel(value: LogisticsSessionMasterRecord['resolutionStatus']): string | undefined {
  const labels: Record<NonNullable<LogisticsSessionMasterRecord['resolutionStatus']>, string> = {
    resolved: '已解决',
    in_progress: '处理中',
    unknown: '未知',
  };
  return value ? labels[value] : undefined;
}

function confidenceLabel(value: LogisticsSessionMasterRecord['overallConfidence']): string | undefined {
  const labels: Record<NonNullable<LogisticsSessionMasterRecord['overallConfidence']>, string> = {
    high: '高',
    medium: '中',
    low: '低',
  };
  return value ? labels[value] : undefined;
}

function ratingStateLabel(value: LogisticsSessionMasterRecord['ratingState']): string {
  if (value === 'rated') return '已评分';
  return value === 'invalidated' ? '待复核' : '未评分';
}

function findRecordId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of ['record_id', 'recordId']) {
    if (typeof obj[key] === 'string' && obj[key]) return obj[key] as string;
  }
  for (const key of ['record_id_list', 'recordIds']) {
    if (Array.isArray(obj[key]) && typeof obj[key][0] === 'string' && obj[key][0]) {
      return obj[key][0] as string;
    }
  }
  for (const child of Object.values(obj)) {
    const found = findRecordId(child);
    if (found) return found;
  }
  return undefined;
}

function findExactRecordIds(value: unknown, masterKey: string): string[] {
  const data = value && typeof value === 'object'
    ? (value as Record<string, unknown>).data
    : undefined;
  if (!data || typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.data) || !Array.isArray(obj.fields) || !Array.isArray(obj.record_id_list)) return [];
  const rows = obj.data as unknown[][];
  const fields = obj.fields as unknown[];
  const recordIds = obj.record_id_list as unknown[];
  const keyIndex = fields.findIndex(field => field === '会话唯一键');
  if (keyIndex < 0) return [];
  return rows.flatMap((row, index) => {
    const cell = Array.isArray(row) ? row[keyIndex] : undefined;
    const normalized = Array.isArray(cell) && cell.length === 1 ? cell[0] : cell;
    return normalized === masterKey && typeof recordIds[index] === 'string'
      ? [recordIds[index] as string]
      : [];
  });
}

const defaultRunner: LogisticsSessionMasterBaseRunner = async (file, args, options) => {
  try {
    const result = await execFileAsync(file, args, {
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      env: options.env,
      encoding: 'utf8',
    });
    return { stdout: result.stdout };
  } catch (error) {
    const code = typeof (error as { code?: unknown })?.code === 'number'
      ? (error as { code: number }).code
      : undefined;
    throw new Error(code === undefined
      ? 'lark-cli logistics session master request failed'
      : `lark-cli logistics session master request failed (exit ${code})`);
  }
};

async function runJson(
  runner: LogisticsSessionMasterBaseRunner,
  args: string[],
): Promise<unknown> {
  const { stdout } = await runner('lark-cli', args, {
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      LARK_CLI_DISABLE_UPDATE_CHECK: '1',
      LARK_CLI_DISABLE_SKILL_NOTIFIER: '1',
    },
  });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error('lark-cli logistics session master returned non-JSON output');
  }
}

export function createLogisticsSessionMasterBaseUpserter(
  runner: LogisticsSessionMasterBaseRunner = defaultRunner,
): LogisticsSessionMasterBaseUpsert {
  return async ({ config, record }) => {
    let recordId = record.baseRecordId;
    if (!recordId) {
      const listed = await runJson(runner, [
        'base',
        '+record-list',
        '--as',
        config.identity,
        '--base-token',
        config.appToken,
        '--table-id',
        config.tableId,
        '--field-id',
        '会话唯一键',
        '--limit',
        '20',
        '--filter-json',
        JSON.stringify({ logic: 'and', conditions: [['会话唯一键', '==', record.masterKey]] }),
        '--format',
        'json',
      ]);
      const matches = findExactRecordIds(listed, record.masterKey);
      if (matches.length > 1) throw new Error('logistics_session_master_duplicate_key');
      recordId = matches[0];
    }
    const fields = fieldsForBase(record);
    if (recordId) {
      await runJson(runner, [
        'base',
        '+record-batch-update',
        '--as',
        config.identity,
        '--base-token',
        config.appToken,
        '--table-id',
        config.tableId,
        '--json',
        JSON.stringify({ update_records: { [recordId]: fields } }),
        '--format',
        'json',
      ]);
      return { recordId };
    }
    const written = await runJson(runner, [
      'base',
      '+record-batch-create',
      '--as',
      config.identity,
      '--base-token',
      config.appToken,
      '--table-id',
      config.tableId,
      '--json',
      JSON.stringify({ create_records: [fields] }),
      '--format',
      'json',
    ]);
    return { recordId: findRecordId(written) };
  };
}
