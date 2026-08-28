import { resolve } from 'node:path';

import * as Lark from '@larksuiteoapi/node-sdk';

import { configureLarkClientHttpTimeout, loadBotConfigs, type BotConfig } from '../bot-registry.js';
import { normalizeBrand, sdkDomain } from '../im/lark/lark-hosts.js';
import { LogisticsConversationStore } from '../services/logistics-conversation-store.js';
import {
  runLogisticsProjectBase,
  type LogisticsProjectBaseClient,
  type LogisticsProjectBaseFieldSpec,
  type LogisticsProjectBaseFields,
} from '../services/logistics-project-base.js';

interface Options {
  apply: boolean;
  bot?: string;
  baseToken?: string;
  tableName?: string;
  databasePath?: string;
  assumeTableMissing: boolean;
}

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(`Usage:
  botmux logistics project-base [--bot <appId>] [--base-token <token>] [--table-name <name>] [--db <path>] [--assume-table-missing] [--apply]

Defaults to dry-run. The command reads SQLite as the only source of truth, uses the
selected Bot application's tenant identity for Base access, never deletes records,
and writes only when --apply is present. --assume-table-missing is dry-run only.`);
  process.exit(2);
}

function value(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0) {
    const next = args[index + 1];
    if (!next || next.startsWith('--')) usage(`Missing value for ${flag}`);
    return next;
  }
  const prefix = `${flag}=`;
  return args.find(arg => arg.startsWith(prefix))?.slice(prefix.length) || undefined;
}

function parse(args: string[]): Options {
  const withValue = new Set(['--bot', '--base-token', '--table-name', '--db']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--apply' || arg === '--assume-table-missing') continue;
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (!withValue.has(flag)) usage(`Unknown option: ${arg}`);
    if (!arg.includes('=')) index += 1;
  }
  return {
    apply: args.includes('--apply'), assumeTableMissing: args.includes('--assume-table-missing'),
    bot: value(args, '--bot'), baseToken: value(args, '--base-token'),
    tableName: value(args, '--table-name'), databasePath: value(args, '--db'),
  };
}

function selectBot(configs: BotConfig[], appId: string | undefined): BotConfig {
  if (appId) {
    const found = configs.find(config => config.larkAppId === appId);
    if (!found) usage(`Bot not found: ${appId}`);
    return found;
  }
  const enabled = configs.filter(config => config.logisticsSessionMaster?.enabled === true);
  if (enabled.length === 1) return enabled[0]!;
  usage('Pass --bot <appId> when zero or multiple logistics bots are configured');
}

function check(response: any, operation: string): any {
  if (response?.code && response.code !== 0) throw new Error(`${operation}_failed:${response.code}:${response.msg ?? ''}`);
  return response?.data ?? {};
}

async function call<T>(operation: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const value = error as any;
    const data = value?.response?.data ?? {};
    const code = typeof data.code === 'number' ? data.code : value?.code;
    const logId = data.log_id ?? data.logId;
    const safe = new Error(`${operation}_failed${code !== undefined ? `:${code}` : ''}${logId ? `:log_id=${logId}` : ''}`) as Error & { code?: number };
    if (typeof code === 'number') safe.code = code;
    throw safe;
  }
}

function sdkClient(client: any): LogisticsProjectBaseClient {
  return {
    async listTables(input) {
      const data = check(await call('base_table_list', () => client.bitable.appTable.list({ path: { app_token: input.baseToken }, params: { page_size: input.pageSize, ...(input.pageToken ? { page_token: input.pageToken } : {}) } })), 'base_table_list');
      return { items: (data.items ?? []).map((item: any) => ({ tableId: String(item.table_id), name: String(item.name) })), hasMore: data.has_more === true, ...(data.page_token ? { pageToken: String(data.page_token) } : {}) };
    },
    async listFields(input) {
      const data = check(await call('base_field_list', () => client.bitable.appTableField.list({ path: { app_token: input.baseToken, table_id: input.tableId }, params: { page_size: input.pageSize, ...(input.pageToken ? { page_token: input.pageToken } : {}) } })), 'base_field_list');
      return { items: (data.items ?? []).map((item: any) => ({ name: String(item.field_name), type: Number(item.type) })), hasMore: data.has_more === true, ...(data.page_token ? { pageToken: String(data.page_token) } : {}) };
    },
    async listRecords(input) {
      const data = check(await call('base_record_list', () => client.bitable.appTableRecord.list({ path: { app_token: input.baseToken, table_id: input.tableId }, params: { page_size: input.pageSize, text_field_as_array: false, automatic_fields: false, ...(input.pageToken ? { page_token: input.pageToken } : {}) } })), 'base_record_list');
      return { items: (data.items ?? []).map((item: any) => ({ recordId: String(item.record_id), fields: item.fields ?? {} })), hasMore: data.has_more === true, ...(data.page_token ? { pageToken: String(data.page_token) } : {}) };
    },
    async createTable(input) {
      const fields = input.fields.map((field: LogisticsProjectBaseFieldSpec) => ({
        field_name: field.name, type: field.type, ui_type: field.uiType,
        ...(field.options ? { property: { options: field.options.map(name => ({ name })), multiple: false } } : {}),
        ...(field.formatter ? { property: { date_formatter: field.formatter } } : {}),
      }));
      const data = check(await call('base_table_create', () => client.bitable.appTable.create({ path: { app_token: input.baseToken }, data: { table: { name: input.name, fields } } })), 'base_table_create');
      if (!data.table_id) throw new Error('base_table_create_missing_table_id');
      return { tableId: String(data.table_id) };
    },
    async batchCreate(input) {
      check(await call('base_record_batch_create', () => client.bitable.appTableRecord.batchCreate({ path: { app_token: input.baseToken, table_id: input.tableId }, params: { client_token: input.clientToken }, data: { records: input.records.map((fields: LogisticsProjectBaseFields) => ({ fields })) } })), 'base_record_batch_create');
    },
    async batchUpdate(input) {
      check(await call('base_record_batch_update', () => client.bitable.appTableRecord.batchUpdate({ path: { app_token: input.baseToken, table_id: input.tableId }, data: { records: input.records.map(record => ({ record_id: record.recordId, fields: record.fields })) } })), 'base_record_batch_update');
    },
  };
}

export async function projectLogisticsBase(dataDir: string, args: string[]): Promise<void> {
  const options = parse(args);
  const bot = selectBot(loadBotConfigs(), options.bot);
  const baseToken = options.baseToken ?? bot.logisticsSessionMaster?.larkBase?.appToken;
  if (!baseToken) usage('Missing --base-token and logisticsSessionMaster.larkBase.appToken');
  if (options.apply && options.assumeTableMissing) usage('--assume-table-missing cannot be combined with --apply');
  const larkClient = new Lark.Client({
    appId: bot.larkAppId,
    appSecret: bot.larkAppSecret,
    domain: sdkDomain(normalizeBrand(bot.brand)),
    logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} },
  });
  configureLarkClientHttpTimeout(larkClient);
  const store = new LogisticsConversationStore({
    dataDir,
    path: options.databasePath ? resolve(options.databasePath) : bot.logisticsSessionMaster?.sqlite?.path,
    readOnly: true,
  });
  try {
    const result = await runLogisticsProjectBase({
      client: sdkClient(larkClient), baseToken,
      ...(options.tableName ? { tableName: options.tableName } : {}),
      rows: store.listProjectBaseRows(bot.larkAppId),
      botLabel: bot.displayName ?? bot.name ?? bot.larkAppId,
      apply: options.apply, assumeTableMissing: options.assumeTableMissing,
    });
    console.log(JSON.stringify({
      ...result,
      identity: 'bot',
      sourceOfTruth: store.path,
      deletes: 0,
      assumedTableMissing: options.assumeTableMissing,
    }, null, 2));
  } finally {
    store.close();
  }
}
