# API

API 本地端口 3000，前端通过 Vite 同源代理使用 `/api`。交互文档 `/docs`。

| 接口                                                  | 用途                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| GET /health                                           | 服务存活                                                                    |
| GET, POST /api/workspaces                             | 工作区列表/创建 `{name}`                                                    |
| GET /api/cases, /api/plans, /api/assets, /api/reports | 不可变历史记录列表                                                          |
| GET, POST /api/environments                           | 允许的目标环境配置                                                          |
| GET, POST /api/auth-profiles                          | UI 登录动作与 Header 策略配置                                               |
| GET, POST /api/recordings                             | 会话列表/开始录制                                                           |
| GET /api/recordings/:id                               | 当前会话与事实证据                                                          |
| POST /api/recordings/:id/stop                         | 停止并持久化                                                                |
| POST /api/recordings/:id/analyze                      | 过滤与分析，返回 recording、assets                                          |
| POST /api/generate                                    | 从 `{recording, assets, environmentRef}` 生成双产物                         |
| GET, POST /api/drafts                                 | 草稿历史和追加保存修订                                                      |
| POST /api/demo                                        | 返回明确的本地演示契约草稿                                                  |
| POST /api/validate                                    | 校验 `{testCase, plan, assets}`，返回 errors                                |
| POST /api/approve                                     | `{testCase,plan,assets,confirmed:true}`，要求各语义预期、断言及资产均已确认 |
| POST /api/run                                         | 执行持久化且已批准的 `{planId, version}`，返回报告                          |

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
