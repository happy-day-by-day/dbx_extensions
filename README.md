# DBX Extensions

这个仓库用于开发 [DBX](https://dbxio.com/) 插件。目前包含一个插件：**数据库文档**（`dbx-dbdoc`）。它在 DBX 工作台中提供数据字典浏览、表结构查看和文档导出功能。

## 当前插件

| 目录 | 用途 | 技术栈 |
| --- | --- | --- |
| [`dbx-dbdoc/`](dbx-dbdoc/) | 浏览数据库、表、字段、索引和约束；生成参考建表 SQL；导出 Markdown 文档 | Svelte 5、TypeScript、Vite |

数据库文档插件支持 MySQL / MariaDB、PostgreSQL 和 SQL Server 的完整目录与文档。其他数据库可在宿主提供表上下文时查看基础字段信息。插件通过 DBX 已打开的会话执行只读元数据查询，不负责建立数据库连接。

在 DBX 中，可从连接右键菜单选择「查看数据库文档」，或从表右键菜单选择「查看表文档」。首次访问连接时，需要在 DBX 中完成数据访问授权。具体功能、兼容范围和使用限制见 [插件 README](dbx-dbdoc/README.md)。

## 本地开发

在插件目录中安装依赖并运行检查：

```bash
cd dbx-dbdoc
npm ci
npm run check
npm test
npm run build
```

`npm run build` 将插件界面构建到 `dbx-dbdoc/ui/`。如已安装 DBX 插件 CLI，可继续在该目录运行 `dbx-plugin package .` 生成 `.dbxp` 安装包；开发时也可运行 `npm run preview` 启动模拟宿主。安装步骤和模拟场景见 [插件开发与验收说明](dbx-dbdoc/README.md#开发和验收)。

## 仓库结构

```text
dbx_extensions/
├── README.md                 # 仓库入口
└── dbx-dbdoc/
    ├── manifest.json         # 插件身份、权限和入口
    ├── dbx-plugin.toml       # 打包与开发配置
    ├── src/lib/              # DBX 桥接、元数据读取与文档生成
    ├── src/ui/               # Svelte 工作台界面
    ├── repro/                # 本地模拟宿主
    ├── docs/                 # 验收记录与截图
    └── README.md             # 完整功能和使用说明
```

`dbx-dbdoc/ui/` 和 `dbx-dbdoc/dist/` 是构建及打包产物，不作为源码维护。
