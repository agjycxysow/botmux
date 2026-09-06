# 物流会话分析 v1 数据层交接

本文档冻结给采集打标任务 B 和概览任务 C 使用的接口。字段事实源是飞书文档《SQLite 字段分类设计》，读取 revision 366，锚点 `doxcnibItwPmUGoquFZiqCjCxEn`。实现位于 `src/services/logistics-analysis-topic.ts`、`src/services/logistics-analysis-store.ts` 和 `src/services/logistics-analysis-migration.ts`。

## 目标和边界

分析单位是一个飞书 thread 话题，一个话题只代表一个问题。稳定分析键由 `bot_id + chat_id + root_message_id` 唯一确定：

```text
session_key = topic_<sha256(bot_id + "\\0" + chat_id + "\\0" + root_message_id)>
topicPublicId = topic_<sha256(session_key)[0:32]>
```

只有 `scope=thread` 且有明确 `root_message_id` 的记录进入分析库。chat、meeting、special 和缺 root 的记录在迁移报告中分别计数，源库不改写。一个话题的多个 BotMux Session 先按上述键合并；`botmux_session_id` 和 `cli_session_id` 只保存按 `updated_at` 选出的最新代表运行 Session，不能用它们筛掉其他 Session 的消息。

新库只包含四张业务表：`sessions`、`messages`、`labels`、`label_runs`。不新增问卷、满意度、Base、人工改标或原话题链接生成能力；`lark_message_url` 仅在调用方已有值时保存，否则为 null。

## 四表字段

`sessions` 保存话题上下文、最新运行代表、生命周期和采集状态。字段为 `session_key` 主键、`botmux_session_id`、`bot_id`、`bot_name`、`cli_session_id`、`chat_id`、`chat_name`、`scope`、`root_message_id`、`lark_message_url`、`title`、`initiator_id`、`initiator_name`、`session_status`、`created_at`、`last_message_at`、`capture_status`、`capture_error`、`content_hash`、`capture_version`、`updated_at`。`capture_version` 是内部可见范围版本守卫，不是页面字段。

`messages` 保存每份脱敏逐条消息。字段为 `message_key` 主键、`session_key` 外键、`platform_message_id`、`role`、`sender_id`、`sender_name`、`content`、`occurred_at`、`response_kind`、`source`、`content_hash`、`captured_at`。有平台 ID 时按 `(session_key, platform_message_id)` 幂等；缺平台 ID 时不合并，使用调用方的 `messageKey` 或隔离生成键，并返回 `missing_platform_message_id` 诊断。

`labels` 每个话题只保留一条当前结果。字段为 `session_key` 主键、`content_hash`、`labeler_revision`、`labeled_at`、`lb`、`lp`、`resolution_status`、`confidence`、`needs_review`、`label_reason`、`capture_version`。三个旧 Reason Code 不进入新表，若需要展示由 B 在 `label_reason` 中给出有限可读原因。

`label_runs` 保存每次执行审计。字段为 `run_id` 主键、`session_key`、`content_hash`、`labeler_revision`、`model`、`status`、`error`、`attempt`、`capture_version`、`started_at`、`completed_at`。同一 `(session_key, content_hash, labeler_revision)` 的自动尝试总数最多 3 次，跨 `capture_version` 累计；`capture_version` 只用于拒绝过期提交。

`content_hash` 是完整话题消息序列按时间和 `message_key` 排序后，仅以 `{role, content}` 计算的 hash。它不同于 Harness 对截断/脱敏输入计算的 `transcript_hash`：B 必须把完整话题 hash 传给 store，再用现有 Harness 逻辑生成实际模型输入及其 hash，不能因 head/tail 输入相同而认为完整话题未变。

## B：采集和打标接口

写入口必须用可写实例：

```ts
const store = new LogisticsAnalysisStore({ dataDir, path });
```

目录同步签名为：

```ts
syncSessions(rows: ReadonlyArray<LogisticsAnalysisSessionInput>): LogisticsAnalysisSyncResult
```

它只写 thread 话题；返回 `total/included/inserted/updated/unchanged/excluded/excludedByReason`。非 thread 行不进入新库。

消息幂等写入和完整 hash 更新签名为：

```ts
upsertMessages(messages: ReadonlyArray<LogisticsAnalysisMessageInput>, capturedAt?: number): LogisticsAnalysisMessageWriteResult
markCaptureResult(input: {
  sessionKey: string;
  status: LogisticsAnalysisCaptureStatus;
  error?: string;
  contentHash?: string;
  updatedAt?: number;
}): LogisticsAnalysisCaptureResult
```

`upsertMessages` 返回 `inserted/updated/unchanged/conflicts/missingPlatformMessageIds/diagnostics`。同平台 ID 正文冲突不按长度选择：只有同平台 ID 下 Codex 或 send-marker 的 final 非占位正文替换明确占位正文；有意义正文对有意义正文、同源采集版本或两个可信正文均返回 `resolution=unresolved`，保留既有行并报告 hash。

采集待办和打标待办签名为：

```ts
listPendingCapture(filters?: LogisticsAnalysisPendingCaptureFilters): LogisticsAnalysisSession[]
listPendingLabels(filters: LogisticsAnalysisPendingLabelFilters): Array<LogisticsAnalysisSession & { messages: LogisticsAnalysisMessage[] }>
```

`listPendingLabels` 必须传 `labelerRevision`，只返回 `capture_status=captured`、有完整 hash 和至少一条用户消息、且当前 hash/version/revision 没有有效标签的话题。

运行登记和条件提交签名为：

```ts
registerLabelRun(input: LogisticsAnalysisLabelRunRegistration): LogisticsAnalysisLabelRunRegistrationResult
commitLabel(input: LogisticsAnalysisLabelCommitInput): LogisticsAnalysisLabelCommitResult
failLabelRun(input: LogisticsAnalysisLabelRunFailureInput): void
expireLabelRun(input: LogisticsAnalysisLabelRunExpirationInput): void
labelRunState(sessionKey: string, contentHash: string, labelerRevision: string): LogisticsAnalysisLabelRunState
recoverStaleLabelRuns(input: { now?: number; staleAfterMs: number }): { expired: number }
```

`registerLabelRun` 返回 `outcome=created|reused|skipped`。`reused` 表示已有同版本 running，B 不得再次启动模型；`skipped` 表示已经有当前有效标签。内容或可见范围变化后旧 running 提交会变成 `expired`；孤儿 running 由 `recoverStaleLabelRuns` 回收。第四次同完整 hash 和 revision 的自动尝试返回 `analysis_label_attempt_limit`。

`commitLabel` 必须带 `runId/sessionKey/contentHash/labelerRevision` 和 LB、LP、resolution、confidence、needsReview、labelReason。提交同时校验当前 `content_hash`、`capture_version` 和 `capture_status=captured`；不匹配时不写标签，将 running run 记为 expired，并返回 `analysis_label_content_stale`。短暂 `captured -> failed -> captured` 且完整内容未变时不推进 `capture_version`，历史标签可恢复有效；`partial <-> captured`、冲突进入和完整消息变化会推进版本，避免复用旧结果。

旧运行回收签名为：

```ts
cleanupOldLabelRuns(input?: { now?: number; retentionMs?: number }): LogisticsAnalysisCleanupResult
```

默认回收 30 天前、且不属于当前完整 `content_hash` 的 run；当前 hash 下的失败、过期和 running 重试记录保留，不重置三次上限。

## C：只读概览接口

C 必须用只读实例：

```ts
const store = new LogisticsAnalysisStore({ dataDir, path, readOnly: true });
```

所有概览接口都必须传配置的当前 `labelerRevision`，缺失时返回 `analysis_labeler_revision_required`；不能省略 revision 后把任意旧 revision 当成有效：

```ts
summary(filters: LogisticsAnalysisFilters): LogisticsAnalysisSummary
trend(filters: LogisticsAnalysisFilters): LogisticsAnalysisTrendPoint[]
distributions(filters: LogisticsAnalysisFilters): LogisticsAnalysisDistributions
list(filters: LogisticsAnalysisFilters, page?: { limit?: number; offset?: number }): LogisticsAnalysisListResult
detail(topicPublicId: string, options: { labelerRevision: string }): LogisticsAnalysisDetail | undefined
```

统一过滤字段为 `labelerRevision`（必填）、`from`、`to`、`botId`、`scope`、`sessionStatus`、`captureStatus`、`labelStatus`、`lb`、`lp`、`resolutionStatus` 和 `needsReview`。日期 `from` 包含、`to` 排除；日期字符串按 Asia/Shanghai 的自然日解释，跨度超过 366 天或分页参数非法会返回 `analysis_*` 参数错误。每个方法在短 read transaction 内完成，不产生写入。

处理状态和业务三态严格分开。`captureStatus` 是 `pending|running|captured|partial|failed|conflict`；`labelStatus` 是 `not_ready|pending|running|failed|labeled`。只有同时满足 `capture_status=captured`、当前完整 `content_hash`、当前 `capture_version` 和请求的 `labelerRevision` 的标签，才投影 `lb/lp/resolutionStatus/confidence/needsReview/labelReason`；否则这些业务字段为 null。

列表默认 `limit=50`，返回 `items/total/limit/offset`。核心响应形状如下：

```json
{
  "items": [{
    "topicPublicId": "topic_0123456789abcdef0123456789abcdef",
    "title": "发货问题",
    "botId": "cli_logistics",
    "botName": "物流 Bot",
    "scope": "thread",
    "captureStatus": "captured",
    "labelStatus": "labeled",
    "lb": "LB02",
    "lp": "LP05",
    "resolutionStatus": "resolved",
    "confidence": "high",
    "needsReview": false,
    "lastMessageAt": 1787914302101,
    "dataTime": 1787914302101
  }],
  "total": 585,
  "limit": 50,
  "offset": 0
}
```

`summary` 输出 `totalTopics/capturedTopics/capturePending/captureRunning/capturePartial/captureFailed/captureConflict/labeledTopics/labelPending/labelRunning/labelFailed/messages/resolved/inProgress/unknown/needsReview/lastDataTime`。一期不对外宣称话题解决率；`resolved/inProgress/unknown` 只作为有效当前标签的三态计数。`trend` 按上海自然日输出总话题、采集、有效标签和三种 resolution 数量；`distributions` 输出 `lb/lp/resolution/captureStatus/labelStatus`，未打标业务分布使用 `unlabeled`。`detail` 只返回页面安全的脱敏逐条 `messages` 和当前有效标签信息，不返回 `labelRuns`、`messageKey`、`sessionKey` 或其他内部运行审计；运行审计仅供 B/排障方法读取。

## 迁移接口和对账

迁移入口为：

```ts
migrateLogisticsAnalysisDatabase(options: {
  sourcePath: string;
  targetPath: string;
  apply?: boolean;
  now?: number;
}): LogisticsAnalysisMigrationReport
```

`targetPath` 必填，`apply` 默认 false。source 以 SQLite read-only 打开；source 和 target 会同时检查 realpath 以及已存在文件的 `device/inode`，相同、symlink 同源或 hardlink 同源均在打开目标写入前拒绝。dry-run 不创建目标文件，apply 只写目标四表。迁移只读取 `session_catalog/conversation_messages/conversations`，忽略并报告旧 `conversation_labels`，`importedRows` 永远为 0。

消息报告同时提供 `candidateRows/uniqueGroups/duplicateRows/rawConflictGroups/trustedResolvedGroups/unresolvedConflictGroups/rawConflictRows/trustedResolvedRows/selectedRows/conflictRowsExcluded/missingPlatformIdRows/missingPlatformIdTopics`。原始 divergent group 全量可由 `rawConflictGroups` 和 `resolvedConflicts + conflicts` 对账；13 组“可信恢复替换占位”自动选入，未决组逐话题隔离，冲突候选行不导入，话题标 `capture_status=conflict`，不阻塞其他话题。

实际只读快照 `source-v5.sqlite` 的 dry-run 结果为：`614` catalog 行，`600` thread Session，`585` 话题，`11785` 消息候选，`9866` 去重组，`1919` 重复行；原始正文 divergent `16` 组，其中 `13` 组可信恢复、`3` 组未决，`36` 原始冲突行，`17` 个可信恢复候选行被替换，`6` 个未决冲突行隔离，最终选入 `9863` 行；14 个 chat 排除；旧标签 `613` 全跳过；话题状态为 `566 captured / 15 partial / 3 conflict / 1 pending`。这份报告不执行模型，也不写真实旧库。

协调任务在独立 candidate 目标上复核了 apply、二次 apply、四表 exact 和 integrity。二次报告中的 `targetCaptureUpdates=585` 表示对 585 个话题调用确定性采集状态/完整 hash 重算，不表示 585 条业务记录发生变化；二次实际写入为 0。

## B/C 修改边界

B 可新增或修改 `src/cli/logistics-analysis-collection.ts` 以及 `src/cli/logistics-conversation.ts` 中明确的离线采集命令接线，调用本交接的冻结接口。`src/services/logistics-analysis-store.ts`、`src/services/logistics-analysis-migration.ts` 和 `src/services/logistics-analysis-topic.ts` 是 A 的共享模块，B 不得直接修改；发现缺陷时回报协调任务统一处理，不得扩大表、改变版本/冲突口径或导入旧标签。模型执行、Harness 调用、调度和真实快照 apply 仍由 B/协调任务另行负责。

C 可修改 `src/cli/logistics-analytics.ts` 的只读 API 接线以及后续概览页面文件，必须使用 `readOnly: true` 和当前 `labelerRevision`；C HTTP 响应必须使用页面安全 DTO，不返回 `labelRuns`、内部 Session ID 或 message key。C 不得在查询路径写四表、生成原话题链接或新增页面字段之外的业务存储。`src/services/logistics-conversation-store.ts`、`src/services/logistics-session-master.ts`、`src/daemon.ts` 和 live daemon checkout 不属于本次 B/C 的自由编辑范围；如需兼容接线必须另行审查。

## 验证记录

新 worktree 已通过：

```text
pnpm exec tsc --noEmit
pnpm exec vitest run --project unit test/logistics-analysis-store.test.ts test/logistics-analysis-migration.test.ts
```

针对性单测结果为 2 个文件、7 个测试全部通过；连同承接链路的 4 个旧物流测试文件，共 6 个文件、34 个测试通过。覆盖跨 Session 合并、跨 Bot 隔离、平台消息幂等/冲突、缺平台 ID 诊断、source/target 相同拒绝、symlink/hardlink 拒绝、迁移排除/幂等、旧标签不导入、条件提交过期、三次上限、孤儿 running 回收、当前版本回收保护和只读统计分页。`git diff --check`、`pnpm exec tsc --noEmit` 和 `pnpm build` 均通过；全仓 unit 未纳入本任务最终验收。此 worktree 未执行 `pnpm switch:here`、`pnpm use:here`、daemon restart、push 或发布。
