# WeUI MVP 运行手册

## 进程与数据

Web 3100、API 3101、审批样例 3102 为独立 Node.js 进程；Worker 并发默认为 2。原生开发绑定 loopback，外部用户访问需要部署到授权内网入口。数据存储：PostgreSQL 保存任务、网站、加密会话、功能用例、版本、事件及业务样例；Redis 保存异步队列；`.runtime/evidence` 保存截图和 Midscene 报告，也保留历史运行的 Trace。

默认内置账号仅供本机体验。管理员在 Web“空间设置”添加受邀用户，账号只能访问加入的项目。所有证据下载和 SSE 订阅都验证会话及项目授权；SSE 在连接存续期间重新检查授权。会话有效期 8 小时。

## 停止、恢复与故障定位

- 优先等待运行结束，再在 Web 暂停执行并停止应用进程。暂停开关也会停止后续 UI 动作，包括通用网站的 UI 清理；此时须核对被测系统。仅审批样例的固定清理工具不受该开关阻挡。
- 正常进程重启后，数据库历史和 SSE 事件可以继续读取。运行中的浏览器现场不恢复，失联 30 秒后回收租约；未知写结果不会自动重放。
- API、队列、数据库、样例业务的健康检查：`pnpm health`。Web 管理页同时显示 Worker 状态；日志分别在 `.runtime/logs`。
- 模型问题先看任务的规划错误，再核对 `.env` 网关和模型；`configured` 只表示存在配置，实际成功以运行 usage 和计划为准。
- 默认使用 Google Chrome，可在网站配置和执行页面选择 Edge 或 Firefox；UI 操作统一使用 Midscene PlaywrightAgent，必须配置视觉模型。Chrome 与 Edge 按所选品牌发现，缺失不会回退到另一浏览器。Firefox 使用 Playwright 专用构建。
- `pnpm browser:check` 会检查浏览器启动、独立会话和截图；`pnpm health` 仅检查应用与基础服务。启动最多尝试两次，尚未访问被测网站时才重试。运行时间线保留浏览器路径、版本、尝试次数和失败诊断；指定的浏览器路径无效时明确报错。连续失败归为 `BROWSER_LAUNCH_FAILED`，不能解释为账号或业务断言失败。
- 自定义 Skill 描述应与所选场景一致。规则或范围缺失会显示 `missingRequirements` 并阻止执行；修改草稿后需要重新调试。
- `FAIL` 为断言不成立：审批样例使用独立业务断言，通用网站使用 Midscene 页面断言。`INCONCLUSIVE` 为证据或副作用无法确认；`ERROR` 是运行故障，不能当作业务通过。
- `CLEANUP_FAILED` 保留原运行与命名空间。仅针对本项目的审批样例，可使用 `pnpm exec tsx scripts/reconcile.ts <run-id>` 检查并清理该运行遗留数据；原结论与原清理状态继续保留，处理记录进入审计。
- 浏览器回收与业务清理分开记录。`browser.closed` 表示浏览器和本地隔离会话关闭，`browser.cleanup.failed` 会阻止重跑；并不代表服务端注销。未尝试业务 UI 写动作时为 `NOT_REQUIRED`，不执行清理步骤。重跑会核查实际动作与完整事件；历史误判只有在支持的执行器版本和完整日志证明未尝试业务写动作时才自动放行，原结果不会改写。
- 网站探索复用相同的运行租约、预算、取消和证据机制。成功后保存独立待审草稿，不生成测试通过结论；审核发布后才进入正式用例库。具体限制见 [探索指南](网站探索与用例沉淀.md)。
- API 全局限制为每 IP 每分钟 1200 个请求，登录每分钟 20 次。真实流量验收后按反向代理和会话规模配置。自动化客户端应遵循 429 `Retry-After`，不要高频刷新。

建议运维每分钟调用健康检查，将非零退出码、离线 Worker、未投递 Outbox、清理错误和磁盘不足接入现有告警平台。本 MVP 提供探针与可查询日志，尚未接入企业告警收件人或自动发送消息。

## 备份与恢复

先暂停执行，并等待当前规划/运行结束，再运行：

```powershell
pnpm exec tsx scripts/backup.ts --verify
```

命令使用 `pg_dump` 生成一致性数据库快照，复制证据文件并计算 SHA256。`--verify` 在新建的 `uiagent_restore_<timestamp>` 数据库还原，检查任务/运行计数和证据路径；成功后只删除这一个临时还原数据库。原数据库始终保留。失败时保留临时库供排查。

备份目录 `.runtime/backups/<timestamp>` 含 `database.dump`、`evidence/`、`manifest.json`，不包含 `.env`。凭证由部署环境的密钥管理单独保护。Windows 默认使用 PostgreSQL 17 工具，可通过 `PG_BIN` 覆盖；Linux 宿主需要可执行的 PostgreSQL 17 客户端。容器部署可从 postgres 容器运行 `pg_dump`，并备份 runtime 卷。

恢复真实部署前停止应用并选用备份副本；先还原到新数据库验证，再切换 `DATABASE_URL` 和匹配证据卷。禁止把验证命令改成覆盖现有数据库。代码回退使用上一构建镜像与相应迁移版本，新增迁移应保持向后兼容；不可逆迁移必须先在副本演练。

## 内网容器部署

提供 `Dockerfile`、`deploy/compose.yaml`、`deploy/Caddyfile`。本机没有 Docker，容器启动与内部 HTTPS 尚未实测。

1. 在部署主机安装 Docker Compose，配置 `.env` 里的随机强密码和模型。额外提供 `POSTGRES_PASSWORD`（建议十六进制随机串）和 `TRACELAB_DOMAIN`。
2. 执行 `docker compose --env-file .env -f deploy/compose.yaml up -d --build`。
3. Caddy 默认使用内部 CA；由企业运维配置受信任证书或分发内部 CA，并验证域名、TLS 与浏览器信任。本脚本不会在用户电脑安装根证书。
4. 只开放网关端口；数据库、Redis、API 和样例业务留在内部网络。证据、数据库和队列使用持久卷。
5. 创建受邀用户，完成真实业务适配器与 QA 规则接入后，再执行同等的端到端、反例、并发、重启与备份验证。

本机已经验证 deepseek-flash 视觉模型。部署 owner、企业证书、正式测试系统、告警目标与真实测试人员试用仍需由团队落实。当前交付状态为“可本机体验的 MVP，企业发布验收待完成”。网站接入和会话配置见 [接入指南](网站接入与测试指南.md)。

## Playwright 与浏览器选择（2026-09-15）

依赖固定为 `playwright@1.63.0`、`@midscene/web@1.12.6`。执行与验证脚本统一使用 Playwright；上游 Midscene 包仍有 Puppeteer 间接依赖，业务执行不调用该适配器。无需数据库迁移；旧网站默认 Chrome，原有用例与报告保留。

- Chrome 路径：`CHROME_EXECUTABLE_PATH`，未指定则兼容旧 `BROWSER_EXECUTABLE_PATH`，再自动发现 Google Chrome。
- Edge 路径：`EDGE_EXECUTABLE_PATH`，未指定则自动发现 Edge，绝不使用 Chrome 的旧路径变量。
- Firefox：`pnpm exec playwright install firefox`。可通过 `FIREFOX_EXECUTABLE_PATH` 指向匹配版本的 Playwright Firefox，普通桌面 Firefox 不适用。多用户服务应设置共享 `PLAYWRIGHT_BROWSERS_PATH` 并授予 Worker 读取执行权限。
- 启动自检：`pnpm browser:check`、`pnpm browser:check edge`、`pnpm browser:check firefox`。
- `Environment.config.browser` 保存网站默认值；任务 `browserSnapshot.browserName` 与运行 `manifest.browser` 固定执行选择。`browser.ready` 记录品牌、Playwright 引擎、实际版本及可执行路径；历史记录未保存的字段不补造。
- Firefox 采用 Midscene 的鼠标/键盘操作空间；适配器用 Playwright 原生全选/删除替换 CDP 清空输入操作。触摸手势、CDP 录屏、浏览器级多标签切换不在当前支持范围。预览采用截图轮询，原生下拉框弹出层的视觉操作仍取决于浏览器呈现。
- 每个隔离会话使用独立本机代理与认证信息，按允许 origin 检查 HTTP 转发和 HTTPS CONNECT，覆盖 Playwright route 不再次处理的重定向。代理随会话关闭；凭证不进入模型或运行报告。执行服务器需允许本机动态端口。

容器配置已更新为安装 Chrome 和 Playwright Firefox；容器内 Edge 须另行安装，Docker 部署仍待目标主机验收。

技术依据：[Midscene Playwright 接入](https://midscenejs.com/zh/integrate-with-playwright)、[Playwright 浏览器说明](https://playwright.dev/docs/browsers)。


## 用例直跑与浏览器预览

新增接口无需数据库迁移。API 与 Worker 都须更新；Web 更新后执行 `pnpm build` 并重启生产应用。执行仍通过既有 Outbox / Worker / 租约通道。请求幂等覆盖完整创建与启动链路，同用例前次异常继续受保护。

预览使用 Redis 键 `ui-agent:preview:<runId>`，每个运行仅保存最新 JPEG / 登录隐藏状态，24 小时 TTL。预览读取检查项目权限且禁止 HTTP 缓存。Redis 预览写入异常不会中断浏览器测试；前端会显示更新失败或画面陈旧。正式步骤、断言与最终截图按证据保留策略保存，Redis 最新帧不作为最终通过结论的唯一依据。

专项验证：`pnpm exec tsx --test tests/integration/case-runs.test.ts`（真实 Chrome UI / 登录 / 正反例 / 回归），`pnpm exec tsx --test tests/integration/case-run-guards.test.ts`（权限 / 并发 / 未知结果保护），`pnpm exec tsx --test tests/integration/discovery.test.ts`（探索审核发布后直接执行）。这些测试建立独立临时网站，结束后停用并保留报告。

## 模型价格和反馈记录

无需数据库迁移。API 首次启动用 `Setting.key=model_pricing` 保存价格表；此次升级将内置 Flash 官方美元报价更新为人民币报价，旧报价归档到 `model_pricing_archive:<hash>` 并记录审计。已有人民币配置及非官方自定义美元报价不会被覆盖。旧美元环境单价只作兼容导入，须在设置页录入人民币报价后才能估算人民币费用。官方价格按服务地址和模型名精确匹配（兼容 `/v1`），不会给第三方代理地址套用官方单价。

初始 DeepSeek Flash 单价来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ ，核验日期 2026-09-15。人民币元 / 百万 Token：高峰输入未命中 2、命中 0.04、输出 8；空闲分别为 1、0.02、4。高峰为北京时间周一至周五 09:00–12:00、14:00–18:00；未实现定时联网同步。

`GET /api/model-pricing` 为已登录成员提供只读价格和当前模型；`POST /api/admin/model-pricing` 仅管理员可保存，要求携带读取时的 `updatedAt`，并以数据库条件更新处理并发冲突，写入管理审计。价格是平台共用配置。

运行 Manifest 增加 `models` 和 `pricing` 快照。`usage.charges` 区分规划/视觉模型，保存每次用量增量、收集时间、时段、Token、已知缓存命中、单价及来源。单价及调用明细的 `currency=CNY`，人民币费用保存在 `costCny`，不会将人民币金额写入历史 `costUsd` 字段。估算包含执行中登录、操作、断言和清理的模型用量。缓存缺失按未命中估算；金额只覆盖服务已返回的用量，存在请求中断或跨时段误差。人民币预算 `maxCostCny` 在提交运行时固化，缺省采用 `RUN_MAX_COST_CNY=10` 元；原美元预算只检查美元用量，两个币种不混算。费用预算在用量返回后检查，不能替代供应商硬限额。回归复用已生成计划，不再次计入历史规划费用。

`GET /api/runs/:id/cost` 校验项目权限，返回已保存估算 / 部分计价 / 历史参考 / 未知。有模型明细的美元记录按原 Token、缓存、时间及当前人民币单价重算参考费用，不做汇率换算；原始记录保持不变。历史单视觉模型运行按当前配置和运行开始时间提供显式参考估算，不写回旧记录。无法区分模型的旧混合用量保持未知。

反馈继续保存在 PostgreSQL `Feedback` 表：关联 `runId` 和 `userId`，包含 `rating`、`category`、`comment`、`createdAt`。`GET /api/feedback?projectId=...&runId=...&category=...&page=1&size=10` 提供工作空间授权、可选运行/类型筛选及服务端分页（最多 50 条），返回作者名称和原任务标题。没有外部邮件/工单集成，也没有自动修改用例或机器结论。

验证：`pnpm exec tsx --test tests/integration/report-tools.test.ts` 使用临时本机网站，检查多断言一份报告、模型费用快照、配置和反馈权限、分页、Chrome + Midscene 提交/查看反馈及价格设置保存。验证信息在 `.runtime/verification/report-tools.json`。
