import { existsSync, linkSync, symlinkSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { migrateLogisticsAnalysisDatabase } from '../src/services/logistics-analysis-migration.js';
import { LogisticsAnalysisStore } from '../src/services/logistics-analysis-store.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'botmux-logistics-migration-'));
  dirs.push(dir);
  return dir;
}

function createSource(path: string, includeMissingPlatformId = false): void {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA user_version=5;
    CREATE TABLE session_catalog (
      session_key TEXT PRIMARY KEY,
      lark_app_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      root_message_id TEXT,
      scope TEXT NOT NULL,
      session_status TEXT,
      title TEXT,
      created_at INTEGER,
      last_message_at INTEGER,
      special_session INTEGER NOT NULL DEFAULT 0,
      backfill_status TEXT,
      backfill_error TEXT,
      updated_at INTEGER
    );
    CREATE TABLE conversations (
      master_key TEXT PRIMARY KEY,
      lark_app_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      title TEXT,
      initiator_id TEXT,
      initiator_name TEXT
    );
    CREATE TABLE conversation_messages (
      message_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      platform_message_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      sender_id TEXT,
      sender_name TEXT,
      occurred_at INTEGER,
      response_kind TEXT,
      source TEXT,
      captured_at INTEGER
    );
    CREATE TABLE conversation_labels (
      label_id TEXT PRIMARY KEY,
      master_key TEXT NOT NULL,
      transcript_hash TEXT,
      harness_revision TEXT
    );
  `);
  const session = db.prepare(`
    INSERT INTO session_catalog
      (session_key,lark_app_id,session_id,chat_id,root_message_id,scope,session_status,title,created_at,last_message_at,special_session,backfill_status,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  session.run('s-a1', 'bot-a', 'bm-a1', 'chat-a', 'root-a', 'thread', 'closed', '问题 A', 100, 500, 0, 'captured', 500);
  session.run('s-a2', 'bot-a', 'bm-a2', 'chat-a', 'root-a', 'thread', 'closed', '问题 A', 200, 600, 0, 'captured', 600);
  session.run('s-b1', 'bot-b', 'bm-b1', 'chat-a', 'root-a', 'thread', 'closed', '问题 B', 100, 400, 0, 'captured', 400);
  session.run('s-chat', 'bot-a', 'bm-chat', 'chat-a', null, 'chat', 'closed', '群会话', 100, 300, 0, 'captured', 300);
  session.run('s-special', 'bot-a', 'bm-special', 'chat-a', 'root-special', 'thread', 'closed', '特殊任务', 100, 300, 1, 'captured', 300);
  session.run('s-missing', 'bot-a', 'bm-missing', 'chat-a', null, 'thread', 'closed', '无根消息', 100, 300, 0, 'captured', 300);
  const conversation = db.prepare(`
    INSERT INTO conversations (master_key,lark_app_id,session_id,title,initiator_id,initiator_name)
    VALUES (?,?,?,?,?,?)
  `);
  conversation.run('m-a1', 'bot-a', 'bm-a1', '问题 A', 'ou-a', '发起人 A');
  conversation.run('m-a2', 'bot-a', 'bm-a2', '问题 A', 'ou-a', '发起人 A');
  conversation.run('m-b1', 'bot-b', 'bm-b1', '问题 B', 'ou-b', '发起人 B');
  const message = db.prepare(`
    INSERT INTO conversation_messages
      (message_id,session_key,platform_message_id,role,content,sender_id,sender_name,occurred_at,response_kind,source,captured_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `);
  message.run('m-a1-q', 's-a1', 'om-q', 'user', '问题', 'ou-a', '发起人 A', 120, null, 'lark_history', 130);
  message.run('m-a2-q', 's-a2', 'om-q', 'user', '问题', 'ou-a', '发起人 A', 120, null, 'lark_history', 230);
  message.run('m-a1-a-placeholder', 's-a1', 'om-a', 'assistant', '[图片]请升级至最新版本客户端，以查看内容', 'bot-a', 'Bot A', 500, null, 'lark_history', 510);
  message.run('m-a2-a-recovered', 's-a2', 'om-a', 'assistant', '可靠回答', 'bot-a', 'Bot A', 500, 'final', 'codex_rollout', 610);
  message.run('m-a1-conflict', 's-a1', 'om-conflict', 'assistant', '答案甲', 'bot-a', 'Bot A', 520, null, 'lark_history', 530);
  message.run('m-a2-conflict', 's-a2', 'om-conflict', 'assistant', '答案乙', 'bot-a', 'Bot A', 520, null, 'lark_history', 630);
  message.run('m-b-q', 's-b1', 'om-q', 'user', '问题', 'ou-b', '发起人 B', 120, null, 'lark_history', 430);
  if (includeMissingPlatformId) {
    message.run('m-b-no-platform', 's-b1', null, 'assistant', '无平台标识的独立消息', 'bot-b', 'Bot B', 180, null, 'lark_history', 440);
  }
  db.prepare('INSERT INTO conversation_labels (label_id,master_key,transcript_hash,harness_revision) VALUES (?,?,?,?)')
    .run('label-old', 'm-a1', 'old-hash', 'old-revision');
  db.close();
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('four-table logistics analysis migration', () => {
  it('is dry-run by default, accounts for exclusions/duplicates/conflicts, and keeps source read-only', async () => {
    const dir = await tempDir();
    const source = join(dir, 'source.sqlite');
    const target = join(dir, 'target.sqlite');
    createSource(source, true);
    const before = new DatabaseSync(source, { readOnly: true });
    const beforeCounts = {
      sessions: Number((before.prepare('SELECT COUNT(*) count FROM session_catalog').get() as { count: number }).count),
      messages: Number((before.prepare('SELECT COUNT(*) count FROM conversation_messages').get() as { count: number }).count),
    };
    before.close();

    const report = migrateLogisticsAnalysisDatabase({ sourcePath: source, targetPath: target });
    expect(report.mode).toBe('dry-run');
    expect(report.source).toMatchObject({ sessionCatalogRows: 6, threadSessionRows: 3, topics: 2, messageRows: 8, oldLabelRows: 1 });
    expect(report.excluded).toMatchObject({ total: 3, byReason: { chat_scope: 1, special_session: 1, missing_root: 1 } });
    expect(report.messages).toMatchObject({
      candidateRows: 8,
      uniqueGroups: 5,
      duplicateRows: 3,
      rawConflictGroups: 2,
      trustedResolvedGroups: 1,
      unresolvedConflictGroups: 1,
      rawConflictRows: 4,
      trustedResolvedRows: 1,
      missingPlatformIdRows: 1,
      missingPlatformIdTopics: 1,
      conflictRowsExcluded: 2,
      selectedRows: 4,
    });
    expect(report.messages.conflicts).toEqual([
      expect.objectContaining({ kind: 'same_source_revision', candidateCount: 2, importedCandidateCount: 0 }),
    ]);
    expect(report.messages.resolvedConflicts).toEqual([
      expect.objectContaining({
        selectedSource: 'codex_rollout',
        discardedCandidateCount: 1,
        reason: 'trusted_recovery_replaced_placeholder',
      }),
    ]);
    expect(report.labels).toEqual({ sourceRows: 1, importedRows: 0, skippedRows: 1 });
    expect(report.topics).toMatchObject({ conflict: 1, captured: 1 });
    expect(existsSync(target)).toBe(false);
    const after = new DatabaseSync(source, { readOnly: true });
    expect(Number((after.prepare('SELECT COUNT(*) count FROM session_catalog').get() as { count: number }).count)).toBe(beforeCounts.sessions);
    expect(Number((after.prepare('SELECT COUNT(*) count FROM conversation_messages').get() as { count: number }).count)).toBe(beforeCounts.messages);
    after.close();
  });

  it('applies only selected thread data, isolates one conflict topic, skips old labels, and is idempotent', async () => {
    const dir = await tempDir();
    const source = join(dir, 'source.sqlite');
    const target = join(dir, 'target.sqlite');
    createSource(source);
    const first = migrateLogisticsAnalysisDatabase({ sourcePath: source, targetPath: target, apply: true, now: 700 });
    expect(first.apply).toMatchObject({
      targetSessionsInserted: 2,
      targetMessagesInserted: 3,
      targetCaptureUpdates: 2,
    });
    const store = new LogisticsAnalysisStore({ dataDir: dir, path: target, readOnly: true });
    expect(store.summary({ labelerRevision: 'current-revision' })).toMatchObject({
      totalTopics: 2,
      messages: 3,
      captureConflict: 1,
      capturedTopics: 1,
      labeledTopics: 0,
    });
    const items = store.list({ labelerRevision: 'current-revision' }).items;
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ captureStatus: 'conflict', labelStatus: 'not_ready' }),
      expect.objectContaining({ captureStatus: 'captured', labelStatus: 'pending' }),
    ]));
    store.close();
    const verify = new DatabaseSync(target, { readOnly: true });
    expect(Number((verify.prepare('SELECT COUNT(*) count FROM labels').get() as { count: number }).count)).toBe(0);
    expect((verify.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name))
      .toEqual(['label_runs', 'labels', 'messages', 'sessions']);
    verify.close();

    const second = migrateLogisticsAnalysisDatabase({ sourcePath: source, targetPath: target, apply: true, now: 700 });
    expect(second.apply).toMatchObject({
      targetSessionsInserted: 0,
      targetSessionsUpdated: 0,
      targetSessionsUnchanged: 2,
      targetMessagesInserted: 0,
      targetMessagesUpdated: 0,
      targetMessagesUnchanged: 3,
    });
  });

  it('requires an explicit target and rejects the same file even through a normalized path', async () => {
    const dir = await tempDir();
    const source = join(dir, 'source.sqlite');
    createSource(source);
    expect(() => migrateLogisticsAnalysisDatabase({ sourcePath: source, targetPath: source })).toThrow('migration_source_target_same');
    const hardLink = join(dir, 'hard-link.sqlite');
    linkSync(source, hardLink);
    expect(() => migrateLogisticsAnalysisDatabase({ sourcePath: source, targetPath: hardLink })).toThrow('migration_source_target_same');
    const symbolicLink = join(dir, 'symbolic-link.sqlite');
    symlinkSync(source, symbolicLink);
    expect(() => migrateLogisticsAnalysisDatabase({ sourcePath: source, targetPath: symbolicLink })).toThrow('migration_source_target_same');
    expect(() => migrateLogisticsAnalysisDatabase({ sourcePath: source, targetPath: '' })).toThrow('migration_target_required');
  });
});
