## 数据库文档插件 0.4.5

双击表目录中的表，即可打开独立的「表查询」标签，默认填入对应表的 `SELECT * FROM ...;`。

- 单击仍查看表文档；目录获得焦点后按 Enter 也可打开查询。
- SQL 使用实际 Schema 和表名，按 MySQL、PostgreSQL、SQL Server 方言转义标识符，支持跨 Schema 同名表。
- 每个查询标签独立保留 SQL 草稿。打开时不执行 SQL，点击「执行查询」或按 Ctrl / ⌘ Enter 后执行只读查询，最多显示 200 行。
- 支持复制 SQL、滚动结果表、空结果和截断提示；会话关闭、未授权或宿主接口不可用时显示操作指引。
- 保留字段与注释搜索、高亮及独立筛选行为，适配浅色、深色和窄窗口。

### 安装

下载 `com.sazs.dbdoc-0.4.5-universal.dbxp`，在 DBX 插件中心安装。此包未签名，需开启「允许安装未签名开发包」。要求 DBX Host API `^1.4`，新增 `host.workbench` 权限用于打开查询标签。升级后关闭并重新打开数据库文档工作台；若提示宿主不支持打开查询，请升级 DBX。

查询使用插件提供的独立页面。当前官方插件接口未提供打开原生 SQL 编辑器的入口。

### 验证

- Svelte / TypeScript：0 错误、0 警告。
- Vitest：21 个文件、195 个测试通过。
- 构建、打包及 5 个包内校验和验证通过，安装包与当前源码及构建一致。
- 已通过本地模拟宿主浏览器验收；尚未在真实 DBX 安装验收。
- SHA-256：`3dea870dd1c181561c66bcfc35d84bc54a1a6131af4df01c038abf80a165c098`。

详细使用说明见 [插件 README](https://github.com/happy-day-by-day/dbx_extensions/blob/v0.4.5/dbx-dbdoc/README.md)，交互与界面验证见 [验收记录](https://github.com/happy-day-by-day/dbx_extensions/blob/v0.4.5/dbx-dbdoc/docs/verification-0.4.5.md)。
