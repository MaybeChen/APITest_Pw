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

在“环境配置”中添加站点 origin 和 UI AuthProfile；所有导航及 API URL 必须属于显式允许的环境。新建录制选择对应环境；生成后将 Plan 的 `authProfileRef` 设为对应协议。密码只使用 `secretRef`，在启动后端的环境变量中提供值。不要在 JSON 中填入密码或 Token。

AuthProfile 支持 navigate/click/fill/waitForURL/waitForSelector/assertVisible，`readySelector` 为必填。人工 MFA 可在可见浏览器中完成，受默认 Playwright 超时限制。localStorage Token 必须显式配置 `tokenSources` 和 `AUTH_CONTEXT` Header；例如 Token source 可指定 `prefix: "Bearer "`。不执行浏览器 Axios 拦截器或任意生成代码。

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

默认 MockAIProvider。真实 OpenAI 兼容接口通过 `AI_ENDPOINT`（完整 chat completions HTTPS URL）、`AI_MODEL` 和 `AI_API_KEY` 配置；敏感值仅在服务端环境中提供。Provider 限制两次生成尝试，设置请求超时并用正式 Zod Schema 校验两个产物；模型输出仍为草稿。回归执行不会调用模型。

API 文档：后端 `/docs`。请求示例见 [API 使用说明](docs/api.md)。设计、安全边界和当前限制见 [架构说明](docs/architecture.md)。

这是单用户本地开发平台，API 绑定 loopback。尚未提供多用户认证、远程浏览器桌面、安全凭证保险库或生产部署方案；不要直接将后端暴露至公网。

工作区支持删除：点击工作区旁的“删除”并确认。工作区入口会移除，但已有用例、计划、草稿、录制和报告仍保留在数据库中，可从“全部工作区”查看。有正在进行的录制时需先停止录制。

新增自己的测试环境：在“环境配置”点击“新增环境”，填写自定义名称、基础地址和可选的额外允许地址，按需开启写操作及内部测试证书选项，再点击“保存新环境”。名称不受 demo/my-test 限制；同名新增会提示冲突，原配置保持不变。保存后可直接在录制页选择。
