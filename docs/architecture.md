# 架构与实施边界

## 数据流

React 审查界面 → Fastify API → 独立的 recorder / planner / runner → Drizzle + SQLite。

- contracts：Recording、API Asset、Semantic Case、Execution Plan 与报告契约。
- core：脱敏、JSON 路径、绑定、DAG 排序和 Plan Validator。
- recorder：Playwright 浏览器事件、DOM 证据、网络采集、规则分类和候选依赖。
- planner：Mock / OpenAI 兼容 Provider，双产物 Schema 校验和有限输出重试。
- runner：声明式 UI 认证、关联 APIRequestContext、依赖调度、安全只读并发、断言、资源台账与 always cleanup。
- storage：Drizzle SQLite 文档表，使用 kind 区分领域对象、复合 ID 隔离版本；批准通过数据库事务写入。
- apps：React 审核 UI、Fastify API 和独立订单演示应用。

目录保留需求中的模块边界；首版每包集中一个入口，以减少尚不需要的空目录。各包具有独立 workspace manifest，共享根工具链和相对 TS 导入；尚未做面向 npm 发布的包构建。

## 正式执行约束

执行前验证明确的 Case/Plan 版本、semanticStepRef、已登记已确认的 API 资产版本、路径参数、变量来源、Header 策略、断言和无环依赖图。所有依赖默认串行；没有实现并行分支。协议 Header 由客户端管理，未知 Header 需要人工改为明确来源。高风险和写操作分别受环境策略控制。

响应变量必须来自依赖祖先，禁止任意 JS、eval 或 Function。JSON 路径仅支持字段和数字索引，屏蔽原型访问。API 请求不自动跟随重定向；浏览器路由拦截限制 origin。运行隔离，写操作重试次数必须为零；只读 401 可在显式配置并且剩余重试额度内重新 UI 认证，其他 401 标记 AUTH_ERROR，停止后续业务步骤。不会自动让 AI 修复或重新规划失败步骤。

删除请求必须使用当次 FixtureManager 登记的响应 ID，不能删除录制时的固定 ID。SETUP 登记资源早于断言检查，因此创建成功但断言失败仍尝试清理。CLEANUP 在业务失败后仍执行，并单独记录错误和残留资源。若创建成功但服务端没有返回可提取 ID，无法自动推断归属；该步骤和清理会明确失败。

## 证据和隐私

按用户要求，网络录制仅采集 HTTP/HTTPS 的 Fetch/XHR 请求，不保存 document、图片、脚本、样式、字体等资源；页面导航仍作为 DOM 操作事件保留。登录接口属于 Fetch/XHR 时仍记录脱敏证据，分析阶段归类为认证请求，不进入业务执行步骤。不宣称获取 JS initiator stack。DOM 事件采用被动观察，不阻止事件传播；采集标签、ARIA 属性、有限文本和状态，不采集输入值，也不为每个请求保存整页 DOM。操作前后状态暂以状态变化事件呈现，不提供 DOM 快照 diff。

网络采集最多 5000 请求和 10000 操作，单体 256 KiB，单会话响应体预算 2 MiB。只读取带正数 Content-Length 且在限额内的 JSON/text，文本内容为隐私默认省略；无长度、二进制和超限响应不采集正文。正文读取限时 3 秒。Playwright body API 不提供流式截断，这些限制不能作为针对恶意远端的完整内存隔离。Runner 在读取前检查响应 Content-Length，拒绝不明确的非空响应，正文最大 1 MiB；生产使用还应设置进程级资源限制。

凭证类字段、Header、查询参数在录制采集时脱敏，报告及模型输入再次脱敏；认证策略引用可保留，真实凭证不存入普通数据库。非 JSON 请求体和非 JSON 响应文本默认省略。字段规则不能证明所有业务 PII 已被识别；接入真实业务前应扩充领域脱敏规则。原始可追溯证据指脱敏后的不可变事实，没有保存明文凭证或原始浏览器 storageState。

时间窗关联只记录候选，置信度 0.4；响应 ID 值匹配只记录候选，置信度 0.6。API 数字/UUID 段归一化为 `{id}`，接口 schema 是观测推断，不是已确认契约。规则分类与 Mock 不声称理解场景；真实 Provider 才接收场景和脱敏证据进行建议。未知请求不会从列表静默消失。

## 版本与审查

已批准的 Case、Plan、Asset 均为不可变记录。Case 和 Plan 分别编号；Plan 必须引用明确 Case 版本与 Asset 版本（省略 apiVersion 兼容首版 v1）。可以为一个 Case 预先声明多个计划版本。同一 Case 版本的内容不能改变；改语义预期应新建 Case 版本，再通过重新确认的机器断言批准关联计划。审核界面支持可读双视图和 JSON 编辑，校验报告显示未解决的问题；暂未提供自动语义等价判定，最终业务一致性依赖人工确认。

草稿通过“保存草稿”显式持久化，每次保存形成独立修订；工作区可恢复最新草稿。已批准内容可通过“创建新版本”形成新的 Case/Plan 草稿，旧版本保留。工作区支持创建、用例归属、列表筛选和删除入口；删除使用持久化删除标记，隐藏工作区但保留所有历史领域记录，不修改已批准版本。运行中的录制所属工作区不允许删除。此工作区功能不是多租户权限隔离。Recording 的停止记录与历史报告也持久化。修改任一产物的步骤后，会将关联预期和断言重新标记为待审核。

## 当前未完成能力

这是贯通主链路的 v0.1，不能称作需求全文的生产级完整实现。尚未实现：云端远程可见浏览器、完整 workspace 隔离、带版本的草稿自动保存、细粒度字段表单编辑、自动推导完整类型约束与业务依赖、真实模型服务的联网验收、自定义签名算法插件、运行中实时事件推送、独立 AI Recovery、生产级身份权限和审计。

运行中使用最新的环境与 AuthProfile 配置；报告记录精确的 Case/Plan 版本、语义步骤与环境配置快照，以及 AuthProfile 引用；尚未快照 AuthProfile 的配置版本。环境配置的放行与云平台网络 allowlist 为两层独立策略，配置本应用不改变云端 egress 权限。

数据库位置以 storage 模块所在项目的根目录为基准，而非 process.cwd()；用户可显式配置 TRACEPILOT_DATA_DIR。环境/认证配置以最大版本号读取，每 ID 对外展示最新值；前端刷新会自动恢复已保存配置，可切换选择所有环境，编辑未保存内容不会因后台刷新被覆盖。环境选择偏好仅存浏览器 localStorage，配置本体存服务端 SQLite。

allowedOrigins 支持精确 origin 字符串和 hostnameRegex 对象规则，任一匹配即可。正则通过 RE2JS 编译校验，避免回溯式匹配；只针对解析后的 hostname，不匹配整条 URL，默认协议 HTTPS。可选 port 限制端口。规则缓存最多 100 项，历史字符串配置保持兼容。

## 分阶段生成、页面证据与执行 DAG

新版任务（pipelineVersion=2）使用 API_ORGANIZATION → API_SELECTION → 人工确认接口 → CASE_DESIGN → 人工确认用例 → PLAN_DESIGN → VALIDATION；有阻塞错误时可进入 PLAN_REPAIR → FINAL_VALIDATION。接口整理按数量及输入预算分批，超大目录的场景筛选也分批。旧版任务仍使用 EVIDENCE → BUSINESS_FLOW → SEMANTIC_CASE → EXECUTION_PLAN。每个阶段保存独立状态、输出和尝试次数。恢复任务复用成功产物，不重复全部模型调用。模型调用日志携带 stage 和 generationId。修复不改变环境权限，所有产物均为待审核草稿；无法修复的错误保留在校验结果中。

录制在 click/change/submit 前、及操作后约 200ms 保存页面语义摘要：标题、可见标题、附近表单/区域、最多 24 个控件的标签与状态。最多 1000 份摘要、合计 2MiB；不采集输入值，不保存完整 DOM 或截图。请求与摘要通过操作候选关联，仍是 1.5 秒窗口、置信度 0.4 的待确认关联，不能证明因果。参数候选使用前序响应的嵌套 ID 字段与后续路径段、Query、嵌套 Body 的精确值匹配，禁止子串匹配；业务依赖仍需人工确认。

Plan 支持 `execution.maxConcurrency`（1–8，默认 1）、节点 `parallelSafe` 与 `resourceLocks`。仅明确标记且资产为 READ 的 GET/HEAD API 节点可并行；SETUP、写操作、清理保持串行。共享锁互斥，汇合节点等待全部依赖完成；失败依赖的下游不执行。读操作需要 UI 重新认证时强制串行。无论业务调度是否失败，仍进入串行清理阶段。

RESPONSE_VARIABLE 可声明 `fromStep`、`expectedType`，生产节点通过 `extract` 和 `extractTypes` 给出路径与类型。`bodyBindings` 支持嵌套 JSON 路径，禁止原型属性；运行时检查提取和绑定类型。校验器检查来源节点、上游依赖、声明类型及语义依赖。界面显示 DAG、参数绑定和页面证据，细节可在 JSON 编辑中修改。

浏览器录制脚本独立存放于 `packages/recorder/src/browser-recorder.js`，通过 Playwright `addInitScript({path})` 加载，不序列化经 tsx 转换的 TypeScript 回调，避免 `__name` 等 Node 侧编译辅助函数在页面中缺失。脚本覆盖同一 BrowserContext 内的页面、iframe 和弹窗；`contextCapture.initializedFrames` 记录页面/框架脚本就绪次数（包含刷新），`rejectedEvents` 记录未通过数据校验的事件数。录制界面展示操作、页面摘要数量与就绪次数，空操作时提示检查。刷新/关闭中的绑定失效不会产生未处理 Promise 错误。

## 四阶段模型输入边界

接口资产由采集事实构建，模型只填写名称、描述和不确定项，不能改写 Header/入参/出参事实。每批接口只包含最多 3 种代表请求形态、最多 2 份候选 DOM 摘要以及对应操作；样例按数组、字符串、深度和字段数限制压缩，原始录制仍完整保留。采集样例不是正式契约。每批必须原样、唯一地返回该批所有接口 ID。

API_SELECTION 仅发送场景和接口 ID、名称、描述、method/path、操作类型。CASE_DESIGN 仅发送用户选择的接口摘要、场景和身份信息，不发送全部 DOM/响应。PLAN_DESIGN 仅发送已确认用例、所选接口结构/压缩样例、相关候选依赖和有采集来源的数据参数目录。身份、版本、环境、认证引用和草稿状态由程序固定。调用计划另接收已配置认证协议的可用上下文名称和 Header 绑定，不读取凭证值；引用未提供的认证上下文会产生阻塞错误。

WAITING_INTERFACE_REVIEW / WAITING_CASE_REVIEW 为持久化状态。确认接口必须为当前目录中的非空唯一集合；取消候选参数依赖的来源接口时需明确确认。确认用例必须校验身份、版本、工作区和依赖 DAG；UI/人工前置条件不强制生成 API 节点，但其中的 API 上游依赖仍需落实。确认请求检查 revision，并拒绝活动任务的并发修改。resume 不会绕过确认点。

数据参数值从原始脱敏录制中提取，不采用压缩样例作为真实执行值；敏感或被省略的数据不能成为候选值。计划以 TEST_DATA 引用参数，独立候选 Dataset 绑定精确计划版本，审批后可保存并编辑多组数据。JSON/HTTP 预期仍需人工审核。局部修复只可替换指定范围内的既有执行节点，不改变用户确认的 Case、参数声明或环境权限；修复失败保留草稿与真实校验错误。

输入预算使用序列化提示的 UTF-8 字节数加余量做保守 token 估算，覆盖系统 Schema；超出预算直接拒绝请求。该估算不是服务实际 usage，不自动探测模型上下文容量。输出显式设置 max_tokens 并检测 finish_reason=length，截断结果不会被当作合法产物。批次与阶段分别保存成功输出，恢复时只继续未完成批次。复用目录创建新场景时另建任务和 Case 身份，复用完成的整理结果，保留原任务。

自定义 Header 的默认值来自录制事实，不按字段名推断 UUID、nonce、timestamp 或认证上下文。新分析保存安全采集值；新版计划编译时将这些值放入独立数据集并自动补齐 TEST_DATA 绑定。已由用户认证协议配置的 Header 由认证层提供，明确的上游 RESPONSE_VARIABLE 绑定仍需通过依赖校验；其他模型猜测被采集默认值替换。已脱敏的认证值不能恢复原文，保持待审核而不编造来源。秒/毫秒 epoch timestamp 字段不按银行卡号规则脱敏。
