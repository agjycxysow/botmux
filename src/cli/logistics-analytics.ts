import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { resolveLogisticsHarnessRevision } from '../services/logistics-session-model-task.js';
import {
  LogisticsAnalysisStore,
  type LogisticsAnalysisCaptureStatus,
  type LogisticsAnalysisDetail,
  type LogisticsAnalysisFilters,
  type LogisticsAnalysisLabelStatus,
  type LogisticsAnalysisResolutionStatus,
  type LogisticsAnalysisSessionStatus,
} from '../services/logistics-analysis-store.js';
import { renderLogisticsAnalyticsPage } from './logistics-analytics-page.js';

export interface LogisticsAnalyticsServerOptions {
  dataDir: string;
  databasePath?: string;
  host?: string;
  port?: number;
  accessToken?: string;
  labelerRevision?: string;
}

type AnalyticsRunStatus = 'running' | 'succeeded' | 'partial' | 'failed';

interface AnalyticsRunStatusProjection {
  available: true;
  schemaVersion: 1;
  status: AnalyticsRunStatus;
  startedAt: number;
  finishedAt: number | null;
  lastSuccessfulSyncAt: number | null;
  lastSuccessfulCaptureAt: number | null;
  lastSuccessfulLabelAt: number | null;
  pendingCapture: number;
  pendingLabel: number;
  errorCode: string | null;
}

interface AnalyticsRunStatusUnavailable {
  available: false;
  message: '尚无调度记录/状态不可用';
}

const CAPTURE_STATUS_ALIASES: Record<string, LogisticsAnalysisCaptureStatus> = {
  pending: 'pending',
  processing: 'running',
  running: 'running',
  captured: 'captured',
  partial: 'partial',
  missing_turn: 'partial',
  missing_answer: 'partial',
  failed: 'failed',
  history_failed: 'failed',
  conflict: 'conflict',
};

const CAPTURE_STATUSES = new Set<LogisticsAnalysisCaptureStatus>([
  'pending', 'running', 'captured', 'partial', 'failed', 'conflict',
]);
const LABEL_STATUSES = new Set<LogisticsAnalysisLabelStatus>([
  'not_ready', 'pending', 'running', 'failed', 'labeled',
]);
const RESOLUTION_STATUSES = new Set<LogisticsAnalysisResolutionStatus>([
  'resolved', 'in_progress', 'unknown',
]);
const SESSION_STATUSES = new Set<LogisticsAnalysisSessionStatus>([
  'active', 'closed', 'unknown',
]);
const RUN_STATUSES = new Set<AnalyticsRunStatus>([
  'running', 'succeeded', 'partial', 'failed',
]);

function escapeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\\u2028/g, '\\u2028')
    .replace(/\\u2029/g, '\\u2029');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const content = escapeJson(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(content),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  });
  res.end(content);
}

function sendHtml(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  });
  res.end(body);
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    'content-type': 'text/plain; charset=utf-8',
    'www-authenticate': 'Bearer realm="botmux-analytics"',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  });
  res.end('unauthorized');
}

function safeEqual(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    try {
      out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // Ignore malformed cookies and continue with bearer authentication.
    }
  }
  return out;
}

function authorized(req: IncomingMessage, url: URL, token: string | undefined): boolean {
  if (!token) return true;
  const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  return safeEqual(bearer || cookies(req).botmux_analytics || '', token)
    || safeEqual(url.searchParams.get('t') ?? '', token);
}

function exchangeQueryToken(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (!url.searchParams.has('t')) return false;
  const token = url.searchParams.get('t') ?? '';
  url.searchParams.delete('t');
  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '').toLowerCase();
  const secure = forwardedProto === 'https' || Boolean((req.socket as { encrypted?: boolean }).encrypted);
  res.writeHead(302, {
    location: `${url.pathname}${url.search}`,
    'set-cookie': `botmux_analytics=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure ? '; Secure' : ''}`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  });
  res.end();
  return true;
}

function optionalQuery(url: URL, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value !== null && value.trim()) return value.trim();
  }
  return undefined;
}

function mapCaptureStatus(url: URL): LogisticsAnalysisCaptureStatus | undefined {
  const raw = optionalQuery(url, 'captureStatus', 'dataStatus');
  if (!raw) return undefined;
  const mapped = CAPTURE_STATUS_ALIASES[raw];
  if (mapped) return mapped;
  if (raw === 'skipped') throw new Error('analysis_data_status_unsupported:skipped');
  throw new Error(`analysis_capture_status_invalid:${raw}`);
}

function parseNeedsReview(url: URL): boolean | undefined {
  const raw = url.searchParams.get('needsReview');
  if (raw === null || raw === '') return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`analysis_needs_review_invalid:${raw}`);
}

function analysisFilters(url: URL, labelerRevision: string): LogisticsAnalysisFilters {
  const labelStatus = optionalQuery(url, 'labelStatus');
  if (labelStatus && !LABEL_STATUSES.has(labelStatus as LogisticsAnalysisLabelStatus)) {
    throw new Error(`analysis_label_status_invalid:${labelStatus}`);
  }
  const resolutionStatus = optionalQuery(url, 'resolutionStatus', 'resolution');
  if (resolutionStatus && !RESOLUTION_STATUSES.has(resolutionStatus as LogisticsAnalysisResolutionStatus)) {
    throw new Error(`analysis_resolution_status_invalid:${resolutionStatus}`);
  }
  const sessionStatus = optionalQuery(url, 'sessionStatus');
  if (sessionStatus && !SESSION_STATUSES.has(sessionStatus as LogisticsAnalysisSessionStatus)) {
    throw new Error(`analysis_session_status_invalid:${sessionStatus}`);
  }
  const scope = optionalQuery(url, 'scope');
  if (scope && scope !== 'thread') throw new Error(`analysis_scope_invalid:${scope}`);
  const captureStatus = mapCaptureStatus(url);
  if (captureStatus && !CAPTURE_STATUSES.has(captureStatus)) {
    throw new Error(`analysis_capture_status_invalid:${captureStatus}`);
  }
  const needsReview = parseNeedsReview(url);
  return {
    labelerRevision,
    ...(optionalQuery(url, 'from') ? { from: optionalQuery(url, 'from') } : {}),
    ...(optionalQuery(url, 'to') ? { to: optionalQuery(url, 'to') } : {}),
    ...(optionalQuery(url, 'botId', 'bot') ? { botId: optionalQuery(url, 'botId', 'bot') } : {}),
    ...(scope ? { scope: 'thread' as const } : {}),
    ...(sessionStatus ? { sessionStatus: sessionStatus as LogisticsAnalysisSessionStatus } : {}),
    ...(captureStatus ? { captureStatus } : {}),
    ...(labelStatus ? { labelStatus: labelStatus as LogisticsAnalysisLabelStatus } : {}),
    ...(optionalQuery(url, 'lb') ? { lb: optionalQuery(url, 'lb') } : {}),
    ...(optionalQuery(url, 'lp') ? { lp: optionalQuery(url, 'lp') } : {}),
    ...(resolutionStatus ? { resolutionStatus: resolutionStatus as LogisticsAnalysisResolutionStatus } : {}),
    ...(needsReview === undefined ? {} : { needsReview }),
  };
}

function integerQuery(url: URL, name: string, defaultValue: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return defaultValue;
  if (!/^\d+$/.test(raw)) throw new Error(`analysis_invalid_${name}:${raw}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`analysis_invalid_${name}:${raw}`);
  return value;
}

function safeDetail(detail: LogisticsAnalysisDetail): Record<string, unknown> {
  return {
    topicPublicId: detail.topicPublicId,
    title: detail.title,
    botName: detail.botName,
    captureStatus: detail.captureStatus,
    labelStatus: detail.labelStatus,
    lb: detail.lb,
    lp: detail.lp,
    resolutionStatus: detail.resolutionStatus,
    confidence: detail.confidence,
    needsReview: detail.needsReview,
    dataTime: detail.dataTime,
    messages: detail.messages.map(message => ({
      role: message.role,
      content: message.content,
      occurredAt: message.occurredAt,
    })),
  };
}

function isSafeTimestamp(value: unknown, nullable: boolean): value is number | null {
  return (nullable && value === null)
    || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function unavailableStatus(): AnalyticsRunStatusUnavailable {
  return { available: false, message: '尚无调度记录/状态不可用' };
}

function readRunStatus(databasePath: string): AnalyticsRunStatusProjection | AnalyticsRunStatusUnavailable {
  try {
    const raw = JSON.parse(readFileSync(`${databasePath}.run.json`, 'utf8')) as Record<string, unknown>;
    if (!raw || Array.isArray(raw) || raw.schemaVersion !== 1 || !RUN_STATUSES.has(raw.status as AnalyticsRunStatus)) {
      return unavailableStatus();
    }
    const nullableTimestamps = ['finishedAt', 'lastSuccessfulSyncAt', 'lastSuccessfulCaptureAt', 'lastSuccessfulLabelAt'];
    if (!isSafeTimestamp(raw.startedAt, false) || nullableTimestamps.some(key => !isSafeTimestamp(raw[key], true))) {
      return unavailableStatus();
    }
    if (!isCount(raw.pendingCapture) || !isCount(raw.pendingLabel)) return unavailableStatus();
    if (raw.errorCode !== null && typeof raw.errorCode !== 'string') return unavailableStatus();
    return {
      available: true,
      schemaVersion: 1,
      status: raw.status as AnalyticsRunStatus,
      startedAt: Number(raw.startedAt),
      finishedAt: raw.finishedAt as number | null,
      lastSuccessfulSyncAt: raw.lastSuccessfulSyncAt as number | null,
      lastSuccessfulCaptureAt: raw.lastSuccessfulCaptureAt as number | null,
      lastSuccessfulLabelAt: raw.lastSuccessfulLabelAt as number | null,
      pendingCapture: Number(raw.pendingCapture),
      pendingLabel: Number(raw.pendingLabel),
      errorCode: typeof raw.errorCode === 'string' ? raw.errorCode.slice(0, 200) : null,
    };
  } catch {
    return unavailableStatus();
  }
}

function openReadOnlyStore(dataDir: string, databasePath: string): LogisticsAnalysisStore {
  if (!existsSync(databasePath)) throw new Error('analytics_database_missing');
  try {
    return new LogisticsAnalysisStore({ dataDir, path: databasePath, readOnly: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('analysis_database_not_four_table')
      || message.startsWith('analysis_schema_version_unsupported')) {
      throw new Error('analytics_database_unsupported_four_table_only');
    }
    throw error;
  }
}

export function createLogisticsAnalyticsServer(options: LogisticsAnalyticsServerOptions) {
  const labelerRevision = options.labelerRevision?.trim();
  if (!labelerRevision) throw new Error('analysis_labeler_revision_required');
  if (options.host && options.host !== '127.0.0.1' && options.host !== '::1' && !options.accessToken) {
    throw new Error('BOTMUX_ANALYTICS_TOKEN is required when binding beyond loopback');
  }
  const databasePath = resolve(options.databasePath ?? join(options.dataDir, 'logistics-analysis.sqlite'));
  const store = openReadOnlyStore(options.dataDir, databasePath);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end('method_not_allowed');
    }
    if (!authorized(req, url, options.accessToken)) return unauthorized(res);
    if (options.accessToken && exchangeQueryToken(req, res, url)) return;
    try {
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204, { 'cache-control': 'no-store' });
        return res.end();
      }
      if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
      if (url.pathname === '/api/status') return sendJson(res, 200, readRunStatus(databasePath));
      if (url.pathname === '/api/overview') {
        return sendJson(res, 200, store.summary(analysisFilters(url, labelerRevision)));
      }
      if (url.pathname === '/api/trend') {
        return sendJson(res, 200, store.trend(analysisFilters(url, labelerRevision)));
      }
      if (url.pathname === '/api/distributions') {
        return sendJson(res, 200, store.distributions(analysisFilters(url, labelerRevision)));
      }
      if (url.pathname === '/api/sessions') {
        return sendJson(res, 200, store.list(analysisFilters(url, labelerRevision), {
          limit: integerQuery(url, 'limit', 50),
          offset: integerQuery(url, 'offset', 0),
        }));
      }
      const detailMatch = url.pathname.match(/^\/api\/sessions\/(.+)$/);
      if (detailMatch) {
        const item = store.detail(decodeURIComponent(detailMatch[1]!), { labelerRevision });
        return item ? sendJson(res, 200, safeDetail(item)) : sendJson(res, 404, { error: 'not_found' });
      }
      if (url.pathname === '/' || url.pathname === '/overview') {
        return sendHtml(res, renderLogisticsAnalyticsPage());
      }
      return sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.startsWith('analysis_') ? message.slice(0, 240) : 'analytics_request_failed';
      return sendJson(res, 400, { error: code });
    }
  });
  server.on('close', () => store.close());
  return server;
}

function optionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0) {
    const next = args[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`analytics_option_value_required:${flag}`);
    return next;
  }
  const prefix = `${flag}=`;
  const equal = args.find(item => item.startsWith(prefix));
  return equal?.slice(prefix.length) || undefined;
}

function assertKnownOptions(args: string[]): void {
  const known = new Set(['--host', '--port', '--db', '--harness-root', '--labeler-revision']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (!known.has(flag)) throw new Error(`analytics_option_unknown:${arg}`);
    if (!arg.includes('=')) index += 1;
  }
}

export async function runLogisticsAnalyticsCommand(sub: string, args: string[], dataDir: string): Promise<void> {
  if (sub !== 'serve') {
    throw new Error('Usage: botmux analytics serve [--host 127.0.0.1] [--port 17870] [--db <path>] [--harness-root <dir>|--labeler-revision <revision>]');
  }
  assertKnownOptions(args);
  const host = optionValue(args, '--host') ?? process.env.BOTMUX_ANALYTICS_HOST ?? '127.0.0.1';
  const port = Number(optionValue(args, '--port') ?? process.env.BOTMUX_ANALYTICS_PORT ?? 17870);
  const dbArg = optionValue(args, '--db');
  const databasePath = resolve(dbArg ?? process.env.BOTMUX_ANALYTICS_DB ?? join(dataDir, 'logistics-analysis.sqlite'));
  const harnessRoot = optionValue(args, '--harness-root') ?? process.env.LOGISTICS_CONVERSATION_HARNESS_ROOT;
  const explicitRevision = optionValue(args, '--labeler-revision')?.trim();
  const labelerRevision = explicitRevision || (harnessRoot ? resolveLogisticsHarnessRevision(harnessRoot) : undefined);
  if (!labelerRevision) throw new Error('analysis_labeler_revision_required');
  const accessToken = process.env.BOTMUX_ANALYTICS_TOKEN?.trim() || undefined;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid_analytics_port:${port}`);
  if (host !== '127.0.0.1' && host !== '::1' && !accessToken) {
    throw new Error('BOTMUX_ANALYTICS_TOKEN is required when binding beyond loopback');
  }
  const server = createLogisticsAnalyticsServer({ dataDir, databasePath, host, port, accessToken, labelerRevision });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      console.log(`BotMux logistics analytics listening on http://${host}:${port}/overview`);
      resolvePromise();
    });
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await new Promise(() => {});
}
