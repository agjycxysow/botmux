# Logistics analytics self-hosting

This is the AA-style deployment shape: one fixed intranet host runs BotMux, the
read-only analytics process, and SQLite. NetLink/GTM points an internal domain
to the host; Nginx proxies that domain to loopback port `17870`.

## 1. Data and access token

```bash
cat > ~/.botmux/analytics.env <<'ENV'
BOTMUX_ANALYTICS_TOKEN=replace-with-a-long-random-value
ENV
chmod 600 ~/.botmux/analytics.env
```

The service refuses a non-loopback bind without `BOTMUX_ANALYTICS_TOKEN`.
Open the first authenticated session with:

```text
https://analytics.internal.example/overview?t=<token>
```

The query token is exchanged for an HttpOnly, SameSite=Strict cookie and then
removed from the URL. Configure HTTPS before broader rollout.

## 2. Start locally

```bash
SESSION_DATA_DIR="$HOME/.botmux/data" \
BOTMUX_ANALYTICS_TOKEN=... \
./deploy/logistics-analytics/start.sh
curl -H "Authorization: Bearer $BOTMUX_ANALYTICS_TOKEN" http://127.0.0.1:17870/healthz
```

## 3. Supervision and Nginx

Copy the user-systemd example to `~/.config/systemd/user/`, adjust the checkout
path, then run `systemctl --user daemon-reload && systemctl --user enable --now
botmux-logistics-analytics.service`. Nginx must remain the only network-facing
process; the Node service should stay on loopback.

The Nginx example intentionally contains no TLS certificate path. Obtain the
internal domain and certificate through NetLink/TLB/GTM governance, then add the
approved HTTPS configuration rather than copying credentials into this repo.

## 4. Backup

Back up SQLite with its online backup mechanism or a transactionally consistent
copy. Do not copy only the main database while WAL writes are active. Monitor:

- `botmux-conversations.sqlite`, `-wal`, and `-shm` size;
- disk free space;
- `/healthz`;
- BotMux logs for `[logistics-session-master] SQLite sync failed`.
