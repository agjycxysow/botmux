import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLI_SEND_FALLBACK_REPLAY_WINDOW_MS,
  claimCliSendFallbackProviderUuid,
  cliSendIdempotencySessionDir,
  dispatchCliSendFallback,
} from '../src/services/cli-send-idempotency.js';

describe('direct CLI send fallback idempotency', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-cli-send-idempotency-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const input = (overrides: Partial<Parameters<typeof claimCliSendFallbackProviderUuid>[0]> = {}) => ({
    dataDir,
    sessionId: 'session-a',
    requestIdentity: '{"target":"oc_chat","content":"same response","msgType":"text"}',
    now: 1_000_000,
    ...overrides,
  });

  it('reuses one provider UUID for replayed direct sends inside the bounded window', () => {
    const first = claimCliSendFallbackProviderUuid(input());
    const replay = claimCliSendFallbackProviderUuid(input({ now: 1_000_001 }));

    expect(first).toBe(replay);
    expect(first).toMatch(/^bms_[a-f0-9]{32}$/);
  });

  it('separates distinct session and request identities', () => {
    const original = claimCliSendFallbackProviderUuid(input());

    expect(claimCliSendFallbackProviderUuid(input({
      requestIdentity: '{"target":"oc_other","content":"same response","msgType":"text"}',
    }))).not.toBe(original);
    expect(claimCliSendFallbackProviderUuid(input({ sessionId: 'session-b' }))).not.toBe(original);
  });

  it('uses a fresh provider UUID after the replay window expires', () => {
    const first = claimCliSendFallbackProviderUuid(input());
    const next = claimCliSendFallbackProviderUuid(input({
      now: 1_000_000 + CLI_SEND_FALLBACK_REPLAY_WINDOW_MS,
    }));

    expect(next).not.toBe(first);
  });

  it('does not create a fallback UUID without a current session', () => {
    expect(claimCliSendFallbackProviderUuid(input({ sessionId: undefined }))).toBeUndefined();
  });

  it('serializes concurrent provider sends and returns the winner message id to the replay', async () => {
    let release!: () => void;
    let markEntered!: () => void;
    const firstEntered = new Promise<void>(resolve => { markEntered = resolve; });
    const releaseFirst = new Promise<void>(resolve => { release = resolve; });
    let providerCalls = 0;
    const dispatch = async (_uuid: string, _replay: boolean): Promise<string> => {
      providerCalls++;
      markEntered();
      await releaseFirst;
      return 'om_winner';
    };

    const first = dispatchCliSendFallback(input(), dispatch);
    await firstEntered;
    const replay = dispatchCliSendFallback(input(), dispatch);
    release();

    await expect(Promise.all([first, replay])).resolves.toEqual([
      { messageId: 'om_winner', replay: false },
      { messageId: 'om_winner', replay: true },
    ]);
    expect(providerCalls).toBe(1);
  });

  it('reuses the recorded message id without calling the provider again', async () => {
    const first = await dispatchCliSendFallback(input(), async () => 'om_existing');
    const replay = await dispatchCliSendFallback(input({ now: 1_000_001 }), async () => {
      throw new Error('provider should not run for a completed replay');
    });

    expect(first).toEqual({ messageId: 'om_existing', replay: false });
    expect(replay).toEqual({ messageId: 'om_existing', replay: true });
  });

  it('keeps the writable store inside a non-user-controlled session directory', () => {
    const path = cliSendIdempotencySessionDir(dataDir, '../../session-a');

    expect(path).toMatch(new RegExp(`^${dataDir}/cli-send-idempotency/[a-f0-9]{64}$`));
    expect(path).not.toContain('session-a');
  });
});
