#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { importReview, validatePayload, reviewedReport, sourceDigest, writeCoverage, setCoverageRunning, REVIEW_CHAT } from '../dist/services/logistics-reviewed-report.js';
import { withFileLock } from '../dist/utils/file-lock.js';

const exec = promisify(execFile);
const args = process.argv.slice(2), command = args.shift();
const option = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
const path = resolve(option('--db') || process.env.BOTMUX_LOGISTICS_ANALYSIS_DB || '');
if (!option('--db') && !process.env.BOTMUX_LOGISTICS_ANALYSIS_DB) throw Error('review_database_required');
const asOf = option('--as-of');
const digestFile = p => createHash('sha256').update(readFileSync(p)).digest('hex');

async function callLark(arguments_) {
  const identity = option('--identity') || 'bot';
  if (!['user', 'bot'].includes(identity)) throw Error('review_source_identity_invalid');
  const { stdout } = await exec('lark-cli', ['--profile', option('--profile') || 'logistics-bot', ...arguments_, '--as', identity, '--no-reactions'],
    { maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
  const value = JSON.parse(stdout);
  if (!value.ok || value.data?.has_more || value.meta?.pagination?.complete !== true)
    throw Error('review_source_pagination_incomplete');
  return value.data.messages;
}
async function collect(db) {
  setCoverageRunning(db);
  try {
    const roots = await callLark(['im', '+chat-messages-list', '--chat-id', REVIEW_CHAT,
      '--start', '2026-07-01T00:00:00+08:00', '--order', 'asc', '--page-all', '--page-limit', '1000']);
    const observations = [], seen = new Set(); let cursor = 0;
    const worker = async () => {
      while (cursor < roots.length) {
        const root = roots[cursor++];
        if (root.chat_id !== REVIEW_CHAT || seen.has(root.message_id)) throw Error('review_source_catalog_invalid');
        seen.add(root.message_id);
        const messages = root.deleted || root.msg_type === 'system' ? []
          : await callLark(['im', '+threads-messages-list', '--thread', root.thread_id, '--order', 'asc', '--page-all', '--page-limit', '1000']);
        if (messages.some(m => m.chat_id !== REVIEW_CHAT)) throw Error('review_source_thread_scope_invalid');
        observations.push({ rootId: root.message_id, sourceDigest: sourceDigest(root, messages) });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    const check = writeCoverage(db, observations, true);
    console.log(JSON.stringify({ command: 'check-source', ...check }));
    if (check.status !== 'complete') process.exitCode = 2;
  } catch {
    const check = writeCoverage(db, [], false, 'source_fetch_failed');
    console.log(JSON.stringify({ command: 'check-source', ...check })); process.exitCode = 2;
  }
}
if (command === 'report') {
  try { const report = reviewedReport(path, { asOf: asOf ? Date.parse(asOf) : undefined });
    const { topics: _topics, ...safe } = report; console.log(JSON.stringify(safe));
  } catch (error) { console.log(JSON.stringify({ status: 'incomplete', error: error.message,
    coverage: error.coverage, reviewedAsOf: error.asOf })); process.exitCode = 2; }
} else if (command === 'import') {
  const payloadFile = option('--payload'); if (!payloadFile) throw Error('review_payload_required');
  const payload = JSON.parse(readFileSync(payloadFile, 'utf8'));
  validatePayload(payload);
  if (!args.includes('--apply')) { console.log(JSON.stringify({ command, dryRun: true, topics: payload.topics.length, expected: payload.expected })); }
  else await withFileLock(path + '.analysis-job', async () => {
    const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30000;');
    try {
      const backup = `${path}.review-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
      // VACUUM INTO is a consistent SQLite backup, including committed WAL pages.
      db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600);
      const before = db.prepare('PRAGMA integrity_check').get();
      if (before.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length)
        throw Error('review_preimport_integrity_check_failed');
      const result = importReview(db, payload);
      const integrity = db.prepare('PRAGMA integrity_check').get();
      const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
      if (integrity.integrity_check !== 'ok' || foreignKeys.length) throw Error('review_postimport_integrity_check_failed');
      const evidence = { command, backup, backupSha256: digestFile(backup), before, integrity, foreignKeyErrors: foreignKeys.length,
        batchId: result.batchId, unchanged: result.unchanged, valid: result.valid, resolved: result.resolved, netHours: result.netCents / 100 };
      const receipt = option('--receipt'); if (receipt) { mkdirSync(dirname(receipt), { recursive: true }); writeFileSync(receipt, JSON.stringify(evidence, null, 2), { mode: 0o600 }); }
      console.log(JSON.stringify(evidence));
    } finally { db.close(); }
  }, { maxWaitMs: 30_000 });
} else if (command === 'check-source') {
  // The hourly entry already holds the existing hourly flock. The review-specific lock also prevents overlapping checks.
  await withFileLock(path + '.review-check', async () => {
    const db = new DatabaseSync(path); db.exec('PRAGMA busy_timeout=30000;');
    try { await collect(db); } finally { db.close(); }
  }, { maxWaitMs: 30_000 });
} else throw Error('Usage: logistics-reviewed-report.mjs import|report|check-source --db <sqlite>');
