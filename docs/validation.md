# 验证记录

2026-10-22，当前云实例，Node 24、pnpm 11.25、系统 Chromium（真实进程）。

| 检查           | 结果                             |
| -------------- | -------------------------------- |
| pnpm typecheck | 通过，strict TypeScript 6        |
| pnpm lint      | 通过，ESLint + typescript-eslint |
| pnpm test      | 25 项通过，0 失败，0 跳过        |
| pnpm build     | React/Vite 生产构建通过          |
| pnpm test:e2e  | 2 项通过，0 失败，0 跳过         |

集成检查实际启动 Chromium 和订单服务，完成 DOM/网络录制、UI 登录、Cookie 共享、动态订单创建/查询/删除、404 验证、清理、失败断言后的清理、401 分类、清理失败状态；检查脱敏记录不包含演示密码。存储测试使用真实 SQLite，验证不可覆盖批准版本、版本化草稿和同一 Case 的多个 Plan。

浏览器前端检查覆盖人工审查与批准回放报告，以及保存草稿后刷新恢复和创建新版本。尚未以真实模型 API、外部业务站点或桌面可见浏览器验证。网络策略阻止 Playwright CDN 下载，使用已有 `/usr/bin/chromium` 完成验证，没有关闭 TLS 或签名校验。
