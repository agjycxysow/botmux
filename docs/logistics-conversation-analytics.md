# Logistics conversation analytics MVP

This feature builds a local SQLite fact store for logistics-expert sessions,
messages, satisfaction, and semantic labels, plus a standalone read-only
internal site. It deliberately does not add a BotMux Dashboard page.

## Runtime flow

```text
BotMux session catalog
  -> botmux logistics backfill
  -> complete visible Lark history + BotMux send marker
  -> sanitized message facts
  -> bounded 12,000-character snapshot when turn/final boundaries exist
  -> botmux-conversations.sqlite

independent labeling command
  -> snapshot
  -> order-delivery labeling Harness
  -> semantic label projection

Nginx / internal domain
  -> botmux analytics serve (loopback)
  -> SQLite read-only
```

The live writer and the analytics reader share one host. BotMux is the only
writer. SQLite WAL permits the read-only service to query while the daemon keeps
writing.

## Privacy boundary

- Message facts contain only visible user/assistant content and are sanitized
  before persistence without truncating the message body.
- Snapshots are derived from those messages and bounded to the configured
  transcript limit (12,000 characters by default).
- App-scoped respondent open IDs are stored only as SHA-256 hashes in SQLite.
- Hidden reasoning, terminal output, credentials, attachments, and raw Lark
  payloads are not stored.
- Detail APIs return the sanitized projection; the first release has no export
  endpoint.

## Operations

`botmux logistics backfill` is a capture-only command and is dry-run by default.
It never invokes the labeling Harness or a model. `--apply` is bounded by bot,
time, optional session prefix, cursor, and `--limit` (maximum 500). It never
scans a chat without an existing BotMux session record.

Thread sessions fetch the complete visible topic. Chat sessions page backward
from the newest message to the Session start boundary, retain only the Session
time window, and fail explicitly instead of silently truncating if the
5,000-message safety limit is reached. Message writes are idempotent by Session
and platform message ID. Missing turn/final boundaries do not discard messages:
the facts remain stored and the catalog records `missing_turn` or
`missing_answer`.

`botmux logistics label` is an independent, SQLite-only semantic labeling
command and is also dry-run by default. It requires the order-delivery Harness
root and never fetches Lark history or writes Lark Base. Candidates are frozen
from `captured` conversations, rebuilt from message facts, and rejected if the
reconstructed snapshot hash differs from the captured snapshot.

```text
botmux logistics label \
  --bot <appId> \
  --harness-root /path/to/order-delivery-codex-workspace \
  --limit 50 \
  --concurrency 2 \
  --apply
```

Each model attempt is recorded in `label_runs`. A completed run for the same
frozen input hash and Harness revision is skipped on later executions; failed
runs remain retryable. `--force` explicitly creates another attempt. Validated
outputs update the current conversation projection and append the revisioned
label fact in one transaction without changing message facts, surveys, ratings,
or catalog capture status.

Captured records without any user message remain available as message facts but
are reported as `ineligibleNoUser` and excluded from semantic labeling and
resolution-rate denominators because the Harness requires user-goal evidence.

The Harness accepts at most 200 messages and 4,000 characters per message.
Oversized inputs retain deterministic head/tail context, are marked `partial`,
and therefore fall back to review-required labels under the Harness contract
instead of being silently treated as complete.

The analytics server binds to loopback by default. A non-loopback bind is refused
unless `BOTMUX_ANALYTICS_TOKEN` is set. For first login, `/overview?t=<token>`
exchanges the query value for an HttpOnly cookie and redirects to the clean URL.
Production rollout should add approved internal SSO and HTTPS at the Nginx / domain
layer; the token is a narrow MVP guard, not a long-term identity system.

SQLite backup must include a consistent WAL checkpoint or use an online backup
mechanism. Monitor database/WAL size, disk space, `/healthz`, and
`[logistics-session-master] SQLite sync failed` logs.
