# 物流专家 · 会话概览

这是物流会话分析 v1 的只读概览站点。分析单位是一个飞书 thread 话题，一个话题只代表一个问题；页面只读 A 任务产出的四表库 `sessions`、`messages`、`labels`、`label_runs`，不会读取 BotMux 原始会话文件，也不会写入 SQLite 或运行状态文件。

## 启动

默认数据库是 `<dataDir>/logistics-analysis.sqlite`，`--db` 可以显式指定其它四表库。旧 v5 `botmux-conversations.sqlite` 不会自动迁移，直接使用会明确报不支持。

```bash
botmux analytics serve \
  --harness-root /path/to/order-delivery-codex-workspace
```

`--harness-root` 通过现有 `validate_labeling.py --print-revision` 计算当前 Harness revision；也可以显式传入：

```bash
botmux analytics serve \
  --db /path/to/logistics-analysis.sqlite \
  --labeler-revision <revision>
```

两者都缺失时启动失败。服务默认只监听 `127.0.0.1`，非 loopback 监听必须设置 `BOTMUX_ANALYTICS_TOKEN`。token 仅用于内部服务保护；HTTPS、企业鉴权反代和 SSO 由最终接入层负责，本服务不宣称已经实现企业 SSO。

## 页面和筛选

默认展示上海时区近 30 个自然日，结束日期包含当天；点击“全部历史”会清空日期筛选。筛选变更会清零 offset，并写入 URL；刷新、前进和后退会恢复相同筛选与分页位置。明细每页 50 条，接口返回完整 `total`、`limit` 和 `offset`。

页面展示总话题、采集/打标数量和覆盖率、已解决/进行中/未知数量、待处理数量、LB/LP 分布、按日趋势、分页明细和脱敏详情。解决状态是三态业务标签，不展示解决率、满意度、问卷、人效、人工改标或原话题跳转。`LB99`、`LP99` 是有效分类，不等于未打标；未打标单独显示为“未打标”。Bot 使用配置的显示名称，内部 Bot ID 不作为产品主文案。

兼容筛选参数为 `from`、`to`、`bot`、`lb`、`lp`、`resolution`、`dataStatus`、`needsReview`，另支持 `labelStatus`。旧采集状态会映射到新状态：`processing` 到 `running`，`missing_turn`/`missing_answer` 到 `partial`，`history_failed` 到 `failed`；`skipped` 属于被排除的特殊会话，不会伪装成新的 thread 状态。

所有查询都由服务端附带启动时确定的当前 revision。请求不能通过 query 参数切换 revision；旧 revision 的标签不会投影为当前有效标签。详情 HTTP DTO 只返回页面需要的标签和脱敏 `user`/`assistant` 消息、时间，不返回 `labelRuns`、内部 session key、`cliSessionId`、消息 key、平台消息 ID、原话题链接或原始鉴权信息。

## 调度状态

采集/打标任务可在 `<db>.run.json` 写入以下结构：

```json
{
  "schemaVersion": 1,
  "status": "running|succeeded|partial|failed",
  "startedAt": 0,
  "finishedAt": null,
  "lastSuccessfulSyncAt": null,
  "lastSuccessfulCaptureAt": null,
  "lastSuccessfulLabelAt": null,
  "pendingCapture": 0,
  "pendingLabel": 0,
  "errorCode": null
}
```

概览只读取并投影允许字段。文件缺失、JSON 不合法或字段不符合契约时显示“尚无调度记录/状态不可用”。页面分别显示最近一次成功采集和打标时间；超过两小时未成功更新会显示延迟。`partial` 只表示本轮部分完成，不会被显示为全成功。页面刷新时间不会被当作采集时间。

## HTTP 接口

`GET /overview` 和 `GET /` 返回页面；`GET /healthz` 返回健康状态；`GET /api/status` 返回安全的调度状态投影；`GET /api/overview`、`/api/trend`、`/api/distributions` 和 `GET /api/sessions` 返回当前 revision 下的汇总、趋势、分布和分页明细；`GET /api/sessions/:topicPublicId` 返回安全详情。所有接口均为 GET，响应禁止缓存；有 token 时支持 Bearer、HttpOnly cookie 和一次性的 query token 换 cookie 跳转。

查询路径使用 `LogisticsAnalysisStore({ dataDir, path, readOnly: true })`。服务不会调用迁移接口，不会自动创建或修复数据库，不会修改 `.run.json`，也不切换或重启 live daemon。
