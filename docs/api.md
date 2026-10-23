# API

API 本地端口 3000，前端通过 Vite 同源代理使用 `/api`。交互文档 `/docs`。

| 接口                                                  | 用途                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| GET /health                                           | 服务存活                                                                       |
| GET, POST /api/workspaces                             | 工作区列表/创建 `{name}`                                                       |
| GET /api/cases, /api/plans, /api/assets, /api/reports | 不可变历史记录列表                                                             |
| DELETE /api/workspaces/:id                            | 删除工作区入口，保留历史数据；重复删除返回 204，不存在返回 404，录制中返回 409 |
| GET, POST /api/environments                           | 允许的目标环境配置                                                             |
| GET, POST /api/auth-profiles                          | UI 登录动作与 Header 策略配置                                                  |
| GET, POST /api/recordings                             | 会话列表/开始录制                                                              |
| GET /api/recordings/:id                               | 当前会话与事实证据                                                             |
| POST /api/recordings/:id/stop                         | 停止并持久化                                                                   |
| POST /api/recordings/:id/analyze                      | 过滤与分析，返回 recording、assets                                             |
| POST /api/generate                                    | 从 `{recording, assets, environmentRef}` 生成双产物                            |
| GET, POST /api/drafts                                 | 草稿历史和追加保存修订                                                         |
| POST /api/demo                                        | 返回明确的本地演示契约草稿                                                     |
| POST /api/validate                                    | 校验 `{testCase, plan, assets}`，返回 errors                                   |
| POST /api/approve                                     | `{testCase,plan,assets,confirmed:true}`，要求各语义预期、断言及资产均已确认    |
| POST /api/run                                         | 执行持久化且已批准的 `{planId, version}`，返回报告                             |

开始录制：

```json
{
  "caseName": "删除订单",
  "scenario": "创建新订单后删除并验证不存在",
  "target": "http://127.0.0.1:3100",
  "environmentRef": "demo"
}
```

过滤规则：`domains`、`pathPattern`（子串）、`methods`、`resourceTypes`、`categories`、`overrides`（请求 ID 到布尔值）；认证请求不能手动提升为业务步骤。

新环境配置示例（仅在确实允许访问时添加）：

```json
{
  "id": "staging",
  "baseURL": "https://staging.example.com",
  "allowedOrigins": ["https://staging.example.com"],
  "allowWrites": false,
  "allowHighRisk": false
}
```

登录示例：

```json
{
  "id": "staging-auth",
  "actions": [
    { "type": "navigate", "target": "/login" },
    { "type": "fill", "target": "#username", "value": "test-user" },
    { "type": "fill", "target": "#password", "secretRef": "STAGING_PASSWORD" },
    { "type": "click", "target": "button[type=submit]" }
  ],
  "readySelector": "[data-testid=home]",
  "headers": {},
  "tokenSources": {},
  "reauthenticateReads": false
}
```

`STATIC` 只应用于非敏感值。其他 Binding：`ENVIRONMENT_VARIABLE`、`RESPONSE_VARIABLE`、`RUNTIME_GENERATED`、`AUTH_CONTEXT`、`CLIENT_MANAGED`，或尚未解决的 `MANUAL_REVIEW`。所有凭证只配置引用，不放入请求示例、数据库普通字段或模型输入。

## 内部测试环境的 HTTPS 证书

`ignoreHTTPSErrors` 默认 `false`，旧环境配置未填写此字段时仍校验证书。对于你确认可信且使用自签名/内部 CA 证书的测试环境，可在“环境配置 → 编辑环境”保存以下配置，然后重新开始录制：

```json
{
  "id": "my-test",
  "baseURL": "https://7.238.3.92:38443",
  "allowedOrigins": ["https://7.238.3.92:38443"],
  "allowWrites": true,
  "allowHighRisk": false,
  "ignoreHTTPSErrors": true
}
```

仅选择此环境的录制 BrowserContext 和回放 BrowserContext（包括关联的 APIRequestContext）忽略证书错误；其他环境仍保持默认校验。该开关作用于该环境的整个浏览器上下文，因此应限制 `allowedOrigins`；不会移除目标 origin 校验，也不会改变 AI Provider、依赖安装或全局 Node TLS 设置。修改后需重新创建录制会话。将字段恢复为 `false` 可重新启用校验。

环境及 UI AuthProfile 的 GET 列表对每个 ID 只返回最新已保存版本，历史修订仍保留在 SQLite 中。默认数据库路径固定为项目根目录 `.data/platform.db`，可通过 `TRACEPILOT_DATA_DIR` 指定其他持久化目录。

## 手动新增环境

打开“环境配置 → 新增环境”，填写自定义的环境名称 / 标识和站点基础地址即可创建，不限于 `demo` 或 `my-test`。额外允许访问的地址用于登录跳转或独立 API 域名，可换行或逗号分隔，基础地址的 origin 自动加入允许列表。写操作、高风险操作和忽略 HTTPS 证书错误默认关闭。保存后自动选择新环境，录制页下拉列表立即可用；重启后仍保留。

表单提交 `POST /api/environments` 时附带 `createOnly: true`，名称重复返回 409，不覆盖已有配置。原有“保存配置”仍可更新选中环境的 JSON。取消新增不会写入数据库。

## 域名正则放行

`allowedOrigins` 继续支持完整 origin 字符串，也支持明确的正则规则对象。例如放行 `huawei.com` 和任意层级的子域名：

```json
{
  "id": "wiseoffice-test",
  "baseURL": "https://astr-lab.gts.huawei.com",
  "allowedOrigins": [
    { "hostnameRegex": "(^|\\.)huawei\\.com$", "protocol": "https:" }
  ],
  "allowWrites": false,
  "allowHighRisk": false,
  "ignoreHTTPSErrors": false
}
```

在新增表单的“允许访问的域名正则（HTTPS）”中直接填写 `(^|\.)huawei\.com$`，无需 JSON 转义，也不要加 `/.../i` 分隔符；每行一条规则。也可在环境 JSON 编辑器中编辑规则。

- 正则只匹配 URL 解析后的 hostname（不包含协议、端口、路径或查询参数），不区分大小写。
- 上述规则允许 `huawei.com`、`astr-lab.gts.huawei.com`，拒绝 `fakehuawei.com`、`huawei.com.evil.test`，也不会因路径或查询参数中含有 huawei.com 而放行。
- `protocol` 默认 `https:`；若确需 HTTP，显式设置 `http:`。未指定 `port` 时允许该域名的所有端口；可用数值 `port: 38443` 限制端口。
- 使用 RE2 语法，支持常见分组、或、字符类及重复；不支持反向引用和前后查找。保存时校验规则，错误规则不会覆盖已有配置。
- 精确 origin 和正则规则按“任一匹配即可”合并。录制导航、登录跳转、网络路由与 API 回放使用同一个规则检查；全局 Node TLS、测试平台页面来源 allowlist 和云端网络策略不受该配置影响。

## 录制请求域名白名单

`recordingRequestDomains` 只决定哪些 Fetch/XHR 请求写入录制，不控制浏览器访问权限。省略或 `[]` 表示不做域名过滤；填写后，仅保留匹配任意一条规则的 HTTP/HTTPS Fetch/XHR。匹配时只看 hostname，不看端口、路径或查询参数，且忽略大小写。精确域名不隐含放行子域名，需要子域名时使用正则。

例如只保留指定站点的请求：

```json
"recordingRequestDomains": ["astr-lab.gts.huawei.com"]
```

也可以保留所有 huawei.com 及其子域名请求：

```json
"recordingRequestDomains": [
  {"hostnameRegex": "(^|\\.)huawei\\.com$"}
]
```

新增环境表单中提供“保留请求的域名白名单”和“保留请求的域名正则”两个输入框；已有环境可在 JSON 中加入此字段并保存。修改后重新开始录制；历史录制不会被修改。白名单之外的请求不会保存请求正文、响应正文或失败记录，但仍可正常完成，因此页面加载和登录流程不受过滤影响。请求目标仍需符合 `allowedOrigins`，白名单不能绕过环境访问规则，也不改变 API 回放行为。

## 生成时没有保留的请求

非 `/api/` 路径的 Fetch/XHR 也会默认保留为 UNKNOWN 待审核候选，不代表业务规则已确认。登录请求仍不能提升为业务步骤，用户手动排除和过滤规则继续生效。分析页显示总数、保留数与排除数，零保留时禁止生成并给出下一步。

旧录制如果有请求但全部被排除，升级后回到录制会话重新点击“分析录制”，然后检查候选并生成。若录制本身为零请求，应检查请求域名白名单是否匹配实际 API 域名，在录制期间完成业务操作再重新录制。此类输入问题在调用模型前报错，不再重复两次模型生成。

## 内部模型配置

服务端读取项目根目录 `config/ai.json`，不依赖启动目录，修改后需重启后端：

```json
{
  "provider": "openai-compatible",
  "baseURL": "https://tpsp.dev.huawei.com/llm/qwen3.6/v1",
  "model": "qwen",
  "timeoutMs": 60000,
  "responseFormat": "json_object"
}
```

实际调用地址：`https://tpsp.dev.huawei.com/llm/qwen3.6/v1/chat/completions`。没有 `apiKeyEnv` 时不要求密钥、不发送 Authorization；若其他模型需要认证，可设置 `apiKeyEnv` 为服务端环境变量名称。网关不支持 JSON response_format 参数时可将 `responseFormat` 改为 `none`，生成结果仍进行 JSON 和正式 Schema 校验。

`GET /api/ai-provider` 返回当前 provider 和 model，页面顶部显示相同信息；计划的 `model` 记录真实生成来源。已保存的 Mock 草稿不会自动变为 Qwen 结果，需要重新生成。显式设置 `{"provider":"mock"}` 可进行离线模板演示；服务失败会明确报错而不会自动回退。运行电脑必须可访问内部模型地址，HTTPS 证书仍正常校验，业务环境的 ignoreHTTPSErrors 不作用于模型调用。

## 模型连接诊断命令

`pnpm ai:check` 读取 `config/ai.json`，使用与规划器相同的传输、模型、可选密钥引用、CA、代理和超时配置，仅发送一条不含业务数据的测试消息。可通过 `--config <path>` 指定其他配置文件。成功退出 0，失败退出 1；不启动 API 服务、不创建 Case、不执行回放。Mock 模式不算真实连接成功。

原来笼统的 fetch failed 现在会显示底层代码：ENOTFOUND/EAI_AGAIN 提示 DNS/VPN；ECONNREFUSED 提示服务/代理端口；证书错误提示 CA 信任或证书本身有误；超时提示连接/响应超时。固定证书及 DNS 错误不会在规划器中无意义地重复两次。HTTP 401/403/503 仍显示真实状态，不退回 Mock。

模型配置可选 `caFile`，文件路径相对于该配置文件解析，内容是可信 CA 的 PEM 证书；它追加到 Node 默认 CA 信任，而不关闭 TLS 或主机名校验。支持标准 HTTP_PROXY/HTTPS_PROXY/NO_PROXY 环境变量。业务浏览器的 ignoreHTTPSErrors 与此独立。
