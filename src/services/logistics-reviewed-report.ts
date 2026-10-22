import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const REVIEW_CHAT = 'oc_9d56ca617abdd6aa851732e32b4783ac';
export const REVIEW_BOTS = ['cli_aad48799ad38dbc1', 'cli_a93aac77d3781cb6'];
export const REVIEW_POLICY = 'logistics-thread-review/2';
export const LEGACY_REVIEW_POLICY = 'logistics-thread-review/1';
const HOURS_CENTS: Record<string, number> = { LP01: 100, LP02: 175, LP03: 220, LP04: 125, LP05: 725, LP99: 0 };
const CATEGORY_NAMES: Record<string, string> = {
  LP01: '前端埋点查询', LP02: '业务数据查询', LP03: '线上问题排查',
  LP04: '业务功能咨询', LP05: '商家反馈分析', LP99: '其他',
};
const LEGACY_HOURS_CENTS: Record<string, number> = { frontend: 100, data: 175, troubleshoot: 220, consult: 125, feedback: 725, other: 0, development: 100 };
const LEGACY_CATEGORY_NAMES: Record<string, string> = { frontend: '前端埋点查询', data: '业务数据查询', troubleshoot: '线上问题排查', consult: '业务功能咨询', feedback: '商家反馈分析', other: '其他', development: '小需求开发' };
const MAX_CHECK_AGE = 90 * 60_000;
type Status = 'resolved' | 'in_progress' | 'unknown' | 'invalid';
export interface ReviewTopic {
  rootId: string; threadId: string; botId: string | null; sessionKey: string | null;
  sourceDigest: string; createdAt: number; latestMessageAt: number; questioner: string | null;
  status: Status; category: string; effectiveRounds: number; reason: string;
  title: string; url: string; answerCount: number; messageCount: number;
}
export interface ReviewPayload {
  policy: typeof REVIEW_POLICY | typeof LEGACY_REVIEW_POLICY; batchId: string; chatId: string; asOf: number;
  catalogComplete: boolean; threadsComplete: boolean; sourceFrom: string;
  reviewer: string; identityNamespace: string; referenceUrl: string;
  ratings: Array<{ id: string; value: number; rootId: string; answeredAt: number }>;
  expected: { valid: number; resolved: number; unknown: number; people: number; netCents: number };
  topics: ReviewTopic[];
}
export interface SourceMessage {
  message_id: string; content: string; create_time: string; deleted: boolean; msg_type: string;
  sender?: { id?: string; sender_type?: string }; thread_id?: string;
}
export interface SourceObservation { rootId: string; sourceDigest: string }
export interface CoverageCheck {
  status: 'complete' | 'incomplete' | 'running'; checkedAt: number; error?: string;
  missingReviews?: number; missingSources?: number; changedTopics?: number;
  catalogComplete: boolean; threadsComplete: boolean; observedTopics: number;
}
export class ReviewIncomplete extends Error {
  constructor(public readonly coverage: unknown, public readonly asOf?: string) {
    super('统计未完成：群消息覆盖或复核证据尚未校验完整，请补采集并复核后再统计。');
  }
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function sourceTime(value: string): number {
  const date = /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(value) ? `${value.replace(' ', 'T')}:00+08:00` : value;
  const parsed = Date.parse(date); if (!Number.isFinite(parsed)) throw new Error('review_source_time_invalid'); return parsed;
}
function canonicalContent(value: string): string {
  return value.replace(/\\n/g, '\n').replace(/\([^)]*\bou_[a-zA-Z0-9]+\)/g, '')
    .replace(/(?:access_token|refresh_token|app_secret|appsecret|client_secret|password)[\\\s"':=]+(?:\[REDACTED\]|[A-Za-z0-9._~-]{8,})/gi, '[credential-redacted]')
    .replace(/\bou_[A-Za-z0-9]+\b/g, '[subject]')
    .replace(/[\u200b-\u200f\u2060-\u206f\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}
export function sourceDigest(root: SourceMessage, messages: SourceMessage[]): string {
  const byId = new Map(messages.map(m => [m.message_id, m])); byId.set(root.message_id, root);
  return hash([...byId.values()].sort((a, b) => a.message_id.localeCompare(b.message_id, 'en')).map(m => ({
    id: m.message_id, created: sourceTime(m.create_time), deleted: Boolean(m.deleted), type: m.msg_type,
    content: m.deleted ? '' : canonicalContent(m.content), app: m.sender?.sender_type === 'app' ? m.sender.id : null,
  })));
}
export function validatePayload(p: ReviewPayload): void {
  if (![REVIEW_POLICY, LEGACY_REVIEW_POLICY].includes(p.policy) || p.chatId !== REVIEW_CHAT || !p.batchId || !p.reviewer || !p.identityNamespace
      || !Number.isSafeInteger(p.asOf) || !p.catalogComplete || !p.threadsComplete || !p.topics.length)
    throw new Error('review_import_manifest_incomplete');
  const roots = new Set<string>();
  const categoryNames = p.policy === REVIEW_POLICY ? CATEGORY_NAMES : LEGACY_CATEGORY_NAMES;
  for (const t of p.topics) {
    if (!t.rootId || roots.has(t.rootId) || !/^[a-f0-9]{64}$/.test(t.sourceDigest) || !t.reason
        || !Object.hasOwn(categoryNames, t.category) || !['resolved', 'in_progress', 'unknown', 'invalid'].includes(t.status)
        || !Number.isSafeInteger(t.createdAt) || !Number.isSafeInteger(t.latestMessageAt)
        || t.latestMessageAt > p.asOf || !Number.isSafeInteger(t.effectiveRounds) || t.effectiveRounds < 0
        || (t.status !== 'invalid' && (!t.questioner || t.effectiveRounds < 1))
        || (t.status === 'resolved' && t.answerCount < 1)) throw new Error('review_import_topic_invalid');
    roots.add(t.rootId);
  }
  const ids = new Set<string>();
  for (const score of p.ratings) {
    if (!score.id || ids.has(score.id) || !Number.isInteger(score.value) || score.value < 1 || score.value > 5
        || !roots.has(score.rootId) || !Number.isSafeInteger(score.answeredAt) || score.answeredAt > p.asOf)
      throw new Error('review_import_rating_invalid');
    ids.add(score.id);
  }
  const got = aggregate(p.topics, p.policy);
  if (got.valid !== p.expected.valid || got.resolved !== p.expected.resolved || got.unknown !== p.expected.unknown
      || got.people !== p.expected.people || got.netCents !== p.expected.netCents) throw new Error('review_import_totals_mismatch');
}
export function aggregate(topics: ReviewTopic[], policy: ReviewPayload['policy'] = REVIEW_POLICY) {
  const valid = topics.filter(t => t.status !== 'invalid');
  const hours = policy === REVIEW_POLICY ? HOURS_CENTS : LEGACY_HOURS_CENTS;
  const names = policy === REVIEW_POLICY ? CATEGORY_NAMES : LEGACY_CATEGORY_NAMES;
  let grossCents = 0, costCents = 0, eligible = 0;
  const categories = Object.entries(hours).map(([category, cents]) => {
    const all = valid.filter(t => t.category === category), solved = all.filter(t => t.status === 'resolved');
    const gross = solved.length * cents, cost = solved.reduce((s, t) => s + Math.max(0, t.effectiveRounds - 4) * 5, 0);
    grossCents += gross; costCents += cost; eligible += solved.length;
    return { taskType: category, name: names[category], topicCount: all.length, resolvedCount: solved.length,
      inProgressCount: all.filter(t => t.status === 'in_progress').length,
      unknownCount: all.filter(t => t.status === 'unknown').length,
      resolutionRate: all.length ? solved.length / all.length : null, hoursPerResolvedTopic: cents / 100,
      grossHours: gross / 100, followupCostHours: cost / 100, savedHours: (gross - cost) / 100 };
  });
  return { valid: valid.length, resolved: valid.filter(t => t.status === 'resolved').length,
    inProgress: valid.filter(t => t.status === 'in_progress').length, unknown: valid.filter(t => t.status === 'unknown').length,
    invalid: topics.length - valid.length, people: new Set(valid.map(t => t.questioner)).size,
    grossCents, costCents, netCents: grossCents - costCents, eligible, categories };
}
function schema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS logistics_review_batches (
    batch_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, as_of INTEGER NOT NULL,
    payload_hash TEXT NOT NULL, data_json TEXT NOT NULL, imported_at INTEGER NOT NULL, validation_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS logistics_review_topics (
    batch_id TEXT NOT NULL REFERENCES logistics_review_batches(batch_id), root_id TEXT NOT NULL,
    source_digest TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(batch_id,root_id));`);
}
/** The caller holds the hourly flock and the collector's withFileLock while importing. */
export function importReview(db: DatabaseSync, payload: ReviewPayload, now = Date.now()) {
  validatePayload(payload); const digest = payloadHash(payload);
  db.exec('BEGIN IMMEDIATE');
  try {
    schema(db);
    const existing = db.prepare('SELECT payload_hash FROM logistics_review_batches WHERE batch_id=?').get(payload.batchId);
    if (existing) {
      if (existing.payload_hash !== digest) throw new Error('review_import_batch_immutable');
      db.exec('COMMIT'); return { unchanged: true, batchId: payload.batchId, ...aggregate(payload.topics, payload.policy) };
    }
    const { topics, ...manifest } = payload;
    const initial: CoverageCheck = { status: 'incomplete', checkedAt: now, catalogComplete: false,
      threadsComplete: false, observedTopics: 0, error: 'live_source_check_required' };
    db.prepare('INSERT INTO logistics_review_batches VALUES(?,?,?,?,?,?,?)').run(payload.batchId, payload.chatId,
      payload.asOf, digest, JSON.stringify(manifest), now, JSON.stringify(initial));
    const insert = db.prepare('INSERT INTO logistics_review_topics VALUES(?,?,?,?)');
    for (const t of topics) insert.run(payload.batchId, t.rootId, t.sourceDigest, JSON.stringify(t));
    db.exec('COMMIT'); return { unchanged: false, batchId: payload.batchId, ...aggregate(topics, payload.policy) };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function load(db: DatabaseSync, asOf?: number) {
  const batch = asOf === undefined
    ? db.prepare('SELECT * FROM logistics_review_batches WHERE chat_id=? ORDER BY as_of DESC,batch_id DESC LIMIT 1').get(REVIEW_CHAT)
    : db.prepare('SELECT * FROM logistics_review_batches WHERE chat_id=? AND as_of=? ORDER BY batch_id DESC LIMIT 1').get(REVIEW_CHAT, asOf);
  if (!batch) throw new ReviewIncomplete({ status: 'incomplete', error: 'review_snapshot_missing' });
  const topics = db.prepare('SELECT root_id,source_digest,data_json FROM logistics_review_topics WHERE batch_id=? ORDER BY root_id').all(String(batch.batch_id))
    .map(row => {
      const topic = JSON.parse(String(row.data_json)) as ReviewTopic;
      if (topic.rootId !== row.root_id || topic.sourceDigest !== row.source_digest) throw new Error('review_snapshot_corrupt');
      return topic;
    });
  const payload = { ...JSON.parse(String(batch.data_json)), topics } as ReviewPayload;
  validatePayload(payload);
  if (payloadHash(payload) !== batch.payload_hash) throw new Error('review_snapshot_corrupt');
  return { batch, payload, topics };
}
function stableHash(value: unknown): string {
  const order = (x: unknown): unknown => Array.isArray(x) ? x.map(order) : x && typeof x === 'object'
    ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, order(v)])) : x;
  return hash(order(value));
}
function payloadHash(payload: ReviewPayload): string {
  return stableHash({ ...payload, topics: [...payload.topics].sort((a, b) => a.rootId.localeCompare(b.rootId)) });
}
export function writeCoverage(db: DatabaseSync, observations: SourceObservation[], complete: boolean,
  error?: string, now = Date.now()): CoverageCheck {
  const { batch, topics } = load(db); const expected = new Map(topics.map(t => [t.rootId, t.sourceDigest]));
  const actual = new Map(observations.map(t => [t.rootId, t.sourceDigest]));
  const missingReviews = observations.filter(t => !expected.has(t.rootId)).length;
  const missingSources = topics.filter(t => !actual.has(t.rootId)).length;
  const changedTopics = observations.filter(t => expected.has(t.rootId) && expected.get(t.rootId) !== t.sourceDigest).length;
  const valid = complete && observations.length === actual.size && !missingReviews && !missingSources && !changedTopics;
  const check: CoverageCheck = { status: valid ? 'complete' : 'incomplete', checkedAt: now,
    catalogComplete: complete, threadsComplete: complete, observedTopics: observations.length,
    missingReviews, missingSources, changedTopics, ...(error ? { error } : {}) };
  db.prepare('UPDATE logistics_review_batches SET validation_json=? WHERE batch_id=?').run(JSON.stringify(check), String(batch.batch_id));
  return check;
}
export function setCoverageRunning(db: DatabaseSync): void {
  const { batch } = load(db);
  db.prepare('UPDATE logistics_review_batches SET validation_json=? WHERE batch_id=?').run(JSON.stringify({
    status: 'running', checkedAt: Date.now(), catalogComplete: false, threadsComplete: false, observedTopics: 0,
  }), String(batch.batch_id));
}
export function reviewedReport(path: string, options: { asOf?: number; from?: number; to?: number; now?: number } = {}) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='logistics_review_batches'").get())
      throw new ReviewIncomplete({ status: 'incomplete', error: 'review_snapshot_missing' });
    const { batch, payload, topics } = load(db, options.asOf);
    const coverage = JSON.parse(String(batch.validation_json)) as CoverageCheck;
    if (options.asOf === undefined && (coverage.status !== 'complete' || !coverage.catalogComplete || !coverage.threadsComplete
        || (options.now ?? Date.now()) - coverage.checkedAt > MAX_CHECK_AGE || coverage.checkedAt > (options.now ?? Date.now()) + 60_000))
      throw new ReviewIncomplete(coverage, new Date(payload.asOf).toISOString());
    if (options.from !== undefined && options.to !== undefined && options.to <= options.from) throw new Error('review_invalid_range');
    const selected = topics.filter(t => (options.from === undefined || t.createdAt >= options.from)
      && (options.to === undefined || t.createdAt < options.to));
    const a = aggregate(selected, payload.policy); const selectedRoots = new Set(selected.filter(t => t.status !== 'invalid').map(t => t.rootId));
    const ratings = payload.ratings.filter(s => selectedRoots.has(s.rootId));
    const ratingSum = ratings.reduce((s, v) => s + v.value, 0);
    return { batchId: payload.batchId, policy: payload.policy, asOf: new Date(payload.asOf).toISOString(),
      historical: options.asOf !== undefined, dateAxis: 'topic_created_at', coverage,
      ...a, resolutionRate: a.valid ? a.resolved / a.valid : null,
      grossHours: a.grossCents / 100, followupCostHours: a.costCents / 100, netHours: a.netCents / 100,
      personDays: a.netCents / 800, topics: selected,
      satisfaction: { answered: ratings.length, averageRating: ratings.length ? ratingSum / ratings.length : null,
        scope: 'selected_reviewed_topics', sent: null, fillRate: null } };
  } finally { try { db.exec('ROLLBACK'); } catch { /* BEGIN may itself have failed. */ } db.close(); }
}
function boundary(value: string | null, end: boolean): number | undefined {
  if (!value) return undefined;
  const day = /^\d{4}-\d\d-\d\d$/.test(value); const n = sourceTime(day ? `${value} 00:00` : value);
  return day && end ? n + 86_400_000 : n;
}
/** Called after the existing HTTP authentication check. No fallback to unreviewed machine totals. */
export function reviewedApi(path: string, url: URL, defaultChatId?: string): { status: number; body: unknown } | null {
  const routes = ['/api/reviewed-report', '/api/report-readiness', '/api/overview', '/api/efficiency', '/api/satisfaction', '/api/trend', '/api/distributions', '/api/issue-overview', '/api/issue-efficiency'];
  const scope = url.searchParams.get('chat') || defaultChatId
    || (url.pathname === '/api/reviewed-report' || url.pathname === '/api/report-readiness' ? REVIEW_CHAT : undefined);
  if (!routes.includes(url.pathname) || scope !== REVIEW_CHAT) return null;
  const bot = url.searchParams.get('bot'); if (bot && !REVIEW_BOTS.includes(bot)) return null;
  try {
    if (url.pathname.startsWith('/api/issue-')) return { status: 409,
      body: { error: '逐问题拆题统计尚未完成复核，目前提供按根线程的复核统计。', code: 'review_unit_not_supported' } };
    const supported = new Set(['chat', 'bot', 'from', 'to', 'asOf', 'granularity', 't']);
    for (const [key, value] of url.searchParams) {
      if (value && !supported.has(key)) return { status: 409, body: { error: '该筛选条件尚未完成同口径复核，暂不输出正式统计。', code: 'review_filter_not_supported' } };
    }
    if (url.searchParams.get('granularity') && !['day', 'week'].includes(url.searchParams.get('granularity')!))
      throw new Error('review_invalid_granularity');
    const r = reviewedReport(path, { asOf: boundary(url.searchParams.get('asOf'), false),
      from: boundary(url.searchParams.get('from'), false), to: boundary(url.searchParams.get('to'), true) });
    const meta = { policy: r.policy, batchId: r.batchId, asOf: r.asOf, historical: r.historical, coverage: r.coverage, dateAxis: r.dateAxis };
    if (url.pathname === '/api/report-readiness') return { status: 200, body: { status: 'complete', ...meta } };
    if (url.pathname === '/api/reviewed-report') { const { topics: _topics, ...body } = r; return { status: 200, body }; }
    if (url.pathname === '/api/overview') return { status: 200, body: { ...meta, totalTopics: r.valid, capturedTopics: r.valid,
      labeledTopics: r.valid, capturePending: 0, captureRunning: 0, capturePartial: 0, captureFailed: 0, captureConflict: 0,
      labelPending: 0, labelRunning: 0, labelFailed: 0, resolved: r.resolved, inProgress: r.inProgress, unknown: r.unknown,
      invalid: r.invalid, resolutionEligibleTopics: r.valid, needsReview: r.unknown, firstQuestioners: r.people,
      messages: r.topics.reduce((s, t) => s + t.messageCount, 0), lastDataTime: Date.parse(r.asOf),
      categories: r.categories } };
    if (url.pathname === '/api/efficiency') return { status: 200, body: { ...meta, configured: true, policyVersion: r.policy,
      hoursPerWorkday: 8, rows: r.categories, summary: { totalSavedHours: r.netHours, personDays: r.personDays,
        grossHours: r.grossHours, followupCostHours: r.followupCostHours, workdays: null, equivalentHeadcount: null,
        headcountUnavailableReason: 'reviewed_snapshot' } } };
    if (url.pathname === '/api/satisfaction') {
      return { status: 200, body: { ...meta, ...r.satisfaction } };
    }
    if (url.pathname === '/api/distributions') {
      return { status: 200, body: { ...meta, lb: [], lp: r.categories.map(row => ({ key: row.taskType, count: row.topicCount })) } };
    }
    const buckets = new Map<string, { periodStart: string; periodEnd: string; totalTopics: number; capturedTopics: number; labeledTopics: number; resolved: number; inProgress: number; unknown: number; invalid: number }>();
    for (const t of r.topics) {
      if (t.status === 'invalid') continue;
      const shifted = new Date(t.createdAt + 8 * 3_600_000); shifted.setUTCHours(0, 0, 0, 0);
      if (url.searchParams.get('granularity') !== 'day') shifted.setUTCDate(shifted.getUTCDate() - (shifted.getUTCDay() + 2) % 7);
      const key = shifted.toISOString().slice(0, 10); const end = new Date(shifted);
      if (url.searchParams.get('granularity') !== 'day') end.setUTCDate(end.getUTCDate() + 6);
      const v = buckets.get(key) ?? { periodStart: key, periodEnd: end.toISOString().slice(0, 10), totalTopics: 0, capturedTopics: 0, labeledTopics: 0, resolved: 0, inProgress: 0, unknown: 0, invalid: 0 };
      v.totalTopics++; v.capturedTopics++; v.labeledTopics++;
      if (t.status === 'resolved') v.resolved++; else if (t.status === 'in_progress') v.inProgress++; else v.unknown++;
      buckets.set(key, v);
    }
    return { status: 200, body: [...buckets.values()].sort((a, b) => a.periodStart.localeCompare(b.periodStart)) };
  } catch (error) {
    if (error instanceof ReviewIncomplete) return { status: url.pathname === '/api/report-readiness' ? 200 : 409, body: { status: 'incomplete', error: error.message, code: 'analysis_report_incomplete',
      coverage: error.coverage, reviewedAsOf: error.asOf, historicalReportUrl: error.asOf ? `/api/reviewed-report?asOf=${encodeURIComponent(error.asOf)}` : null } };
    return { status: 409, body: { error: '统计校验未通过，请检查复核快照和筛选范围。', code: 'analysis_review_validation_failed' } };
  }
}
