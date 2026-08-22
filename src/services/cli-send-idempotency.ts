import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock, withFileLockSync } from '../utils/file-lock.js';

export const CLI_SEND_FALLBACK_REPLAY_WINDOW_MS = 120_000;
const CLI_SEND_FALLBACK_LOCK_WAIT_MS = 20_000;
const MAX_CLAIMS_PER_SESSION = 128;

type CliSendFallbackClaim = {
  providerUuid: string;
  createdAt: number;
  expiresAt: number;
  messageId?: string;
};

type CliSendFallbackStore = {
  version: 1;
  claims: Record<string, CliSendFallbackClaim>;
};

export type CliSendFallbackProviderUuidInput = {
  dataDir: string;
  sessionId?: string;
  requestIdentity: string;
  now?: number;
};

export type CliSendFallbackDispatchResult = {
  messageId: string;
  replay: boolean;
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function cliSendIdempotencySessionDir(dataDir: string, sessionId: string): string {
  return join(dataDir, 'cli-send-idempotency', sha256(sessionId));
}

function storePath(dataDir: string, sessionId: string): string {
  return join(cliSendIdempotencySessionDir(dataDir, sessionId), 'claims.json');
}

function readStore(path: string): CliSendFallbackStore {
  if (!existsSync(path)) return { version: 1, claims: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || (parsed as { version?: unknown }).version !== 1
    || !(parsed as { claims?: unknown }).claims
    || typeof (parsed as { claims: unknown }).claims !== 'object'
    || Array.isArray((parsed as { claims: unknown }).claims)
  ) {
    throw new Error(`corrupt CLI send idempotency store: ${path}`);
  }

  const claims: Record<string, CliSendFallbackClaim> = {};
  for (const [requestHash, claim] of Object.entries((parsed as { claims: Record<string, unknown> }).claims)) {
    if (
      !/^[a-f0-9]{64}$/.test(requestHash)
      || !claim
      || typeof claim !== 'object'
      || typeof (claim as { providerUuid?: unknown }).providerUuid !== 'string'
      || !/^bms_[a-f0-9]{32}$/.test((claim as { providerUuid: string }).providerUuid)
      || !Number.isSafeInteger((claim as { createdAt?: unknown }).createdAt)
      || !Number.isSafeInteger((claim as { expiresAt?: unknown }).expiresAt)
      || (claim as { expiresAt: number }).expiresAt < (claim as { createdAt: number }).createdAt
      || (
        (claim as { messageId?: unknown }).messageId !== undefined
        && (
          typeof (claim as { messageId: unknown }).messageId !== 'string'
          || !(claim as { messageId: string }).messageId
          || (claim as { messageId: string }).messageId.length > 256
        )
      )
    ) {
      throw new Error(`corrupt CLI send idempotency store: ${path}`);
    }
    claims[requestHash] = claim as CliSendFallbackClaim;
  }
  return { version: 1, claims };
}

function writeStore(path: string, store: CliSendFallbackStore): void {
  atomicWriteFileSync(path, `${JSON.stringify(store)}\n`, {
    mode: 0o600,
    durable: true,
    followTargetSymlink: false,
  });
}

function pruneExpiredClaims(store: CliSendFallbackStore, now: number): boolean {
  let changed = false;
  for (const [requestHash, claim] of Object.entries(store.claims)) {
    if (claim.expiresAt <= now) {
      delete store.claims[requestHash];
      changed = true;
    }
  }
  return changed;
}

function keepBounded(store: CliSendFallbackStore): void {
  const keys = Object.keys(store.claims);
  if (keys.length <= MAX_CLAIMS_PER_SESSION) return;
  keys
    .sort((left, right) => store.claims[left]!.createdAt - store.claims[right]!.createdAt)
    .slice(0, keys.length - MAX_CLAIMS_PER_SESSION)
    .forEach(key => delete store.claims[key]);
}

/**
 * Returns a stable Lark UUID for a short replay window when a direct `botmux
 * send` has a session but no authenticated turn identity. The state is scoped
 * to one hashed session directory, so sandboxed sessions cannot access a
 * sibling session's replay records.
 */
export function claimCliSendFallbackProviderUuid(
  input: CliSendFallbackProviderUuidInput,
): string | undefined {
  if (!input.sessionId) return undefined;

  const now = input.now ?? Date.now();
  const requestHash = sha256(input.requestIdentity);
  const dir = cliSendIdempotencySessionDir(input.dataDir, input.sessionId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = storePath(input.dataDir, input.sessionId);

  return withFileLockSync(path, () => {
    const store = readStore(path);
    const pruned = pruneExpiredClaims(store, now);
    const existing = store.claims[requestHash];
    if (existing) {
      if (pruned) writeStore(path, store);
      return existing.providerUuid;
    }

    const providerUuid = `bms_${randomUUID().replaceAll('-', '')}`;
    store.claims[requestHash] = {
      providerUuid,
      createdAt: now,
      expiresAt: now + CLI_SEND_FALLBACK_REPLAY_WINDOW_MS,
    };
    keepBounded(store);
    writeStore(path, store);
    return providerUuid;
  });
}

/**
 * Serialize the direct-send provider effect for one session/request identity.
 *
 * Feishu's UUID replay response is not consistent across all message shapes:
 * concurrent interactive-card sends can return a 400 even though the first
 * request created the message. Keeping the lock through the provider request
 * makes the winner durably record its message id; later copies return that id
 * without issuing a second request.
 */
export async function dispatchCliSendFallback(
  input: CliSendFallbackProviderUuidInput & { sessionId: string },
  dispatch: (providerUuid: string, replay: boolean) => Promise<string>,
): Promise<CliSendFallbackDispatchResult> {
  const now = input.now ?? Date.now();
  const requestHash = sha256(input.requestIdentity);
  const dir = cliSendIdempotencySessionDir(input.dataDir, input.sessionId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = storePath(input.dataDir, input.sessionId);

  return withFileLock(path, async () => {
    const store = readStore(path);
    const pruned = pruneExpiredClaims(store, now);
    const existing = store.claims[requestHash];
    if (existing?.messageId) {
      if (pruned) writeStore(path, store);
      return { messageId: existing.messageId, replay: true };
    }

    const replay = !!existing;
    const providerUuid = existing?.providerUuid ?? `bms_${randomUUID().replaceAll('-', '')}`;
    if (!existing) {
      store.claims[requestHash] = {
        providerUuid,
        createdAt: now,
        expiresAt: now + CLI_SEND_FALLBACK_REPLAY_WINDOW_MS,
      };
      keepBounded(store);
      writeStore(path, store);
    } else if (pruned) {
      writeStore(path, store);
    }

    const messageId = await dispatch(providerUuid, replay);
    if (!messageId || messageId.length > 256) {
      throw new Error('direct CLI send returned an invalid message id');
    }

    const committed = store.claims[requestHash];
    if (!committed) {
      throw new Error('direct CLI send idempotency claim disappeared');
    }
    committed.messageId = messageId;
    writeStore(path, store);
    return { messageId, replay };
  }, { maxWaitMs: CLI_SEND_FALLBACK_LOCK_WAIT_MS });
}
