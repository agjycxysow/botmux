# 物流会话分析 v1 运维说明

分析命令位于现有 `logistics` 下的独立 `analysis` 子命令。分析库只使用四张表：`sessions`、`messages`、`labels`、`label_runs`。未传 `--db` 时，采集与打标命令明确使用 `${SESSION_DATA_DIR}/logistics-analysis.sqlite`（实际由 BotMux dataDir 解析）；不会选择旧的 `botmux-conversations.sqlite`。

目录同步默认 dry-run。确认来源目录和目标库后，才使用：

```bash
botmux logistics analysis sync-catalog --db /path/logistics-analysis.sqlite --bot <appId> --apply
```

采集默认 dry-run；`--apply` 才会读取可见飞书 thread 历史、恢复可信 Codex final，并写入四表库。`--limit` 默认 50、最大 200，`--cursor` 是稳定的 topic 游标；每个话题只代表 `bot + chat + root`，多个运行 Session 会合并：

```bash
botmux logistics analysis capture --db /path/logistics-analysis.sqlite --bot <appId> --limit 50 --apply
```

打标默认 dry-run。`--harness-root` 可显式指定 Harness 根目录；未指定时才使用该 Bot 的当前配置或 `LOGISTICS_CONVERSATION_HARNESS_ROOT`。`--apply` 才会在有效标签门禁通过后调用既有 Harness runner。门禁要求可见消息静默至少 15 分钟、所有 active Session 通过认证的 `GET /api/sessions/:id` 确认是 `idle`，且没有 queued/pendingRepo/待消费队列；closed Session 只在目录状态和新鲜查询没有发现运行态时接受。查询超时、404、未知状态都保守跳过：

```bash
botmux logistics analysis label --db /path/logistics-analysis.sqlite --bot <appId> --harness-root /path/to/harness --concurrency 2 --apply
```

一次完整小时作业按目录同步、分页采集、分页打标串行执行：

```bash
botmux logistics analysis run --db /path/logistics-analysis.sqlite --bot <appId> --harness-root /path/to/harness --concurrency 2 --apply
```

同一完整话题 hash 和 Harness revision 最多自动尝试三次。模型等待不持有 SQLite 事务；提交前会重新读取活动状态和可见消息边界，发生新增消息或状态变化时只将 run 标为 expired，不提交旧标签。失败会保留审计并在下一轮重试；每轮单话题失败不会阻塞其他话题。run 会按 A 的接口回收孤儿 running、清理当前完整 hash 之外超过 30 天的旧 run。

迁移必须显式给出 source 和四表目标，默认 dry-run：

```bash
botmux logistics analysis migrate --source /path/source-v5.sqlite --db /path/logistics-analysis.sqlite
botmux logistics analysis migrate --source /path/source-v5.sqlite --db /path/logistics-analysis.sqlite --apply
```

迁移 dry-run 不创建目标库；apply 只调用冻结迁移接口写四表，旧 `conversation_labels` 不导入。不得把真实生产库、真实模型或 cron 安装作为本地自测步骤。

小时 cron 样例是 `scripts/logistics-analysis-hourly.sh`。脚本从自身目录反推 worktree，要求已存在 `dist/cli.js`，默认执行 `node "$WORKTREE/dist/cli.js" logistics analysis run --apply`（可用 `BOTMUX_LOGISTICS_ANALYSIS_NODE` 指定 Node），要求设置 `BOTMUX_LOGISTICS_ANALYSIS_DB`、`BOTMUX_LOGISTICS_ANALYSIS_BOT`、`BOTMUX_LOGISTICS_ANALYSIS_HARNESS_ROOT`，并用 `flock -n` 在上一轮未结束时跳过。建议每小时第 5 分钟调用；本文件不代表已经安装 cron。

run 状态文件位于 `<db>.run.json`，原子写入且权限为 0600，只包含非敏感运行元数据。例如：

```json
{"schemaVersion":1,"status":"partial","startedAt":1788710700000,"finishedAt":1788711240000,"lastSuccessfulSyncAt":1788710701000,"lastSuccessfulCaptureAt":null,"lastSuccessfulLabelAt":null,"pendingCapture":3,"pendingLabel":8,"errorCode":"analysis_partial"}
```

`lastSuccessful*` 只在对应阶段完整成功时更新；失败或 partial 不伪造新鲜度。状态文件不包含原消息、身份、鉴权信息或原始异常。

首次历史补齐按小时渐进：每轮 `run` 最多启动 50 次模型，门禁跳过不消耗模型额度；未完成的稳定 `nextLabelCursor` 写入同一个 run 状态文件，下一小时从该游标继续，完成后清除。独立 `label --limit` 仍只处理一页。
