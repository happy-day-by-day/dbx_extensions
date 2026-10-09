## 数据库文档插件 0.4.4

本次更新增强字段检索和命中识别：

- 左侧普通搜索默认匹配表名、表注释、字段名和字段注释，显示匹配字段摘要及数量。
- 点击字段匹配结果后展示全部字段，只高亮对应名称和注释；右侧手动筛选独立使用。
- 高亮使用醒目的暖黄色 / 琥珀色实色背景，适配浅色和深色主题。
- 优化中文输入期间的查询、失败重试、截断提示和旧请求失效处理；跨 Schema 同名表分别匹配。

### 安装

下载 `com.sazs.dbdoc-0.4.4-universal.dbxp`，在 DBX 插件中心安装。此包未签名，需开启「允许安装未签名开发包」。要求 DBX Host API `^1.4`。升级后关闭并重新打开数据库文档工作台。

### 验证

- Svelte / TypeScript：0 错误、0 警告。
- Vitest：20 个文件、180 个测试通过。
- 构建、打包及包内校验和验证通过。
- 已验证本地模拟宿主、浅色 / 深色主题和窄窗口；尚未在真实 DBX 安装验收。
- SHA-256：`e043eaf9b1ae220026da849d1291250707859cc789d19a445ed68532cdc973ad`。

详细功能与限制见 [插件 README](https://github.com/happy-day-by-day/dbx_extensions/blob/v0.4.4/dbx-dbdoc/README.md)，配色效果见 [验收记录](https://github.com/happy-day-by-day/dbx_extensions/blob/v0.4.4/dbx-dbdoc/docs/verification-0.4.4.md)。
