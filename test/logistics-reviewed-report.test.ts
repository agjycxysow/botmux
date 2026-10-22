import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LogisticsAnalysisStore } from '../src/services/logistics-analysis-store.js';
import { createLogisticsAnalyticsServer } from '../src/cli/logistics-analytics.js';
import { aggregate, importReview, reviewedReport, reviewedApi, sourceDigest, validatePayload,
  writeCoverage, REVIEW_CHAT, REVIEW_POLICY, type ReviewPayload } from '../src/services/logistics-reviewed-report.js';

const paths: string[] = [];
afterEach(() => { for (const p of paths.splice(0)) rmSync(p, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'reviewed-report-')); paths.push(dir);
  const path = join(dir, 'analysis.sqlite');
  const store = new LogisticsAnalysisStore({ dataDir: dir, path }); store.close();
  const db = new DatabaseSync(path);
  const payload: ReviewPayload = { policy: REVIEW_POLICY, batchId: 'review-1', chatId: REVIEW_CHAT, asOf: 10000,
    catalogComplete: true, threadsComplete: true, sourceFrom: '1970-01-01', reviewer: 'authorized-review',
    identityNamespace: 'same-profile', referenceUrl: 'https://example.test/policy',
    ratings: [{ id: 'rating-1', rootId: 'root-a', value: 5, answeredAt: 9000 }],
    expected: { valid: 2, resolved: 1, unknown: 1, people: 2, netCents: 165 }, topics: ['a', 'b'].map((s, i) => ({
      rootId: `root-${s}`, threadId: `thread-${s}`, botId: 'cli_aad48799ad38dbc1', sessionKey: null,
      sourceDigest: s.repeat(64), createdAt: 1000 + i * 1000, latestMessageAt: 9000,
      questioner: `person-${s}`, status: i ? 'unknown' : 'resolved', category: 'LP02', effectiveRounds: 6,
      reason: i ? '真实证据冲突保留unknown' : '实际查询结果已核验', title: 'question', url: '', answerCount: 1, messageCount: 8,
    })) as ReviewPayload['topics'] };
  const observations = payload.topics.map(t => ({ rootId: t.rootId, sourceDigest: t.sourceDigest }));
  return { dir, path, db, payload, observations };
}
describe('reviewed report contract', () => {
  it('keeps unknown in the denominator and deducts only eligible resolved followups in integer cents', () => {
    const { db, payload } = setup();
    const a = aggregate(payload.topics, payload.policy); expect(a.valid).toBe(2); expect(a.resolved).toBe(1);
    expect(a.unknown).toBe(1); expect(a.costCents).toBe(10); expect(a.netCents).toBe(165); db.close();
  });
  it.each(['catalogComplete', 'threadsComplete'] as const)('rejects incomplete %s before any schema write', field => {
    const { db, payload } = setup(); payload[field] = false;
    expect(() => importReview(db, payload)).toThrow('manifest_incomplete');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='logistics_review_batches'").get()).toBeUndefined(); db.close();
  });
  it('rejects duplicate roots, missing identities, unsupported taxonomy and conflicting totals', () => {
    const { db, payload } = setup();
    for (const change of [
      (p: ReviewPayload) => { p.topics[1]!.rootId = p.topics[0]!.rootId; },
      (p: ReviewPayload) => { p.topics[1]!.questioner = null; },
      (p: ReviewPayload) => { p.topics[0]!.category = 'legacy-data'; },
      (p: ReviewPayload) => { p.expected.netCents = 175; },
    ]) { const bad = structuredClone(payload); change(bad); expect(() => validatePayload(bad)).toThrow(); }
    db.close();
  });
  it('imports idempotently, preserves the base schema version and rejects overwriting an audited batch', () => {
    const { db, payload, path, dir } = setup(); const before = db.prepare('PRAGMA user_version').get();
    expect(importReview(db, payload).unchanged).toBe(false); expect(importReview(db, payload).unchanged).toBe(true);
    const changed = structuredClone(payload); changed.topics[0]!.reason = 'replace';
    expect(() => importReview(db, changed)).toThrow('batch_immutable');
    expect(db.prepare('PRAGMA user_version').get()).toEqual(before);
    const oldReader = new LogisticsAnalysisStore({ dataDir: dir, path, readOnly: true }); oldReader.close(); db.close();
  });
  it('requires a complete source check and then returns the reviewed rate, exact net hours and matching ratings', () => {
    const { db, payload, path, observations } = setup(); importReview(db, payload);
    expect(() => reviewedReport(path)).toThrow('统计未完成');
    writeCoverage(db, observations, true);
    const r = reviewedReport(path); expect(r.resolutionRate).toBe(0.5); expect(r.netHours).toBe(1.65);
    expect(r.satisfaction.averageRating).toBe(5); expect(r.unknown).toBe(1); db.close();
  });
  it.each(['missing', 'new', 'changed', 'failed'] as const)('blocks %s source evidence without exposing formal totals', kind => {
    const { db, payload, path, observations } = setup(); importReview(db, payload); writeCoverage(db, observations, true);
    const changed = kind === 'missing' ? observations.slice(0, 1) : kind === 'new'
      ? [...observations, { rootId: 'new-root', sourceDigest: 'c'.repeat(64) }]
      : kind === 'changed' ? observations.map((t, i) => i ? t : { ...t, sourceDigest: 'c'.repeat(64) }) : [];
    writeCoverage(db, changed, kind !== 'failed', kind === 'failed' ? 'source_fetch_failed' : undefined);
    const response = reviewedApi(path, new URL('http://localhost/api/overview'), REVIEW_CHAT); expect(response?.status).toBe(409);
    expect(response?.body).not.toHaveProperty('resolved');
    const frozen = reviewedReport(path, { asOf: payload.asOf }); expect(frozen.historical).toBe(true); expect(frozen.valid).toBe(2); db.close();
  });
  it('expires coverage instead of silently reusing a successful old check', () => {
    const { db, payload, path, observations } = setup(); importReview(db, payload); writeCoverage(db, observations, true, undefined, 1000);
    expect(() => reviewedReport(path, { now: 1000 + 91 * 60_000 })).toThrow('统计未完成'); db.close();
  });
  it('detects evidence tampering even when totals have not changed', () => {
    const { db, payload, path } = setup(); importReview(db, payload);
    const changed = { ...payload.topics[0]!, reason: 'silently modified' };
    db.prepare('UPDATE logistics_review_topics SET data_json=? WHERE root_id=?').run(JSON.stringify(changed), changed.rootId);
    expect(() => reviewedReport(path, { asOf: payload.asOf })).toThrow('snapshot_corrupt'); db.close();
  });
  it('filters topic dates and ratings together without mixing the snapshot-wide rating scope', () => {
    const { db, payload, path } = setup(); importReview(db, payload);
    const r = reviewedReport(path, { asOf: payload.asOf, from: 2000 });
    expect(r.valid).toBe(1); expect(r.resolved).toBe(0); expect(r.satisfaction.answered).toBe(0); db.close();
  });
  it('rejects unsupported filter aliases and a different statistical unit instead of ignoring them', () => {
    const { db, payload, path, observations } = setup(); importReview(db, payload); writeCoverage(db, observations, true);
    for (const route of ['/api/overview?dataStatus=failed', '/api/overview?analysisStatus=pending', '/api/issue-overview']) {
      const response = reviewedApi(path, new URL('http://localhost' + route), REVIEW_CHAT);
      expect(response?.status).toBe(409); expect(response?.body).not.toHaveProperty('resolved');
    }
    db.close();
  });
  it('fingerprints the complete message set and substantive edits, independently of app-scoped mention IDs', () => {
    const root = { message_id: 'root', content: '@user(ou_abc) hello', create_time: '2026-10-16 12:00', deleted: false, msg_type: 'post' };
    const same = { ...root, content: '@user(ou_xyz) hello' };
    expect(sourceDigest(root, [])).toBe(sourceDigest(same, []));
    expect(sourceDigest(root, [])).not.toBe(sourceDigest({ ...root, content: 'different goal' }, []));
    expect(sourceDigest(root, [])).not.toBe(sourceDigest(root, [{ ...root, message_id: 'reply' }]));
  });
  it('keeps machine collection updates from overwriting reviewed outcomes', () => {
    const { db, payload, path, observations } = setup(); importReview(db, payload); writeCoverage(db, observations, true);
    db.prepare(`INSERT INTO sessions(session_key,bot_id,chat_id,scope,session_status,created_at,capture_status,updated_at)
      VALUES('machine-topic','bot','chat','thread','closed',1,'captured',1)`).run();
    db.prepare(`INSERT INTO labels(session_key,content_hash,labeler_revision,labeled_at,lb,lp,resolution_status,confidence,needs_review,capture_version)
      VALUES('machine-topic','hash','old-machine-harness',1,'LB99','LP99','in_progress','low',1,1)`).run();
    expect(reviewedReport(path).resolved).toBe(1);
    db.prepare('DELETE FROM labels').run(); expect(reviewedReport(path).netHours).toBe(1.65); db.close();
  });
  it('preserves HTTP authentication and gates legacy metrics while providing an explicit frozen snapshot', async () => {
    const { db, payload, path, dir, observations } = setup(); importReview(db, payload); writeCoverage(db, observations, true);
    const server = createLogisticsAnalyticsServer({ dataDir: dir, databasePath: path, host: '127.0.0.1',
      labelerRevision: 'test-revision', accessToken: 'fixture-token', defaultChatId: REVIEW_CHAT });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const headers = { authorization: 'Bearer fixture-token' };
    try {
      expect((await fetch(base + '/api/overview')).status).toBe(401);
      const valid = await fetch(base + '/api/overview', { headers }); expect(valid.status).toBe(200);
      expect(await valid.json()).toMatchObject({
        totalTopics: 2,
        resolved: 1,
        resolutionEligibleTopics: 2,
        categories: expect.arrayContaining([
          expect.objectContaining({
            taskType: 'LP02',
            topicCount: 2,
            resolvedCount: 1,
            unknownCount: 1,
            resolutionRate: 0.5,
          }),
        ]),
      });
      writeCoverage(db, [...observations, { rootId: 'new', sourceDigest: 'e'.repeat(64) }], true);
      for (const endpoint of ['/api/overview', '/api/efficiency', '/api/satisfaction'])
        expect((await fetch(base + endpoint, { headers })).status).toBe(409);
      const frozen = await fetch(base + '/api/reviewed-report?asOf=' + encodeURIComponent(new Date(payload.asOf).toISOString()), { headers });
      expect(frozen.status).toBe(200); expect(await frozen.json()).toMatchObject({ historical: true, valid: 2, netHours: 1.65 });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); }
  });
});
