# TracePilot — AI API 自动化测试平台

可运行的本地开发版本。TypeScript strict / pnpm workspace / React + Vite / Fastify / Playwright / Zod / SQLite + Drizzle。AI 提出候选计划，人工审核后由确定性 Runner 回放。Mock Provider 无需密钥，明确不具备真实模型的语义理解能力。

## 启动

需要 Node.js >=22、pnpm 11.25、Chromium。当前云环境已提供 `/usr/bin/chromium`。

```bash
export XDG_DATA_HOME=/workspace/.local # 当前云环境的可写 pnpm 数据目录
pnpm install --frozen-lockfile
pnpm dev      # API :3000，同时启动订单演示 :3100
# 另一终端
pnpm web      # 前端 :5173
```

本机打开前端，点击“载入订单演示模板”，检查语义预期与执行计划，点击“我已审查预期、断言与资产”，批准保存，再执行回放。演示模板来自明确的演示契约，不冒充模型生成结果。

演示 UI 用户名 `tester`、密码 `demo-only`（仅演示账号）；回放通过 `DEMO_PASSWORD` 环境变量引用密码，启动脚本为演示应用提供默认值。每次运行创建隔离 BrowserContext，UI 登录成功后用 `context.request` 共享 Cookie；不会自动把 localStorage Token 变成 Header。

## 录制真实操作

默认录制启动可见 Chromium。需要桌面显示环境（Linux DISPLAY）；当前云环境没有桌面，设置 `RECORDER_HEADLESS=true` 可做自动录制集成验证，但不能在云页面中直接操纵该浏览器。桌面机器启动后，在录制页输入场景，开始录制，在弹出的浏览器里正常操作，再停止并分析。

在“环境配置”中添加站点 origin 和 UI AuthProfile；所有导航及 API URL 必须属于显式允许的环境。新建录制选择对应环境；生成后将 Plan 的 `authProfileRef` 设为对应协议。前置 UI 录制会将填写和下拉选择的实际值保存为动作 `value`，回放直接使用，不需要配置 `UI_INPUT_*` 环境变量。动作 JSON 可编辑；旧动作可删除 `secretRef` 并填写 `value`，也可以继续使用 `secretRef` 引用后端环境变量。CSRF 等动态认证来源仍通过前置接口提取，不写成固定 Token。

AuthProfile 支持 navigate/click/fill/waitForURL/waitForSelector/assertVisible，`readySelector` 为必填。回放导航完成后、开始填写前会等待网络连续空闲 1 秒；点击或 Enter 提交前再次等待网络稳定并检查仍可见的已填写字段。字段被页面重置时停止执行，错误不包含输入值。就绪元素可见后，等待同一浏览器上下文中所有页面的 HTTP 请求结束，并连续 1 秒无新请求，再提取认证信息和执行 API；网络等待最多 30 秒，超时停止并报错。持续轮询或流式请求可能导致网络等待超时。人工 MFA 可在可见浏览器中完成，受默认 Playwright 超时限制。localStorage Token 必须显式配置 `tokenSources` 和 `AUTH_CONTEXT` Header；例如 Token source 可指定 `prefix: "Bearer "`。不执行浏览器 Axios 拦截器或任意生成代码。

调试前置 UI 回放时，先停止已有后端，再运行 `pnpm dev:headed`（等价于 `pnpm dev --headed`，也兼容 `--head`），然后在界面执行数据集。后端会启动可见 Chromium，UI 操作默认放慢 500 毫秒；浏览器窗口显示在运行后端的机器上，需要可用桌面 / DISPLAY。`RUN_HEADLESS=false` 仍可单独启用有头回放，`RUN_SLOW_MO_MS` 可调整操作延迟（0–5000 毫秒）。普通 `pnpm dev` 保持默认无头执行。API 使用同一 BrowserContext 的 `context.request` 共享 Cookie，API 调用不是页面点击，其请求和响应在运行报告中查看。

排查 API 认证时可运行 `pnpm dev:headed --raw-headers`，也可设置 `RUN_LOG_RAW_HEADERS=true`。每次 API 请求会在后端终端输出 `[API_REQUEST_HEADERS]`，附运行 ID、步骤 ID、尝试次数，以及实际发送的明文 Header（含 Cookie、CSRF 和 Playwright 自动添加的 Header）。日志读取 HTTP 发送时已序列化的请求头，不改变 Cookie 注入或请求内容；该模式生成的运行报告也会保留并展示实际明文请求 Header 和 rawHeaders，保存、重新打开后仍可查看。该模式还会在每次发送前采集 Cookie 快照，在请求详情 `cookieDiagnostics` 和终端 `[API_COOKIE_DIAGNOSTICS]` 中显示：`allCookies`（全部）、`matchedCookies`（匹配目标 URL）、`unmatchedCookies`（不匹配目标 URL）、`sentCookies`（实际发送）、`missingMatchedCookies`（匹配但未发送）、`additionalSentCookies`（发送内容中额外或值不同的项）。保留 Domain、Path、Secure、有效期及同名 Cookie，`explicitCookieHeader` 标记是否显式配置 Cookie Header；`wireCaptured=false` 表示尚未捕获发送头，不能据此判断缺失。诊断按尝试次数保存，Cookie 读取与发送之间仍可能有并发更新。普通运行默认关闭明文模式；旧报告中已脱敏的值不能恢复，需要重新执行。

需要执行结束后继续检查当前浏览器和 Cookie 时，运行 `pnpm dev:headed --raw-headers --keep-browser`（或设置 `RUN_KEEP_BROWSER_OPEN=true`）。成功、失败及认证错误后均保留本次浏览器和上下文，报告正常返回；多组数据各自保留独立窗口。手动关闭窗口或停止后端即可释放调试会话。保留窗口不会延长服务端会话有效期；普通模式执行完成仍自动关闭浏览器。

## 校验与测试

```bash
pnpm typecheck
pnpm lint
pnpm test          # 单元 + 集成，包含真实 Chromium
pnpm test:e2e     # 启动 API、演示站点、前端，验证页面审批回放流程
pnpm build
```

如系统 Chromium 路径不同，设置 `CHROMIUM_PATH`。无系统浏览器时执行 `pnpm exec playwright install chromium` 并将其下载路径赋给 `CHROMIUM_PATH`；下载需允许 Playwright 官方 CDN。当前环境无需下载。`.npmrc` 使用云环境可写的 `/workspace/.local` 缓存目录，在其他机器可按需调整这些缓存设置。

## 数据与模型

数据固定保存在项目根目录的 `.data/platform.db`（SQLite），不再随后端启动目录变化，默认不进入 Git。环境与 UI AuthProfile 在点击“保存配置”后持久化，重启后从“已保存配置”选择；同一配置只展示最新版本。浏览器会记住上次选择的环境。后端启动日志会显示实际数据库位置。可用 `TRACEPILOT_DATA_DIR` 指定独立数据目录（建议绝对路径）；Windows PowerShell 示例：`$env:TRACEPILOT_DATA_DIR="D:\TracePilotData"`。备份时请先停止后端，再备份完整 `.data` 目录；不要删除该目录。Recording、API Asset、Semantic Case、Execution Plan 分别存储。批准的 Case/Plan/资产版本不可覆盖；修改需增加版本并重新审核。同一 Case 版本可预先声明多个 `planVersions`，再逐个批准对应计划。每个运行报告记录精确的 Case 和 Plan 版本。原始录制不可变，重新分析不会覆盖证据。

默认读取项目根目录 `config/ai.json`，调用内部 Qwen 模型。当前 baseURL 为 `https://tpsp.dev.huawei.com/llm/qwen3.6/v1`，model 为 `qwen`，无需 API Key，也不发送 Authorization。自动追加 `/chat/completions`。修改配置文件后重启后端；页面顶部显示实际 Provider 和模型，执行计划记录生成来源。需要离线固定模板时，显式将配置改为 `{"provider":"mock"}`；真实服务失败不会静默退回 Mock。可选 `apiKeyEnv` 指定密钥所在的环境变量名，不要在配置中写入密钥值。地址和模型以 `config/ai.json` 为准，不需要设置 `AI_ENDPOINT`、`AI_MODEL` 或 `AI_API_KEY`。新版生成拆为分批整理接口、场景筛选、语义用例、调用计划四步。调用计划采用“模型生成调用意图、本地编译执行计划”：默认沿用录制请求，仅对场景差异生成待审核数据；认证配置不完整时先等待补充，不让模型猜测 Header 或清理能力。接口筛选和语义用例各有一次人工确认，确认前不会继续调用后续模型；每个模型批次或阶段最多尝试两次。旧版任务仍可恢复。阶段结果自动保存，页面刷新或后端重启后可从未完成阶段继续；模型输出仍为待审核草稿。回归执行不会调用模型。

API 文档：后端 `/docs`。请求示例见 [API 使用说明](docs/api.md)。设计、安全边界和当前限制见 [架构说明](docs/architecture.md)。

这是单用户本地开发平台，API 绑定 loopback。尚未提供多用户认证、远程浏览器桌面、安全凭证保险库或生产部署方案；不要直接将后端暴露至公网。

工作区支持删除：点击工作区旁的“删除”并确认。工作区入口会移除，但已有用例、计划、草稿、录制和报告仍保留在数据库中，可从“全部工作区”查看。有正在进行的录制时需先停止录制。

新增自己的测试环境：在“环境配置”点击“新增环境”，填写自定义名称、基础地址和可选的额外允许地址，按需开启写操作及内部测试证书选项，再点击“保存新环境”。名称不受 demo/my-test 限制；同名新增会提示冲突，原配置保持不变。保存后可直接在录制页选择。

如只想保存特定域名的接口请求，可在环境中设置 `recordingRequestDomains`，或使用新增环境表单中的“录制请求白名单”。精确域名示例：`["astr-lab.gts.huawei.com"]`；省略或空数组表示不按域名过滤。它只过滤保存的证据，不阻止页面请求；详细正则示例见 docs/api.md。

## 单独检查模型连接

无需启动前端或后端，也不需要录制数据，在项目目录执行：

```bash
pnpm ai:check
# 可选：指定另一个配置文件
pnpm ai:check --config config/ai.json
```

命令读取模型配置，向真实 `/chat/completions` 发送一次最小测试请求；成功打印模型、地址、耗时和响应字符数，退出码 0；失败显示底层原因并返回 1；摘要不输出密钥或录制内容。开启调试日志时会额外记录最小测试消息及脱敏后的响应。在 Windows PowerShell 中可用 `$LASTEXITCODE` 查看结果。成功只证明聊天接口可返回有效响应，完整计划生成需另行验证。Mock 配置会明确提示无法测试真实模型。

如果报内部 CA 不受信任，可以在 `config/ai.json` 增加 `"caFile": "certs/huawei-ca.pem"`，将可信的内部 CA PEM 放到 `config/certs/huawei-ca.pem`。相对路径以配置文件目录为基准，也支持绝对路径。仅为模型客户端追加 CA，保留系统信任和域名校验；修改后重新执行命令，或重启后端以应用到规划器。客户端使用 HTTP_PROXY、HTTPS_PROXY、NO_PROXY（也支持小写）环境代理配置，不需要修改业务环境 allowedOrigins。

内部模型跳过证书校验：在 `config/ai.json` 设置 `"ignoreHTTPSErrors": true`。当前按用户要求对内部 Qwen 服务开启；此选项只影响该模型的专用客户端，包含 `pnpm ai:check` 与规划调用，不修改全局 TLS 或代理自身的证书信任。开启后不需要 `caFile`；关闭或省略此选项时恢复正常证书校验。模型请求不自动跟随重定向。

## 模型调用日志

当前 `config/ai.json` 已开启 logging：后端终端会打印 `[ai]` 输入/输出日志，同时写入项目 `.data/logs/model.jsonl`。包含脱敏输入、响应、耗时、调用 ID、重试序号和 JSON/Schema 校验错误；不记录认证头。默认每条数据最多 64000 字符并标记截断，日志文件达到 10 MiB 后轮转。设置 `logging.enabled=false` 关闭，或 `logging.console=false` 仅保留文件。修改后重启后端；也适用于 `pnpm ai:check` 的最小测试消息。配置详见 docs/api.md。

执行计划支持显式 DAG 依赖、`bodyBindings` 嵌套参数传递及变量类型检查。默认串行；配置 `execution.maxConcurrency` 并明确标记 `parallelSafe` 后，独立 GET/HEAD 只读节点可并发，`resourceLocks` 控制互斥。执行计划页显示依赖图和参数绑定表，字段可通过 JSON 编辑。录制保存操作前后受限的页面语义摘要，在请求详情中查看候选上下文。

生成工作流界面展示中文阶段、当前进度、阶段及总耗时、尝试次数、可展开产物与校验错误；服务重启后的中断任务可继续执行。用例编辑页的“测试数据集”支持从草稿提取业务参数，将数据与调用步骤分开保存。一份已批准计划可选择多组数据逐组回放，每组独立认证、清理并生成报告；测试数据变化无需重新生成或批准计划。参数绑定和 API 示例见 [API 使用说明](docs/api.md#同一调用流程执行多组测试数据)。

界面现以单条录制记录串联“录制操作 → 分析筛选 → 生成草稿 → 审核与执行”，在同一页面通过步骤条推进。历史记录按录制归并分析、生成及用例产物，支持重新打开继续；工作区、环境和认证统一在“配置”管理。分析快照独立保存，历史恢复沿用录制的环境，生成阶段与校验结果只展示当前记录的内容。

新版流程中，接口整理只接收该接口的代表性请求/响应样例、自定义 Header 和候选 DOM 摘要；场景筛选只接收场景及接口摘要，列表保留全部接口供勾选。选定接口后，语义用例和调用计划两个阶段都接收这些接口的全部已采集调用（含同一接口的每次重复调用）、完整已保存的请求与响应、实际跨接口调用顺序和候选依赖，不再使用整理阶段的裁剪样例；未选接口不传入。敏感认证值仍脱敏，录制未采到的正文会标记缺失，不推断为空。用户可修改前置条件、输入步骤、预期和步骤类型，确认后生成显式 DAG、参数绑定与独立候选数据集。录制中的 ID 不会直接成为可删除资源的所有权凭证。已完成的接口目录可复用于其他场景，保留原任务及历史产物。

`config/ai.json` 的 `planningLimits` 控制 `inputBudget`（默认 128000）、`maxOutputTokens`（默认 8192）和 `maxInterfacesPerBatch`（默认 6）。输入预算按 UTF-8 字节做保守 token 上界估算，并计入系统指令及输出 Schema；它不是模型实际用量，也不自动探测服务的上下文窗口，请按服务能力调整。超过预算会拒绝发送，不会裁剪所选接口的调用证据或截断已确认用例。调整 `planningLimits.inputBudget` 后重启后端，已完成接口整理与筛选的历史任务在继续生成或重新生成计划时会采用当前预算；整理、筛选中的批次仍保留原检查点预算。该值是本地估算阈值，不是模型声明的上下文窗口。日志 `maxChars` 仍只控制日志长度。
