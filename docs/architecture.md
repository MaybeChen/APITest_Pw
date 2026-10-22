# 架构与实施边界

## 数据流

React 审查界面 → Fastify API → 独立的 recorder / planner / runner → Drizzle + SQLite。

- contracts：Recording、API Asset、Semantic Case、Execution Plan 与报告契约。
- core：脱敏、JSON 路径、绑定、DAG 排序和 Plan Validator。
- recorder：Playwright 浏览器事件、DOM 证据、网络采集、规则分类和候选依赖。
- planner：Mock / OpenAI 兼容 Provider，双产物 Schema 校验和有限输出重试。
- runner：声明式 UI 认证、关联 APIRequestContext、串行调度、断言、资源台账与 always cleanup。
- storage：Drizzle SQLite 文档表，使用 kind 区分领域对象、复合 ID 隔离版本；批准通过数据库事务写入。
- apps：React 审核 UI、Fastify API 和独立订单演示应用。

目录保留需求中的模块边界；首版每包集中一个入口，以减少尚不需要的空目录。各包具有独立 workspace manifest，共享根工具链和相对 TS 导入；尚未做面向 npm 发布的包构建。

## 正式执行约束

执行前验证明确的 Case/Plan 版本、semanticStepRef、已登记已确认的 API 资产版本、路径参数、变量来源、Header 策略、断言和无环依赖图。所有依赖默认串行；没有实现并行分支。协议 Header 由客户端管理，未知 Header 需要人工改为明确来源。高风险和写操作分别受环境策略控制。

响应变量必须来自依赖祖先，禁止任意 JS、eval 或 Function。JSON 路径仅支持字段和数字索引，屏蔽原型访问。API 请求不自动跟随重定向；浏览器路由拦截限制 origin。运行隔离，写操作重试次数必须为零；只读 401 可在显式配置并且剩余重试额度内重新 UI 认证，其他 401 标记 AUTH_ERROR，停止后续业务步骤。不会自动让 AI 修复或重新规划失败步骤。

删除请求必须使用当次 FixtureManager 登记的响应 ID，不能删除录制时的固定 ID。SETUP 登记资源早于断言检查，因此创建成功但断言失败仍尝试清理。CLEANUP 在业务失败后仍执行，并单独记录错误和残留资源。若创建成功但服务端没有返回可提取 ID，无法自动推断归属；该步骤和清理会明确失败。

## 证据和隐私

录制包括 document、导航、fetch/XHR 等资源，不宣称获取 JS initiator stack。DOM 事件采用被动观察，不阻止事件传播；采集标签、ARIA 属性、有限文本和状态，不采集输入值，也不为每个请求保存整页 DOM。操作前后状态暂以状态变化事件呈现，不提供 DOM 快照 diff。

网络采集最多 5000 请求和 10000 操作，单体 256 KiB，单会话响应体预算 2 MiB。只读取带正数 Content-Length 且在限额内的 JSON/text，文本内容为隐私默认省略；无长度、二进制和超限响应不采集正文。正文读取限时 3 秒。Playwright body API 不提供流式截断，这些限制不能作为针对恶意远端的完整内存隔离。Runner 在读取前检查响应 Content-Length，拒绝不明确的非空响应，正文最大 1 MiB；生产使用还应设置进程级资源限制。

凭证类字段、Header、查询参数在录制采集时脱敏，报告及模型输入再次脱敏；认证策略引用可保留，真实凭证不存入普通数据库。非 JSON 请求体和非 JSON 响应文本默认省略。字段规则不能证明所有业务 PII 已被识别；接入真实业务前应扩充领域脱敏规则。原始可追溯证据指脱敏后的不可变事实，没有保存明文凭证或原始浏览器 storageState。

时间窗关联只记录候选，置信度 0.4；响应 ID 值匹配只记录候选，置信度 0.6。API 数字/UUID 段归一化为 `{id}`，接口 schema 是观测推断，不是已确认契约。规则分类与 Mock 不声称理解场景；真实 Provider 才接收场景和脱敏证据进行建议。未知请求不会从列表静默消失。

## 版本与审查

已批准的 Case、Plan、Asset 均为不可变记录。Case 和 Plan 分别编号；Plan 必须引用明确 Case 版本与 Asset 版本（省略 apiVersion 兼容首版 v1）。可以为一个 Case 预先声明多个计划版本。同一 Case 版本的内容不能改变；改语义预期应新建 Case 版本，再通过重新确认的机器断言批准关联计划。审核界面支持可读双视图和 JSON 编辑，校验报告显示未解决的问题；暂未提供自动语义等价判定，最终业务一致性依赖人工确认。

草稿通过“保存草稿”显式持久化，每次保存形成独立修订；工作区可恢复最新草稿。已批准内容可通过“创建新版本”形成新的 Case/Plan 草稿，旧版本保留。工作区支持创建、用例归属及列表筛选，但不是多租户权限隔离。Recording 的停止记录与历史报告也持久化。修改任一产物的步骤后，会将关联预期和断言重新标记为待审核。

## 当前未完成能力

这是贯通主链路的 v0.1，不能称作需求全文的生产级完整实现。尚未实现：云端远程可见浏览器、完整 workspace 隔离、带版本的草稿自动保存、细粒度字段表单编辑、自动推导完整类型约束与业务依赖、真实模型服务的联网验收、自定义签名算法插件、安全只读并行调度、运行中实时事件推送、独立 AI Recovery、生产级身份权限和审计。

运行中使用最新的环境与 AuthProfile 配置；报告记录精确的 Case/Plan 版本、语义步骤与环境配置快照，以及 AuthProfile 引用；尚未快照 AuthProfile 的配置版本。环境配置的放行与云平台网络 allowlist 为两层独立策略，配置本应用不改变云端 egress 权限。
