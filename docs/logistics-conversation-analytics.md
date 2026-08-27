# Logistics conversation analytics MVP

This feature builds on the logistics-expert implementation that already records
post-turn satisfaction and semantic tags. It replaces the Lark Base-only data
path with a local SQLite fact store and adds a standalone, read-only internal
site. It deliberately does not add a BotMux Dashboard page.

## Runtime flow

```text
canonical final delivery
  -> logistics session master row
  -> visible Lark history snapshot
  -> order-delivery labeling Harness
  -> botmux-conversations.sqlite
  -> optional Lark Base review projection

Nginx / internal domain
  -> botmux analytics serve (loopback)
  -> SQLite read-only
```

The live writer and the analytics reader share one host. BotMux is the only
writer. SQLite WAL permits the read-only service to query while the daemon keeps
writing.

## Privacy boundary

- Snapshot messages contain only visible user/assistant content and are sanitized
  before persistence.
- App-scoped respondent open IDs are stored only as SHA-256 hashes in SQLite.
- Hidden reasoning, terminal output, credentials, attachments, and raw Lark
  payloads are not stored.
- Detail APIs return the sanitized projection; the first release has no export
  endpoint.

## Operations

`botmux logistics backfill` is dry-run by default. `--apply` is bounded by bot,
time, optional session prefix, and `--limit` (maximum 500). It never scans every
chat without an existing BotMux session record.

The analytics server binds to loopback by default. A non-loopback bind is refused
unless `BOTMUX_ANALYTICS_TOKEN` is set. For first login, `/overview?t=<token>`
exchanges the query value for an HttpOnly cookie and redirects to the clean URL.
Production rollout should add approved internal SSO and HTTPS at the Nginx / domain
layer; the token is a narrow MVP guard, not a long-term identity system.

SQLite backup must include a consistent WAL checkpoint or use an online backup
mechanism. Monitor database/WAL size, disk space, `/healthz`, and
`[logistics-session-master] SQLite sync failed` logs.
