# Midscene.js 重点研究与接入建议

> 2026-09-15 当前实现：已按最新要求切换为 **Midscene PlaywrightAgent + Playwright**，支持 Chrome（默认）、Edge、Firefox。网站及用例执行页可选择浏览器，运行快照固定选择供回归。下文 2026-09-14 的 Puppeteer 选择与历史验收记录已被此次迁移取代，当前实现与限制见 [运行手册](../docs/operations.md)。


> 2026-09-14 实施更新：当前项目使用 **Midscene 1.12.6 PuppeteerAgent** 执行全部 UI 操作与断言，不使用 Playwright。视觉模型已接入并实测 **deepseek-flash**，模型 family 为 `deepseek`。自然语言流程使用 `deepThink: true` 分离规划与定位；已验证访客、表单登录、Cookie / localStorage 导入及反例。下文是早期能力研究和混合执行建议，不作为当前实现说明。最新结果见 [v0.2 报告](Midscene网站自助测试开发与验证报告.md)。

版本：v1.3 | 原能力核查：2026-09-11；MVP 范围更新：2026-09-13。本文同时收录于《企业内部 UI 智能测试落地方案》第 15 节。基于官方资料和方案需求分析，尚未在企业系统中运行模型或验证成本；采用结论以试点为准。

## 15 Midscene.js 专题：重点试点视觉执行与自然语言测试

### 选型结论与适用位置

**建议把 Midscene 列为首批验证组件，采用 Playwright Test + Midscene SDK 的混合方式。**稳定定位、数据准备、业务查询和关键断言由代码负责；对语义描述更方便的页面操作、复杂视觉控件、辅助视觉判断及有限探索，引入 Midscene。该建议基于能力与需求的匹配，尚无本企业实测胜率或成本数据。

Midscene 的 UI 定位与操作以视觉模型理解截图为基础，支持自然语言任务与单步 API，并提供 Web、移动端等接入方式。它能解决执行和页面理解问题，但仍需企业自行建设业务规则、账号数据、覆盖策略与结果验收。[官方介绍](https://midscenejs.com/zh/introduction)、[模型策略](https://midscenejs.com/zh/model-strategy)

与参考资料 A4 的 DOM/ARIA 候选加视觉选择方案相比，Midscene 的视觉定位路线不同。两条路线可共存于执行适配器：先由已知页面规则选择合适能力，不要假定 Midscene 内部就是 DOM 候选排序；也不要把所有 DOM 可操作页面排除在试点外，应比较编写和维护成本。

### 能力与职责对应

| 能力 | 能做什么 | 企业方案中的边界 |
| --- | --- | --- |
| aiTap、aiInput 等单步 API | 用页面描述定位并执行指定操作 | 外层明确步骤和目标；操作后核对业务对象与状态 |
| aiAct | 将自然语言目标规划为多步操作 | 用于隔离环境的有限探索；外层设置权限、总时长与费用预算 |
| aiQuery、aiAssert | 从当前页面取数，或判断自然语言条件 | 可作页面证据；不能代替持久化状态、权限和审计断言 |
| Playwright 集成 | 对已有 page 创建 Agent，或通过测试 fixture 接入 | 复用现有测试数据、用例组织和 CI，控制接入范围 |
| 报告与用量信息 | 保存过程和截图，提供调用用量信息 | 对接统一 run_id、失败原因、模型版本和费用统计 |

API 语义依据：[基础 API](https://midscenejs.com/zh/basics)、[API 参考](https://midscenejs.com/zh/reference/)、[Playwright 集成](https://midscenejs.com/zh/integrate-with-playwright)。单步 API 中的提示词应描述一个操作目标；条件分支由代码控制，不能把完整流程塞进点击目标描述。aiAssert 的判断仍来自模型对页面的理解，同一模型生成并判断测试时，需要独立业务预期避免相互迎合。

建议一次审批链路这样分工：API 准备申请与角色 → Playwright 登录和进入业务对象 → Midscene 操作代表性复杂控件 → Playwright 核对对象 ID 并执行已授权提交 → 只读 API 验证最终状态与审计 → 汇总两类报告。若需要让 aiAct 处理含写入的整段流程，必须先验证执行层能约束每个动作；缺乏该能力时，应拆成单步调用与已授权业务工具。

平台采用 Deep Agents 时，由其拆解业务阶段、组织知识与分析结果，Midscene 执行单步或短流程。平台统一统计两层模型调用和动作预算，并为每个浏览器会话指定操作者；子 Agent 并行分析日志时，不共享对同一页面的操作权。完整分层和对照验证见总方案第 16 节。

### 三种接入方式的取舍

| 方式 | 适合场景 | 本次建议 |
| --- | --- | --- |
| PlaywrightAgent / Playwright fixture | 已有或准备建设 TypeScript 回归仓库 | 首选；保留现有 runner、数据和业务断言 |
| @midscene/test | 希望用 YAML 编排语义用例，并通过 TypeScript 节点扩展数据与服务操作 | 独立试点；官方当前标为 Beta，先验证 schema、升级与调试成本 |
| 交互式体验或外部 Agent 工具入口 | 熟悉能力、验证提示词与页面可操作性 | 用于发现候选场景，产物达到复现与验收要求后再入库 |

Midscene Test 将语义节点与类型化自定义节点结合，但 Beta 状态意味着接口和使用方式仍可能变化。本期不把它设为已有回归仓库迁移的前提。[Midscene Test 概览](https://midscenejs.com/zh/midscene-test/overview)、[扩展自定义节点](https://midscenejs.com/zh/midscene-test/extend)

### 必须验证的行为差异

这些细节来自官方文档，应在锁定依赖版本后重测，而非直接照抄示例配置。

1. **新标签页：**Playwright 集成默认启用 forceSameTabNavigation，会把新标签页导航转到当前标签页。测试产品真实跳转行为时关闭该选项，并显式管理新 page 或验证 BrowserAgent 的跟随策略。
2. **原生下拉框：**默认 forceChromeSelectRendering 会调整 Chrome 原生 select 的呈现。测试原生外观和行为时关闭并建立对应基线；普通表单可直接使用 Playwright 的标准选择操作。
3. **浏览器差异：**部分能力依赖 Chromium/CDP；不能因为 Playwright 支持多个浏览器，就推定 Midscene 所有能力在 Firefox/WebKit 一致。先锁定 Chromium 主路径，兼容测试按能力清单验证。

以上依据：[Playwright 集成的浏览器行为说明](https://midscenejs.com/zh/integrate-with-playwright)。示例中的固定等待、启动参数与模型名称也需按企业环境调整，不能当作生产模板。

4. **上下文不是叠加规则：**调用级 context、API 级 aiContexts 和默认 context 按优先级选用，并非自动合并。关键约束放到可执行策略中，避免局部上下文覆盖后丢失。[基础 API 上下文配置](https://midscenejs.com/zh/basics)
5. **规划次数不是总预算：**replanningCycleLimit 限制重新规划次数；总动作数、调用次数、token、金额和任务墙钟时间仍需平台独立控制。[Agent 参数与用量回调](https://midscenejs.com/zh/reference/)

### 缓存能提速，但不能当作离线确定性回放

Midscene 缓存包含规划结果与 Web 定位快捷路径。缓存失效或未命中时仍可能调用模型；aiQuery、aiAssert 等页面理解 API 不缓存结果。read-only 表示缓存读写策略，不代表禁止模型推理；也不能据此宣称回归不再受模型变化影响。[缓存机制](https://midscenejs.com/zh/caching)

本项目建议分别记录冷缓存、热缓存、失效回退的耗时和费用。按用例、角色、应用版本和依赖版本划分缓存命名空间；禁止将未知来源的缓存直接作为发布依据。Canvas 等页面不能期待 XPath 快捷路径获得同样收益。缓存流程执行到一半后失效时，先确认已发生的业务副作用，再决定是否继续或重启。

稳定回归如果要求完全不调用模型，应落为经过审核的确定性代码路径，并在运行记录中验证模型调用数为零。把缓存策略改成 read-only 不能实现这个要求。

### 模型、数据与报告接入

模型选择先验证企业获准的多模态服务对截图定位的效果；需要内网部署时，再比较可自托管的视觉模型与现有推理基础设施。接口形式兼容并不保证坐标、图像输入和返回格式满足 Midscene。先运行固定版本 CLI 的模型验证，再在真实代表页面比较，不直接引用官网其他平台的成功率作为本项目指标。[模型配置](https://midscenejs.com/zh/model-common-config)、[模型调试与可观测性](https://midscenejs.com/zh/model-debugging-observability)

SDK 在本机运行与模型推理在内网是两回事。官方说明页面截图等数据会发送到配置的模型服务。实施时画清浏览器、模型网关、推理服务、trace 和报告的真实数据路径；使用测试数据，限制报告访问，核对配置覆盖后的实际 endpoint。[数据隐私说明](https://midscenejs.com/zh/data-privacy)

推荐从一个多模态模型开始；只有规划或信息提取出现明确瓶颈时，再评估拆分 Planning/Insight 模型。报告可导出结构化内容用于内部汇总，但“报告里有操作成功”不能直接映射业务 PASS；应绑定独立断言和缺陷证据。[模型策略](https://midscenejs.com/zh/model-strategy)、[报告消费工具](https://midscenejs.com/zh/consume-report-file)

### 对照试验与采用条件

MVP 先完成一个代表控件的单步接入与 20 项基线评测，不将下面完整对照作为上线前置；在后续扩展阶段，从总方案第 11 节的 40 个评测任务中抽取 12 个：6 个正常任务、4 个已知缺陷任务、2 个环境或权限阻断任务。比较纯 Playwright、Playwright + Midscene 单步混合、受限 aiAct 三种方式；每个组合重复 3 次，共 108 次计划运行。该规模是试验设计，不是已完成实测。另挑少量流程做冷/热/失效缓存对照，单列运行数和预算。

| 场景组 | 故意设置的变化或问题 | 应取得的证据 |
| --- | --- | --- |
| 普通表单与审批 | 文案变化、列表重排、多个同名按钮 | 操作的是指定业务对象，不能仅验证点击完成 |
| 视觉复杂页 | 小控件、滚动、弹层、Canvas 或图形选择 | 成功率、定位误差、重试和人工维护时间 |
| 真实浏览器语义 | 新标签页、原生 select | 开关前后行为差异与适用配置 |
| 已知业务缺陷 | 页面提示成功但后端未改变、权限错误 | 独立断言应失败或标记阻断，禁止误通过 |
| 恢复与缓存 | 模型超时、流程部分写入、缓存失效 | 无重复提交，回退过程和额外调用可追溯 |

采用条件：关键缺陷样本无观测到的误通过；无越权或错误对象写入；正常与阻断任务分类可解释；端到端人工工时降低；p50/p95 时延、每个有效用例费用与维护成本在试点预算内。小样本结果不能证明真实误判率为零。只在达到条件的场景推广，DOM 定位已经便宜稳定的部分继续保留。
