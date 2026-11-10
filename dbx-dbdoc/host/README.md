# DBX 持久化目录授权扩展

> 此目录保留 0.4.27 的可选宿主扩展方案。**当前 0.4.28 单包不依赖此补丁**，
> 使用现有 Host API 1.4 和包内后端实现快照存储，直接安装通用 `.dbxp` 即可。

宿主源码已在 `/Users/sazs/code/github/dbx` 实现，分支
`codex/persistent-directory-access`。基线为官方 `t8y2/dbx` 的
`28a60d061b1b063d192da9935c08e06b81ce8be5`，实际技术栈为 Tauri 2 + Rust，
界面为 Vue 3 / TypeScript。当前 macOS 构建没有 App Sandbox entitlement；
Windows 为普通桌面进程。Web 端不会宣称支持持久目录授权。

`dbx-directory-access.patch` 包含宿主完整源码改动，可在对应基线应用：

```sh
git apply --check /path/to/dbx-dbdoc/host/dbx-directory-access.patch
git apply /path/to/dbx-dbdoc/host/dbx-directory-access.patch
pnpm install --frozen-lockfile
NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck
cargo test -p dbx-directory-access
cargo test -p dbx-plugin-runtime plugins::manifest::tests
cargo check -p dbx --no-default-features
pnpm vitest run apps/desktop/src/lib/plugins/pluginDirectory.spec.ts apps/desktop/src/lib/plugins/pluginHostBridge.spec.ts apps/desktop/src/lib/plugins/pluginHostBridgeSdkTransfer.spec.ts apps/desktop/src/components/plugins/__tests__/PluginContributionsPanelBatch.spec.ts
```

主改动：

- `crates/dbx-directory-access`：不依赖数据库或插件业务的目录授权与能力文件系统核心。
- `src-tauri/src/commands/plugin_directory.rs`：原生选择器、安装身份与权限校验、宿主授权存储、后台读写线程。
- `pluginHostBridge.ts` / `PluginWorkbenchHost.vue`：插件身份绑定、权限门禁、能力位、沙箱 SDK、工作台句柄清理。
- 插件中心目录授权面板：查看并撤销授权，保留用户文件。
- Host API 升至 1.5，新增 `host.directory:read`、`host.directory:write`，保持旧接口兼容。
- `plugins/persistent-directory-access.md`：完整 API、所有权、恢复状态、错误码和原子写入约定。

目录授权记录存放在宿主应用数据目录的 `directory-grants/grants.json`，
不占插件 UI 存储。插件只得到授权 ID 与展示信息；调用使用相对路径。
通过通用 `setPreferred` 接口记录当前选用目录，插件复制快照完成后才调用；
UI 偏好丢失、存储已满或目录切换中断均不会丢失原选择。
重启后校验目录身份，不会因相同路径被新目录占用而扩大授权。读写失败、
冲突、撤销或校验失败不会把半个文件提交成快照。

常规桌面构建通过宿主授权记录、目录稳定身份和 OS 文件权限恢复访问。
未来若提供 App Sandbox、AppContainer、Flatpak 等沙箱发行，需要先加入相应
书签 / token / portal 持久凭据适配，不能把本方案中的路径定位器当成沙箱凭据。
当前 Web 端能力位为 false。原子替换以支持此语义的本地文件系统为验收范围。

宿主尚未发布或替换本机应用。插件 0.4.27 要求 Host API `^1.5`，
必须先使用集成此补丁的 DBX；不能只升级插件就让旧宿主具备新接口。
