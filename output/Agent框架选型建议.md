# 企业 UI 测试 Agent 开发框架选型

> 2026-09-15 当前实现：已按最新要求切换为 **Midscene PlaywrightAgent + Playwright**，支持 Chrome（默认）、Edge、Firefox。网站及用例执行页可选择浏览器，运行快照固定选择供回归。下文 2026-09-14 的 Puppeteer 选择与历史验收记录已被此次迁移取代，当前实现与限制见 [运行手册](../docs/operations.md)。


> 2026-09-14 实施更新：用户确认不采用 Playwright。当前组合为 **Deep Agents TS + Midscene PuppeteerAgent + Puppeteer 浏览器宿主**，已完成网站自助接入和真实模型执行。Puppeteer 仅管理会话、网络、截图与浏览器，UI 操作统一交给 Midscene。下文保留早期选型比较；涉及 Playwright 的项目推荐已被本决定取代。实际范围与证据见 [v0.2 报告](Midscene网站自助测试开发与验证报告.md)。

版本：v1.4 | 更新日期：2026-09-13；原框架能力核查：2026-09-11，知识与扩展接入资料核查：2026-09-13。本文同时收录于总方案第 16 节。核心语言已确认为 TypeScript，用户通过 Web 使用；部署条件仍待接入时确认。本文未声称完成性能或故障恢复实测，开发顺序见《MVP开发任务清单与迭代路线》。

## 16 Agent 开发框架选型：用显式流程承载可恢复任务

### 本次选型对象与推荐

这里选的是**开发企业内部 UI 测试 Agent 平台的运行与编排框架**，包括规划、执行、判定、人工复核和资产沉淀。开发者日常使用的编码助手属于另一类采购与使用决策。

首选验证 **Deep Agents（基于 LangGraph）+ Playwright Test + Midscene SDK**。Deep Agents 作为应用开发入口，负责知识使用、任务拆解、上下文管理、用例生成和失败分析；LangGraph 承担底层状态与运行能力，需要精细控制的阶段再使用显式流程。MVP 采用 Deep Agents TS 实施；直接 LangGraph 与 Mastra 保留为遇到明确障碍时的替换路径，不要求先完成多框架竞赛。

本项目已确认采用 TypeScript：Web、API、Agent 和浏览器 Worker 共享语言与契约；核心链路不增加 Python 服务。以下其他语言框架保留为调研记录，当前不再作为并行选型任务。采用 Deep Agents 是工程路线选择，尚未证明其时延、成本或成功率优于其他方式。[Deep Agents 官方介绍](https://docs.langchain.com/oss/javascript/deepagents/overview)

### 先分清四个层次

| 层次 | 负责的问题 | 首期建议 |
| --- | --- | --- |
| Agent 应用与编排 | 知识使用、任务拆解、上下文、暂停恢复和结果汇总 | Deep Agents 作为入口；基于 LangGraph 运行，关键阶段按需使用显式流程 |
| UI 与业务执行 | 浏览器会话、页面动作、数据准备、结果查询 | Playwright + Midscene + 企业适配器 |
| 任务基础设施 | 排队、并发配额、租约、超时、取消、清理 | MVP 使用独立 Worker 与持久队列；稳定回归后续接入 CI |
| 观测与评测 | 证据、模型调用、费用、反例集、人工结论 | 独立 run_id 与统一结果协议，便于替换框架 |

MCP 是工具接入协议，不能替代这四层。LangGraph 的检查点也不能替代浏览器资源管理。MVP 在同一 TypeScript 仓库管理模块，Web、API 与 Worker 分进程部署；浏览器执行从第一版起脱离 HTTP 请求生命周期。

Deep Agents 已使用 LangGraph 的运行基础，不必为每个任务再套一层执行同样规划工作的外层 Agent。业务策略、预算、执行接口和独立断言保持程序控制。

### 候选框架对比

下表“适用判断”是本项目建议；“能力依据”来自当前官方文档。没有进行框架性能或成功率实测。

| 候选 | 能力依据 | 本项目适用判断 | 主要验证点 |
| --- | --- | --- | --- |
| Deep Agents | Python / TypeScript；上下文压缩、文件工具、子 Agent；可配置 Skills、任务清单和人工介入 | 首选应用开发入口，覆盖分析、生成、探索和诊断 | 默认工具与上下文开销；功能按需启用；业务断言、浏览器恢复仍需自建 |
| LangGraph | Python / TypeScript；状态图、检查点、interrupt 人工介入 | Deep Agents 的运行基础；直接使用作为精细流程控制的对照方案 | 持久化恢复、节点重入、副作用与浏览器脱节；直接构建时需补上下文等能力 |
| Mastra | TypeScript；类型化步骤、工作流、存储快照、暂停恢复 | TS 备选，适合重视一体化开发体验的团队 | 存储和 runner 的恢复语义；已有平台接入成本；开源与 EE 功能边界 |
| Pydantic AI | Python；类型化依赖与输出；可集成持久执行引擎 | Python 团队的候选，适合结构化规划与评测组件 | 长任务采用哪种引擎；跨 Node 执行边界和新增运维成本 |
| Microsoft Agent Framework | .NET / Python，以及仍为预览的 Go；图式流程、检查点 | .NET / 微软生态积累强时优先重评 | 各语言能力差异、包版本状态、浏览器 worker 与现有身份集成 |
| CrewAI Flows | Python；事件路由、结构化状态、持久化与人工反馈 | 角色协作流程已有积累时可选；本期不优先引入额外角色循环 | 默认存储与部署方式；恢复语义、重复执行和反馈结果约束 |
| Dify | 可视化工作流、工具/HTTP 接入、Human Input | 可承接需求入口和人工评审；本方案的浏览器执行仍放独立服务 | 会话、取消、资源租约与程序化版本治理的集成成本 |

能力来源：[Deep Agents 概览](https://docs.langchain.com/oss/javascript/deepagents/overview)、[LangGraph 概览](https://docs.langchain.com/oss/javascript/langgraph/overview)、[Mastra Workflows](https://mastra.ai/docs/workflows/overview)、[Pydantic AI 持久执行](https://pydantic.dev/docs/ai/capabilities/durable_execution/overview/)、[Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/overview/)、[CrewAI Flows](https://docs.crewai.com/en/concepts/flows)、[Dify Workflows](https://www.dify.ai/workflows)。Deep Agents 与 LangGraph 位于不同抽象层，上表同时列出是为了比较应用构建路径。

补充说明：CrewAI 已提供持久化和人工反馈，Dify 也已有 Human Input，不能用“完全不支持状态/人工介入”的旧印象排除。微软官方将 Agent Framework 定位为 AutoGen 与 Semantic Kernel 的后继；新建项目先评估现行框架，存量项目是否迁移另算成本。LangChain 生态中的模型和工具组件可按需使用。[CrewAI Flows](https://docs.crewai.com/en/concepts/flows)、[Dify Human Input](https://dify.ai/blog/the-human-input-node-bringing-human-judgment-into-automated-workflows)、[微软框架概览](https://learn.microsoft.com/en-us/agent-framework/overview/)

### 为什么优先采用 Deep Agents 开发应用

完整平台既要执行受控流程，也要阅读需求、组织文件资产、处理长日志和分析失败。Deep Agents 预先组合了这些任务需要的通用 Agent 能力，有望减少直接使用 LangGraph 时的重复开发；具体收益仍需同任务对照。[定制能力](https://docs.langchain.com/oss/javascript/deepagents/customization)

| 平台任务 | 可复用能力 | 本项目实现要求 |
| --- | --- | --- |
| 阅读需求、规则和历史缺陷 | Skills 提供方法指引，文件或工具按需获取知识 | 读取已审核 Wiki/本体/规则快照；关键依据绑定业务域、来源和版本 |
| 长流程探索与诊断 | 历史压缩、大型工具结果转存 | 业务对象、硬断言、预算与证据引用独立保存，不能只放摘要 |
| 生成测试代码与报告 | 文件读写和可配置存储后端 | 生成资产进入候选区；经审核后才进入回归库 |
| 分析相互独立的材料 | 上下文独立的子 Agent | 先用于需求或日志分析；浏览器任务明确单一操作者 |

能力依据：[Skills](https://docs.langchain.com/oss/javascript/deepagents/skills)、[上下文管理](https://docs.langchain.com/oss/javascript/deepagents/context-engineering)、[存储后端](https://docs.langchain.com/oss/javascript/deepagents/backends)。任务清单、Skills 和人工介入按需要显式配置，核对所锁版本的默认行为；拥有任务清单不代表自动满足测试覆盖策略。

本场景的执行阶段仍遵循：验证任务 → 准备环境 → 观察 → 规划 → 策略校验 → 执行 → 独立判定 → 继续、复核或结束。Deep Agents 提供开发入口，LangGraph 的状态、路由和中断支持运行；首期使用 TypeScript 可与 Playwright/Midscene 共享语言，减少跨服务协议工作。

检查点保存单个任务的图状态，跨任务知识则应由独立存储承担。生产恢复需要数据库等持久 checkpointer；内存示例不能用于证明进程重启可恢复。LangGraph 库可独立使用，云托管、商业观测或平台产品应另行选择，不把它们默认为强制前提。[持久化机制](https://docs.langchain.com/oss/javascript/langgraph/persistence)、[LangGraph JS 仓库](https://github.com/langchain-ai/langgraphjs)

Deep Agents 的人工中断同样需要 checkpointer；虚拟文件后端与持久化配置也要明确。StateBackend、跨任务存储和本地文件系统具有不同范围，不能把文件工具的存在理解为已经解决了生产持久化。[人工介入](https://docs.langchain.com/oss/javascript/deepagents/human-in-the-loop)、[存储后端](https://docs.langchain.com/oss/javascript/deepagents/backends)

代价是额外通用能力可能增加上下文和调用成本，团队仍要实现执行器、账号数据、任务接口、权限与报告。若流程简单且固定，直接使用 LangGraph 或普通程序流程更容易控制。团队对 Mastra 更熟悉且它更快通过同一验收时，也可选择 Mastra。[Mastra 暂停恢复](https://mastra.ai/docs/workflows/suspend-and-resume)

### Deep Agents 与 Midscene 的协作边界

Deep Agents 按业务阶段拆解任务，Midscene 优先执行单步或范围明确的短流程；总动作、模型调用、墙钟时间与费用在平台统一计数，避免两层规划循环相互放大。已有确定性回归直接进入 Playwright/CI 路径。

同一浏览器 page 或 context 保持明确操作者。需求分析和日志分析可并行；并行浏览器任务必须有独立会话、账号或数据租约，不能让多个子 Agent 同时改变同一页面状态。

业务 Skills 与长期记忆的更新先进入候选变更，不能让运行中的 Agent 自动改写验收规则以取得通过。页面和日志中的内容作为待分析数据；工具层校验目标、授权与输入，关键结论由独立断言产出。

### 知识库、自定义 Skill 与工具的接入

知识库采用 LLM Wiki + 轻量领域本体 + 独立断言，具体分层见第 17 节。维护任务产生候选变更，发布服务依据评审记录发布不可变快照；执行任务只读固定 knowledge_release_id。Wiki 负责说明与关联，正式业务规则保留唯一维护位置，Skill 描述查询、测试和引用方法。

第 18 节定义测试人员从模板创建 Skill、调试、评审、发布和回滚的流程，以及 SDK/函数、HTTP、MCP、受控脚本四类接入。框架中的 tools 与 Skills 是接入点；注册目录、发布清单、凭证、权限、隔离调试和业务判定由平台实现。所有框架使用同一工具契约，具体知识查询与 Skill 注册接口均为拟建能力。

平台策略约束全部可用工具，包括框架预置的文件写入和执行工具，避免绕过受控入口。实际权限取任务、操作者、项目、Skill 依赖和工具限制的交集；知识、Skill、工具和断言版本固定在运行清单中。MCP 连接/会话恢复与浏览器归属需在适配层验证，不能仅因采用该协议便假定具备持久会话。[Deep Agents 定制](https://docs.langchain.com/oss/javascript/deepagents/customization)、[LangChain MCP](https://docs.langchain.com/oss/javascript/langchain/mcp)

### 平台最小设计与恢复语义

首期按职责划分模块，不必让每个职责都变成一个独立聊天 Agent。一个规划模型配合策略节点、执行适配器和独立判定器，已经能实现探索闭环。确定性回归可以走不调用模型的独立路径。

建议状态记录：run_id、tenant_id、case_id、应用/模型/提示词版本、knowledge_release_id、Skill/工具/断言版本与哈希、当前节点、已确认业务对象 ID、步骤与预算计数、执行租约引用、最近证据、审批记录引用、终态与失败原因。截图和 trace 放受控对象存储；不要把活的 Playwright page、浏览器进程句柄、密码或完整会话凭证塞进图状态。

建议工具契约：任务和动作 ID、受限目标、输入 schema、调用期限、幂等键、结果状态、业务对象引用、证据引用。所有候选框架使用同一契约，模型厂商与编排框架可以分别替换。

**检查点恢复不等于浏览器恢复，更不等于业务副作用仅发生一次。**LangGraph 中断恢复会从对应节点开头重新执行，中断前的代码可能再次运行。[中断与恢复规则](https://docs.langchain.com/oss/javascript/langgraph/interrupts)

以“提交审批后 worker 崩溃”为例：恢复时先校验身份、租约与环境版本；查询该业务对象是否已经审批，并用审计事件或幂等键确认本次动作；已完成则补记证据并继续，未完成且可安全重试才执行；无法判断时进入人工复核或不确定终态，不能直接再点一次。浏览器已丢失时重建上下文并验证当前页面与对象，不按旧截图坐标盲目回放。

人工介入仅出现在企业策略要求或任务确有歧义的节点；已获任务预授权的普通测试操作直接执行。审批引用应绑定任务、租户、动作目标、计划版本和有效期；恢复接口重新验证操作者与审批状态，避免旧批准被用于新对象。取消必须同步停止执行、回收浏览器和账号租约、触发清理；在最终报告中区分任务取消与产品失败。

### 已确定语言与历史备选路径

| 现有条件 | 推荐组合 | 调整理由 |
| --- | --- | --- |
| 本项目：Web 入口与核心 TS 已确认 | Deep Agents TS（基于 LangGraph）+ Node 执行模块 + Playwright/Midscene | 复用通用 Agent 能力并减少跨语言边界 |
| Python 平台和模型工程积累明显 | Deep Agents Python + Node 执行服务 | 复用团队积累；仅传工具契约和证据引用，不传浏览器对象 |
| 流程固定且需要精细控制 | 直接使用 LangGraph + 同一执行适配器 | 对照验证省去通用 Agent 能力后的成本与维护收益 |
| TS 团队已有 Mastra 经验 | Mastra + 同一执行适配器 | 让维护经验和相同验收结果影响最终决定 |
| .NET / 微软平台是企业主栈 | Microsoft Agent Framework + Node 执行服务 | 优先复用现有身份、部署和维护能力；核对具体语言支持 |
| 需求仅为少量固定回归与一次性生成 | CI + Playwright/Midscene + 普通程序流程 | 先交付测试资产，暂不增加复杂编排平台 |

持久执行引擎属于另一个选择层。Pydantic AI 当前官方列出 Temporal、DBOS、Prefect、Restate 等集成；若采用这些组合，需要把引擎服务、故障恢复和运维成本一并核算。没有跨长时段任务和分布式执行需求时，不为“架构完整”同时引入多套状态系统。[Pydantic AI 持久执行](https://pydantic.dev/docs/ai/capabilities/durable_execution/overview/)

依赖许可按固定版本和实际使用组件记录。LangGraph JS 仓库标为 MIT；Mastra 当前核心以 Apache-2.0 发布，但 ee 目录有单独企业许可，不能笼统说所有功能均可免费用于生产。框架、云服务、模型和报告托管分别核算费用与部署边界。[LangGraph JS](https://github.com/langchain-ai/langgraphjs)、[Mastra 仓库许可说明](https://github.com/mastra-ai/mastra#licensing)

### 实施验证与触发式框架对照

MVP 将结构化输出、权限、预算、取消、幂等与证据验证纳入 M09/M16/M21/M26，先交付一个真实可用闭环。持久检查点安全恢复在 v0.4 的 O01 交付；MVP 对浏览器进程丢失明确终止、保存证据并核对未知副作用，不承诺原现场恢复。

仅当 Deep Agents 的恢复、接口或开销不能满足验收时，再用同一工具契约实现“Deep Agents TS + 执行器”和“直接 LangGraph TS + 同一执行器”两个薄原型。固定模型、输入、任务、工具、预算和业务判定标准，对比总开发维护工时、误判、恢复行为、时延和调用费用；同时记录直接 LangGraph 版本尚未实现的能力，避免把功能缺失误算为性能优势。Mastra 在首轮结果不满足需求或团队已有积累时再验证。

该可选框架对照建议预算约 3 个开发人日；触发后单独排期，复用浏览器和数据适配器，环境接入时间单列。该预算只覆盖有限原型，不代表完成全部平台功能和生产验收。

| 验证阶段 | 需要证明的行为 | 交付证据 |
| --- | --- | --- |
| 第 1 个开发人日 | 同一任务能完成准备、执行、业务判定和报告；输出校验有效 | 两个原型的变更、依赖锁定、相同任务结果 |
| 第 2 个开发人日 | 中断后恢复、写入后崩溃、模型超时、用户取消均按预期处理 | 故障注入日志；无重复业务写入；清理记录 |
| 第 3 个开发人日 | 重复恢复请求、权限/租户隔离、费用限制、版本不匹配能被拦截 | 重复请求与越权反例；预算统计；问题与修复工时 |

为 Deep Agents 增加三项代表性检查：长日志导致上下文压缩后仍保留正确业务对象与验收条件；子 Agent 只取得分配给它的工具和任务范围；委派与 Midscene 调用全部纳入总预算。重复提交、错误对象写入和断言被改写均不得发生。

知识与 Skill/工具扩展另按第 17、18 节验收：锁定版本、工具 schema 漂移、缺失依赖、跨项目知识、Skill 误启用及发布回滚。按开发清单交付：MVP 提供知识快照、文本 Skill 与 SDK/HTTP；v0.2 扩展知识编辑和 MCP。其工作不计入上述可选三人日对照预算。

权限、幂等、取消和证据底线有一项无法满足，则实现不能进入用户试用；需要选型对照时再使用以下权重。通过后按建议权重比较：恢复与控制 30%、团队开发维护成本 25%、Playwright/Midscene 集成 20%、模型与部署适配 15%、观测和资产导出 10%。权重可在评审时修改，评分必须附运行证据或工时记录；本报告不预填虚构分数。

最后形成一页决策记录：选定框架和确切版本、选择原因、保留的替换接口、未解决问题、实测成本、复评触发条件。触发条件包括团队语言变化、恢复缺陷、依赖升级破坏兼容、费用超预算及新增终端需求。当前落地路线固定为 TypeScript + Deep Agents，只有验收证据表明存在不可接受障碍时，才启动有记录的替换决策。
