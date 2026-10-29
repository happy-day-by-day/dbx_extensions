# 0.4.6 数据库文档标签标题验收

工作台标签按「库名-数据库文档」命名，切换数据库时更新；切换表不改变标题。尚未选库时使用已知连接名称，无有效连接名称时显示「数据库文档」。表查询工作台不受影响。

## 宿主接口

通过 DBX 官方 `setTitle` 更新当前工作台标签，并在初始化后检查 `capabilities.workbenchTitle`。已有的 `host.workbench` 权限满足接口要求。宿主缺少该能力、方法或调用失败时保留宿主默认标签，文档照常使用；串行处理标题更新，避免旧更新晚到覆盖新库名。[DBX 0.6.58 插件接口](https://github.com/t8y2/dbx/blob/v0.6.58/docs/content/docs/plugin-development.cn.mdx)列出了接口和能力位。

## 验证

- Svelte / TypeScript 检查通过，0 错误、0 警告；Vitest 共 22 个文件、200 个用例通过。
- 模拟宿主浏览器验证了初次打开、切换表、不同文档实例、宿主上下文切库、选择器切库、无能力及调用失败，以及延迟初始化的表查询页。
- 构建和 universal 候选包生成成功；5 个包内文件校验和、artifact metadata 及构建文件一致性通过。
- 候选包未签名，尚未在真实 DBX 安装验收。

候选包 SHA-256：`93cfbed3f31d7fbf9e58d106bbaa4f3d41463c9244dac5050b05baaa2e20b524`。
