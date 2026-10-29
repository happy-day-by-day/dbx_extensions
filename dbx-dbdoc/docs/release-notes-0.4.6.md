## 数据库文档插件 0.4.6

工作台标签显示「库名-数据库文档」，切换数据库后同步更新，切换表时保持不变。尚未选库时使用连接名称或默认标题；不支持标题接口的旧版宿主保留默认标签。

安装 `com.sazs.dbdoc-0.4.6-universal.dbxp` 后，关闭并重新打开数据库文档工作台。候选包未签名，需在 DBX 插件中心允许安装未签名开发包。

Svelte / TypeScript 检查和 200 项测试通过；已完成模拟宿主浏览器验收，尚未在真实 DBX 安装验收。安装包 SHA-256：`93cfbed3f31d7fbf9e58d106bbaa4f3d41463c9244dac5050b05baaa2e20b524`。接口与验证范围见 [验收记录](https://github.com/happy-day-by-day/dbx_extensions/blob/v0.4.6/dbx-dbdoc/docs/verification-0.4.6.md)。
