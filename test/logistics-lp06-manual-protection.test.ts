import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogisticsAnalysisStore } from '../src/services/logistics-analysis-store.js';
import { parseLogisticsModelTaskOutput } from '../src/services/logistics-session-model-task.js';
import { aggregate, SIX_CATEGORY_REVIEW_POLICY, type ReviewTopic } from '../src/services/logistics-reviewed-report.js';

const dirs: string[] = [];
const oldRevision = 'a'.repeat(64);
const newRevision = 'b'.repeat(64);
const approvalRevision = 'manual-approval:lp06:20261030:0123456789abcdef';
const docRevision = 'manual-doc:fixture-review';
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(withManualStatus = false) {
  const dir = mkdtempSync(join(tmpdir(), 'logistics-lp06-')); dirs.push(dir);
  let store = new LogisticsAnalysisStore({ dataDir: dir });
  const db = new DatabaseSync(store.path);
  if (withManualStatus) {
    store.close();
    db.exec('ALTER TABLE sessions ADD COLUMN manual_resolution_status TEXT');
    store = new LogisticsAnalysisStore({ dataDir: dir });
  }
  store.syncSessions([{
    botId: 'bot-fixture', chatId: 'chat-fixture', rootMessageId: 'root-fixture',
    scope: 'thread', sessionStatus: 'closed', createdAt: 1000,
  }]);
  const sessionKey = store.listPendingCapture({ limit: 1 })[0]!.sessionKey;
  store.upsertMessages([
    { sessionKey, platformMessageId: 'question-fixture', role: 'user', content: '核对测试监控接入配置与治理方案。', occurredAt: 1000, source: 'lark_history' },
    { sessionKey, platformMessageId: 'answer-fixture', role: 'assistant', content: '已核对配置并修订治理方案。', occurredAt: 2000, source: 'lark_history' },
  ]);
  store.markCaptureResult({ sessionKey, status: 'captured' });
  const session = store.getSession(sessionKey)!;
  const put = (revision: string, lp: string, needsReview: number, reason: string | null, overrides: Record<string, unknown> = {}) => {
    const row = { session_key: sessionKey, content_hash: session.contentHash!, capture_version: session.captureVersion,
      labeler_revision: revision, labeled_at: 3000, lb: 'LB06', lp, resolution_status: 'resolved',
      confidence: 'high', needs_review: needsReview, label_reason: reason, ...overrides };
    db.prepare(`INSERT INTO labels(session_key,content_hash,capture_version,labeler_revision,labeled_at,lb,lp,resolution_status,confidence,needs_review,label_reason)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(row.session_key, String(row.content_hash), Number(row.capture_version),
      row.labeler_revision, Number(row.labeled_at), row.lb, row.lp, String(row.resolution_status), row.confidence,
      Number(row.needs_review), row.label_reason);
  };
  const approval = JSON.stringify({ source: 'manual_taxonomy_approval', approvalRevision,
    canonicalLp: 'LP06', canonicalResolutionStatus: 'resolved', efficiencyBaseline: null,
    approval: { scope: 'synthetic-only' }, evidence: 'x'.repeat(1200) });
  const labels = () => db.prepare('SELECT * FROM labels ORDER BY labeler_revision').all();
  const close = () => { db.close(); store.close(); };
  return { store, db, sessionKey, session, put, approval, labels, close };
}

describe('LP06 incremental labeling and immutable manual evidence', () => {
  it('keeps default revision relabeling and opts into incremental selection without hiding coverage', () => {
    const f = setup(); f.put(oldRevision, 'LP04', 0, null);
    const before = f.labels();
    expect(f.store.listPendingLabels({ labelerRevision: newRevision })).toHaveLength(1);
    expect(f.store.listPendingLabels({ labelerRevision: oldRevision })).toEqual([]);
    expect(f.store.listPendingLabels({ labelerRevision: newRevision, incrementalLabels: true })).toEqual([]);
    expect(f.store.summary({ labelerRevision: newRevision })).toMatchObject({
      labeledTopics: 0, labelPending: 1,
      labelCoverage: { currentRevisionTopics: 0, crossRevisionManualTopics: 0, previousMachineRevisionTopics: 1 },
    });
    expect(f.labels()).toEqual(before); f.close();
  });

  it('reports old-machine coverage while new-revision inference is running or failed, but not when capture is not ready', () => {
    const f = setup(); f.put(oldRevision, 'LP04', 0, null);
    const run = f.store.registerLabelRun({ sessionKey: f.sessionKey, contentHash: f.session.contentHash!, labelerRevision: newRevision });
    expect(f.store.list({ labelerRevision: newRevision }).items[0]).toMatchObject({ labelStatus: 'running', lp: null });
    expect(f.store.summary({ labelerRevision: newRevision }).labelCoverage)
      .toMatchObject({ previousMachineRevisionTopics: 1, unlabeledTopics: 0 });
    f.db.prepare("UPDATE label_runs SET status='failed' WHERE run_id=?").run(run.runId);
    expect(f.store.summary({ labelerRevision: newRevision }).labelCoverage)
      .toMatchObject({ previousMachineRevisionTopics: 1, unlabeledTopics: 0 });
    f.db.prepare('DELETE FROM labels').run();
    expect(f.store.summary({ labelerRevision: newRevision }).labelCoverage)
      .toMatchObject({ previousMachineRevisionTopics: 0, unlabeledTopics: 1 });
    f.store.markCaptureResult({ sessionKey: f.sessionKey, status: 'partial' });
    expect(f.store.summary({ labelerRevision: newRevision }).labelCoverage)
      .toMatchObject({ previousMachineRevisionTopics: 0, unlabeledTopics: 0 });
    f.close();
  });

  it('selects fingerprint-valid approval before machine/current and pending document snapshots without copying or truncating JSON', () => {
    const f = setup();
    f.put(newRevision, 'LP04', 0, null);
    f.put(docRevision, 'LP99', 1, JSON.stringify({ source: 'manual_doc_review' }));
    f.put(approvalRevision, 'LP06', 0, f.approval);
    f.put('pre-' + approvalRevision + ':' + oldRevision, 'LP04', 0, null);
    const before = f.labels();
    const item = f.store.list({ labelerRevision: newRevision }).items[0]!;
    expect(f.store.detail(item.topicPublicId, { labelerRevision: newRevision })).toMatchObject({
      labelerRevision: approvalRevision, lp: 'LP06', labelReason: f.approval,
    });
    expect(f.store.listPendingLabels({ labelerRevision: newRevision })).toEqual([]);
    expect(f.store.listPendingLabels({ labelerRevision: newRevision, incrementalLabels: true })).toEqual([]);
    expect(f.store.labelRunState(f.sessionKey, f.session.contentHash!, newRevision).completed).toBe(true);
    expect(f.store.registerLabelRun({ sessionKey: f.sessionKey, contentHash: f.session.contentHash!, labelerRevision: newRevision }))
      .toMatchObject({ outcome: 'skipped', alreadyLabeled: true });
    expect(f.store.summary({ labelerRevision: newRevision }).labelCoverage)
      .toMatchObject({ crossRevisionManualTopics: 1, currentRevisionTopics: 0, previousMachineRevisionTopics: 0 });
    expect(f.labels()).toEqual(before); f.close();
  });

  it('respects valid manual_doc_review across revisions but does not promote pending LP99 or archived rows', () => {
    const f = setup();
    f.put(docRevision, 'LP99', 1, JSON.stringify({ source: 'manual_doc_review' }));
    f.put('pre-' + approvalRevision + ':' + oldRevision, 'LP04', 0, null);
    expect(f.store.listPendingLabels({ labelerRevision: newRevision })).toHaveLength(1);
    f.put('manual-doc:valid-fixture', 'LP03', 0, JSON.stringify({ source: 'manual_doc_review', evidence: 'x'.repeat(1200) }));
    expect(f.store.listPendingLabels({ labelerRevision: newRevision })).toEqual([]);
    expect(f.store.listPendingLabels({ labelerRevision: newRevision, incrementalLabels: true })).toEqual([]);
    expect(f.store.list({ labelerRevision: newRevision }).items[0]).toMatchObject({ lp: 'LP03', resolutionStatus: 'resolved' });
    f.close();
  });

  it('preserves manual snapshots and pre-approval archives on content changes while deleting stale machines and not applying stale manual labels', () => {
    const f = setup();
    f.put(oldRevision, 'LP04', 0, null);
    f.put(docRevision, 'LP99', 1, JSON.stringify({ source: 'manual_doc_review' }));
    f.put(approvalRevision, 'LP06', 0, f.approval);
    f.put('pre-' + approvalRevision + ':' + oldRevision, 'LP04', 0, null);
    const manual = f.labels().filter(row => row.labeler_revision !== oldRevision);
    f.store.upsertMessages([{ sessionKey: f.sessionKey, platformMessageId: 'new-question-fixture',
      role: 'user', content: '新增目标：监控核验后还需构建接入。', occurredAt: 4000, source: 'lark_history' }]);
    f.store.markCaptureResult({ sessionKey: f.sessionKey, status: 'captured' });
    expect(f.store.getSession(f.sessionKey)!.contentHash).not.toBe(f.session.contentHash);
    expect(f.store.getMessages(f.sessionKey)).toHaveLength(3);
    expect(f.labels()).toEqual(manual);
    expect(f.store.list({ labelerRevision: newRevision }).items[0]).toMatchObject({ labelStatus: 'pending', lp: null });
    expect(f.store.listPendingLabels({ labelerRevision: newRevision })).toHaveLength(1);
    expect(f.store.listPendingLabels({ labelerRevision: newRevision, incrementalLabels: true })).toHaveLength(1);
    f.db.prepare('DELETE FROM messages WHERE session_key=?').run(f.sessionKey);
    f.store.markCaptureResult({ sessionKey: f.sessionKey, status: 'partial' });
    expect(f.store.getSession(f.sessionKey)!.contentHash).toBeUndefined();
    expect(f.labels()).toEqual(manual);
    expect(f.store.list({ labelerRevision: newRevision }).items[0]).toMatchObject({ labelStatus: 'not_ready', lp: null });
    f.close();
  });

  it('requires capture-version and content-hash equality for manual protection', () => {
    const f = setup();
    f.put(approvalRevision, 'LP06', 0, f.approval);
    f.store.markCaptureResult({ sessionKey: f.sessionKey, status: 'partial' });
    f.store.markCaptureResult({ sessionKey: f.sessionKey, status: 'captured' });
    expect(f.store.getSession(f.sessionKey)!.captureVersion).not.toBe(f.session.captureVersion);
    expect(f.store.getSession(f.sessionKey)!.contentHash).toBe(f.session.contentHash);
    expect(f.store.listPendingLabels({ labelerRevision: newRevision })).toHaveLength(1);
    expect(f.store.listPendingLabels({ labelerRevision: newRevision, incrementalLabels: true })).toHaveLength(1);
    expect(f.store.list({ labelerRevision: newRevision }).items[0].lp).toBeNull();
    expect(f.labels()).toHaveLength(1); f.close();
  });

  it('blocks a model commit when a valid manual approval arrives during inference', () => {
    const f = setup();
    const run = f.store.registerLabelRun({ sessionKey: f.sessionKey, contentHash: f.session.contentHash!, labelerRevision: newRevision });
    f.put(approvalRevision, 'LP06', 0, f.approval);
    const before = f.labels();
    expect(() => f.store.commitLabel({ runId: run.runId, sessionKey: f.sessionKey, contentHash: f.session.contentHash!,
      labelerRevision: newRevision, lb: 'LB06', lp: 'LP04', resolutionStatus: 'resolved', confidence: 'high',
      needsReview: false })).toThrow('analysis_manual_label_protected');
    expect(f.labels()).toEqual(before);
    expect(f.db.prepare('SELECT status,error FROM label_runs WHERE run_id=?').get(run.runId))
      .toMatchObject({ status: 'skipped', error: 'manual_label_protected' });
    f.close();
  });

  it('excludes manual invalid topics from both pending modes and report denominators without changing the marker', () => {
    const f = setup(true);
    f.put(docRevision, 'LP99', 1, JSON.stringify({ source: 'manual_doc_review', rawStatus: 'invalid' }),
      { resolution_status: 'unknown' });
    f.db.prepare("UPDATE sessions SET manual_resolution_status='invalid' WHERE session_key=?").run(f.sessionKey);
    const before = f.labels();
    for (const incrementalLabels of [false, true]) {
      expect(f.store.listPendingLabels({ labelerRevision: newRevision, incrementalLabels })).toEqual([]);
    }
    expect(f.store.summary({ labelerRevision: newRevision })).toMatchObject({ totalTopics: 0, labelPending: 0, unknown: 0 });
    expect(f.store.list({ labelerRevision: newRevision }).total).toBe(0);
    expect(f.store.registerLabelRun({ sessionKey: f.sessionKey, contentHash: f.session.contentHash!, labelerRevision: newRevision }))
      .toMatchObject({ outcome: 'skipped' });
    expect(f.store.labelRunState(f.sessionKey, f.session.contentHash!, newRevision).completed).toBe(true);
    expect(f.labels()).toEqual(before); f.close();
  });

  it('protects a manual invalid marker added during inference', () => {
    const f = setup(true);
    const run = f.store.registerLabelRun({ sessionKey: f.sessionKey, contentHash: f.session.contentHash!, labelerRevision: newRevision });
    f.db.prepare("UPDATE sessions SET manual_resolution_status='invalid' WHERE session_key=?").run(f.sessionKey);
    expect(() => f.store.commitLabel({ runId: run.runId, sessionKey: f.sessionKey, contentHash: f.session.contentHash!,
      labelerRevision: newRevision, lb: 'LB06', lp: 'LP06', resolutionStatus: 'resolved', confidence: 'high',
      needsReview: false })).toThrow('analysis_manual_label_protected');
    expect(f.labels()).toEqual([]);
    expect(f.db.prepare('SELECT manual_resolution_status FROM sessions WHERE session_key=?').get(f.sessionKey))
      .toMatchObject({ manual_resolution_status: 'invalid' });
    f.close();
  });

  it('accepts LP06 model output and rejects unsupported LP07', () => {
    const output = { businessCategory: 'LB06', problemType: 'LP06', resolutionStatus: 'resolved', overallConfidence: 'high', needsReview: false };
    expect(parseLogisticsModelTaskOutput(JSON.stringify(output)).problemType).toBe('LP06');
    expect(() => parseLogisticsModelTaskOutput(JSON.stringify({ ...output, problemType: 'LP07' }))).toThrow('schema_invalid');
  });

  it('counts LP06 outcomes without inventing a zero baseline or eligible efficiency samples, and retains old policy semantics', () => {
    const topics: ReviewTopic[] = ['in_progress', 'resolved'].map((status, index) => ({
      rootId: `root-${index}`, threadId: `thread-${index}`, botId: null, sessionKey: null, sourceDigest: 'c'.repeat(64),
      createdAt: 1000, latestMessageAt: 2000, questioner: 'synthetic-person', status: status as ReviewTopic['status'],
      category: 'LP06', effectiveRounds: 10, reason: 'synthetic-review', title: '研发配置核验', url: '', answerCount: 1, messageCount: 2,
    }));
    const result = aggregate(topics);
    expect(result).toMatchObject({ valid: 2, resolved: 1, inProgress: 1, eligible: 0, netCents: 0, uncalibratedResolvedTopics: 1 });
    expect(result.categories.find(row => row.taskType === 'LP06')).toMatchObject({
      topicCount: 2, resolvedCount: 1, resolutionRate: 0.5, hoursPerResolvedTopic: null,
      efficiencyBaselineStatus: 'missing', efficiencyEligibleTopics: 0, grossHours: null, followupCostHours: null, savedHours: null,
    });
    expect(aggregate([], SIX_CATEGORY_REVIEW_POLICY).categories.map(row => row.taskType)).not.toContain('LP06');
  });
});
