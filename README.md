# WeUI 智能 UI 测试平台

网站探索 · 用例校准 · 自动执行 · 回归验证。

WeUI 面向测试团队，结合需求与页面观察生成测试草稿，经人工审核校准后，在真实浏览器中执行用例与回归，并保留操作过程、断言结果和截图证据。支持网站与登录身份管理、领域知识与测试方法复用。当前为 Web MVP v0.2，核心代码使用 TypeScript、Deep Agents 和 Midscene。

入口 http://localhost:3100。操作说明见 [网站接入与测试指南](docs/网站接入与测试指南.md)，本次实现和实测见 [v0.2 验证报告](output/Midscene网站自助测试开发与验证报告.md)。原有 v0.1 验证保留在 [历史记录](output/MVP开发与功能验证报告.md)，不代表本版本结果。

当前测试流程与本次体验改造见 [测试工作流体验重构与验证](output/测试工作流体验重构与验证.md)。

## 已实现

- 网站名称、URL、额外域名、默认浏览器、启停和版本管理。支持 Chrome（默认）、Edge 和 Firefox。
- 账号密码登录，Cookie / localStorage 会话导入，过期与撤销检查，登录验证计划。
- 功能与用例编辑：角色、入口、前置条件、自然语言操作、点击、输入、等待、页面预期及清理。
- 网站探索与用例沉淀：输入网站及需求正文，Deep Agents 组织 Midscene 导航和页面观察；草稿附带需求依据与截图，经人工修改、审核发布后进入正式测试。见 [探索使用指南](docs/网站探索与用例沉淀.md)。
- Deep Agents 在用户选择的用例范围内规划；也可直接采用所选用例。
- Midscene 统一执行 UI 操作与视觉断言；截图、逐项结论、事件、HTML 报告。
- 数据库持久化、运行快照、并发 Worker、取消、租约回收、幂等确认与受邀账号授权。
- 保留审批样例的 12 个场景、知识 Wiki / 本体和 Skill。样例保留独立业务查询与确定性断言。

执行链路为 **Deep Agents / Worker → Midscene PlaywrightAgent → Playwright → Chrome / Edge / Firefox**。Midscene 负责 UI 操作与页面断言，Playwright 管理浏览器、隔离会话、请求和截图。项目已移除 Puppeteer 直接依赖和调用；Midscene SDK 自身仍携带其其他适配器的间接依赖。

在“网站管理”设置默认浏览器，也可在“用例库”的运行栏切换本次浏览器。选择保存到任务及运行快照，一键回归保留本次选择。Firefox 使用 Playwright 专用构建，首次运行 `pnpm exec playwright install firefox`。浏览器兼容范围、运维配置见 [运行手册](docs/operations.md)。

本次迁移、三浏览器实测与启动结果见 [Playwright 多浏览器适配与验证](output/Playwright多浏览器适配与验证.md)。

## 本机运行

要求 Node.js 22.14+、pnpm 10.29.1、PostgreSQL 17、Redis 和已安装的 Google Chrome。本机项目独立 PostgreSQL 端口 55432，Redis 端口 56379，不修改电脑上已有的数据库服务。

```powershell
pnpm install --frozen-lockfile
pnpm run setup
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev
```

`pnpm run setup` 创建本机 `.env` 和随机受邀账号，账号见 `.runtime/access.local.md`。`PG_BIN` 可指定 PostgreSQL 安装路径。本机测试已通过 `BROWSER_EXECUTABLE_PATH` 固定为 Google Chrome；自动发现支持 Chrome / Chromium，不再回退 Edge。执行 `pnpm browser:check` 可检查浏览器启动、会话和截图。

升级时先停止应用进程，备份后执行 `db:generate`、`db:migrate`。Windows 上正在使用的 Prisma DLL 会阻止重新生成客户端。不要重置或清空已有数据库。

```powershell
pnpm health
pnpm build
pnpm start
```

先停止 `pnpm dev` 再启动生产模式。日志在 `.runtime/logs/{web,api,worker,sample}.log`，修改 `.env` 后需要重启应用进程。

## 使用自己的站点

1. 网站管理 → 添加名称、URL，以及 SSO / API / CDN 所需的额外域名。
2. 登录会话 → 保存测试账号密码或导入会话；访客测试可跳过。
3. 探索用例 → 提供需求生成草稿，在右侧审核校准并发布；也可在用例库手动新建。
4. 用例库 → 按功能筛选、跨页勾选最多 12 条，选择浏览器，点击“运行所选”。
5. 测试记录 → 查看每次执行的过程和验证结果，报告中可一键回归。校准后的用例需从用例库重新运行；一键回归复用原快照。

通用任务自动创建知识快照，锁定功能说明、用例预期及规则关系。现有审批 Skill 不能绑定通用网站，通用网站的测试方法通过用例编辑维护。

## 模型

Deep Agents 规划使用 `LLM_BASE_URL / LLM_MODEL / LLM_API_KEY`。本机 `LLM_MODEL=deepseek-flash`，可回退读取当前进程 `DEEPSEEK_API_KEY`。密钥不得写入任务或 Skill。

所有 UI 执行必须配置视觉模型：

```dotenv
MIDSCENE_MODEL_NAME=deepseek-flash
MIDSCENE_MODEL_BASE_URL=https://api.deepseek.com
MIDSCENE_MODEL_FAMILY=deepseek
MIDSCENE_MODEL_API_KEY=
MIDSCENE_MODEL_EXTRA_BODY_JSON={"thinking":{"type":"disabled"}}
```

本机 DeepSeek 服务可以复用 `DEEPSEEK_API_KEY`。其他服务请填写独立密钥。未配置时可以维护用例和生成计划，不能确认执行。自然语言操作启用 Midscene 的 `deepThink: true`，分开规划和视觉定位，规避 Flash 内联规划坐标与归一化坐标解析不一致的问题。

默认任务预算为 100 个动作、60 次模型调用、150000 tokens、10 分钟，动作上限可调整到 500。Midscene 内部动作也计入上限。规划及视觉模型按返回用量估算费用，管理员可在「空间设置 → 模型价格」配置单价；内置 2026-09-15 核验的 DeepSeek Flash 官方人民币价格，含高峰/空闲时段。缓存明细缺失时按未命中估算；严格计费硬限额应在供应商网关设置。

## 结果边界

页面 `PASS` 表示配置的 UI 预期成立且已保存证据，不代表后台事务已经独立核验。订单持久化、库存和账务正确性需要额外业务查询与确定性断言。`BLOCKED` 表示环境或配置阻断，`INCONCLUSIVE` 表示证据不足或副作用未知，不能当作产品通过。

浏览器与隔离会话会自动关闭，回收结果单独记录。未尝试业务 UI 写动作时显示 `NOT_REQUIRED`，不执行业务清理；确有操作但未配置清理时显示 `NOT_CONFIGURED`。已有完整事件证明无业务动作的历史误判可以重新执行。未知写结果、日志不全、清理或资源回收失败仍会阻止重跑。清理步骤为空时不会自动删除业务数据。当前未提供自动验证码 / MFA、人工接管、向被测网站上传文件、任意脚本和任意工具安装。

登录秘密以 AES-256-GCM 加密，密钥从 `SESSION_SECRET` 派生。备份恢复时必须单独保管该环境秘密。浏览器按用例隔离，登录阶段使用独立 Agent，公开报告不保存登录口令。

## 验证与代码

```powershell
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm exec tsx scripts/regression.ts
pnpm exec tsx scripts/evaluate.ts
pnpm exec tsx scripts/concurrency.ts
pnpm exec tsx scripts/backup.ts --verify
```

先启动应用。集成检查会切换执行开关，应与其他验收串行运行。真实 UI 测试要求视觉模型；CI 缺少密钥时明确跳过这些用例。截图位于 `.runtime/screenshots`，验证记录位于 `.runtime/verification`，运行证据位于 `.runtime/evidence`。

| 目录 | 职责 |
|---|---|
| apps/web | Next.js 工作台和网站 / 会话 / 用例编辑 |
| apps/api | Fastify API、授权和报告 |
| apps/worker | BullMQ 规划、执行、取消和租约 |
| packages/websites | 网站范围、凭证保险库和配置快照 |
| packages/agent | Deep Agents 规划 |
| packages/pricing | 官方价格快照、可配置单价及模型费用估算 |
| packages/executor | Midscene、Chromium 会话和证据 |
| packages/knowledge / assertions | 知识、本体和样例独立断言 |
| packages/db | Prisma 模型和增量迁移 |
| tests / evals | 单元、集成、Midscene Web E2E 和评测 |

部署、告警、备份和回退见 [运行手册](docs/operations.md)。

## 简洁测试闭环（2026-09-15）

打开 `http://localhost:3100/#/cases`，选择网站和已保存用例后直接测试。旧 `#/new` 入口复用同一用例库。探索草稿仅在探索页审核，正式运行按次列在测试记录；报告提供所选浏览器实时画面、步骤、验证结论和关键截图回看。详细使用方式见 [网站接入与测试指南](docs/网站接入与测试指南.md)。

新接口 `POST /api/case-runs` 接收 `projectId`、`environmentId`、`caseIds`（1–12）、`idempotencyKey` 和可选 `budget`，原子去重运行并冻结用例版本。`GET /api/runs/:id/preview` 经过登录及项目权限检查，返回最新浏览器 JPEG / 登录隐藏状态，响应禁止缓存。回归仍走既有父运行校验。

运行报告为每个普通网站用例提供一个最终 Midscene 报告入口；历史阶段附件折叠展示。反馈保存在本机 PostgreSQL，可在运行页下方及左侧「反馈记录」查看作者、类型、评分、内容和对应运行，不会自动发送外部工单或改写机器结论。
