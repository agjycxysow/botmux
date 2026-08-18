import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  FeedbackSurveyBaseUpsert,
  FeedbackSurveyRecord,
} from './feedback-survey.js';

const execFileAsync = promisify(execFile);

export type FeedbackSurveyBaseRunner = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

function formatShanghai(value: number | undefined): string | undefined {
  if (!value) return undefined;
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

function fieldsForBase(record: FeedbackSurveyRecord): Record<string, unknown> {
  const status = record.status === 'sending'
    ? 'scheduled'
    : record.status === 'invalidated'
      ? 'failed'
      : record.status;
  const fields: Record<string, unknown> = {
    '问卷 ID': record.surveyId,
    'Session ID': record.sessionId,
    'Turn ID': record.turnId,
    '会话摘要': record.recap ?? '',
    '问卷状态': status,
    'Bot App ID': record.larkAppId,
    'CLI': record.cliId ?? '',
    '原对话': record.rootMessageLink ? `[原对话](${record.rootMessageLink})` : '',
    '满意度卡片': record.cardMessageLink ? `[满意度卡片](${record.cardMessageLink})` : '',
    '提问者': [{ id: record.respondentOpenId }],
    '计划发送时间': formatShanghai(record.dueAt) ?? '',
    '实际发送时间': formatShanghai(record.sentAt) ?? '',
    '评价时间': formatShanghai(record.answeredAt) ?? '',
  };
  if (record.rating !== undefined) fields['评分'] = record.rating;
  return fields;
}

function findRecordId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of ['record_id', 'recordId']) {
    if (typeof obj[key] === 'string' && obj[key]) return obj[key] as string;
  }
  for (const child of Object.values(obj)) {
    const found = findRecordId(child);
    if (found) return found;
  }
  return undefined;
}

const defaultRunner: FeedbackSurveyBaseRunner = async (file, args, options) => {
  const result = await execFileAsync(file, args, {
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    env: options.env,
    encoding: 'utf8',
  });
  return { stdout: result.stdout };
};

/** The process runner is injectable so tests can cover fields and update reuse
 * without invoking a real lark-cli or requiring a Base token. */
export function createFeedbackSurveyBaseUpserter(
  runner: FeedbackSurveyBaseRunner = defaultRunner,
): FeedbackSurveyBaseUpsert {
  return async ({ config, record }) => {
    const args = [
      'base',
      '+record-upsert',
      '--as',
      config.identity,
      '--base-token',
      config.appToken,
      '--table-id',
      config.tableId,
      '--json',
      JSON.stringify(fieldsForBase(record)),
      '--format',
      'json',
      ...(record.baseRecordId ? ['--record-id', record.baseRecordId] : []),
    ];
    const { stdout } = await runner('lark-cli', args, {
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        LARK_CLI_DISABLE_UPDATE_CHECK: '1',
        LARK_CLI_DISABLE_SKILL_NOTIFIER: '1',
      },
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error('lark-cli base upsert returned non-JSON output');
    }
    return { recordId: findRecordId(parsed) };
  };
}
