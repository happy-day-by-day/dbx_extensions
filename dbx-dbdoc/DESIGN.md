---
version: alpha
name: DBX 数据库文档
description: 面向开发者的紧凑数据库元数据工作台，沿用 DBX 宿主主题。
colors:
  primary: "#3572f0"
  background: "#ffffff"
  muted: "#f5f7fa"
  foreground: "#24292f"
  secondary: "#5b6570"
  border: "#e3e7ec"
  danger: "#d5454f"
  searchHighlightBackground: "#ffe08a"
  searchHighlightForeground: "#3d2900"
typography:
  sans:
    fontFamily: "system-ui, -apple-system, Segoe UI, PingFang SC, Microsoft YaHei, sans-serif"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, Courier New, monospace"
omitted:
  - section: spacing
    reason: 各现有组件拥有紧凑布局尺寸，本轮不建立新尺寸 token。
  - section: rounded
    reason: 保留现有控件和表格的组件圆角，不增加第二套 token。
components:
  search:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
  table:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
  highlight:
    backgroundColor: "{colors.searchHighlightBackground}"
    textColor: "{colors.searchHighlightForeground}"
---

# DBX 数据库文档设计约定

## Overview

产品面向在 DBX 中核对表、字段和业务注释的开发者，以数据库工具的紧凑双栏工作台为视觉依据。中文界面与等宽数据库标识符并存。用户已要求减少顶部和基础信息占用，因此检索改进应复用原布局，不增加常驻说明卡或大型标题。

运行时 token 的权威来源是 `src/ui/styles.css`，此文件记录已有默认值与意图，不生成或替换 CSS。DBX 宿主 tokens 优先，明暗主题角色保持一致。无日本市场或日语界面的产品要求。

## Colors

`colors.primary` 对应 `--accent` 的浅色默认值；background、muted、foreground、secondary、border、danger 分别对应 `--panel`、`--bg`、`--text`、`--muted`、`--border`、`--danger`。深色默认值由同一文件的主题规则提供。

搜索命中使用全局 `mark` 和独立的 `--search-highlight-bg` / `--search-highlight-text`：浅色采用实色暖黄 #ffe08a 与深棕 #3d2900，深色采用琥珀 #f2bd4d 与深棕 #241800。searchHighlightBackground / searchHighlightForeground 对应浅色默认值。该语义配色不随宿主主色透明混合，避免灰色主题弱化命中；不增加内边距或字重，保持原文字布局。命中信息同时以文本和「字段匹配」标记表达，不只依靠颜色。全局滚动条也由此文件统一管理。

## Typography

正文和中文控件采用宿主 `--font-sans` 或现有系统字体回退；数据库标识符采用宿主 `--font-mono` 或现有等宽回退。目录名称 12px、注释摘要 11–12px、辅助元信息 10px，保持既有密度。长值省略，但点击结果后的字段页提供完整内容。

## Layout

顶栏约 49px；默认目录宽度 304px，可拖动调整。目录行固定 72px，命中字段摘要复用注释行，匹配数量复用辅助信息行。大目录只渲染视口附近的行。760px 以下采用上下布局，可收起目录；搜索控件和反馈随已有容器换行。

## Elevation & Depth

以表格边框、浅色背景和选中行表达层次。浮层沿用 `--shadow-md`，搜索结果本身不增加阴影。加载、错误和结果反馈在目录原有区域展示。

## Shapes

沿用现有 `.input`、`.icon-btn`、`.chip` 和 `.catalog-row` 的圆角与边框，不为搜索建立独立造型。图标复用 `Icon.svelte`。

## Components

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Table Selection | Catalog.svelte / AppState.navigateTable | README 浏览和检索 | 单表选择、字段匹配后高亮 | 目录单元测试与浏览器键盘验收 |
| Select/Listbox | Catalog.svelte 既有原生 select | 本文件的 Components | Schema 与排序 | 浏览器打开菜单、键盘选择 |
| Scrollbar | src/ui/styles.css | 运行时主题变量 | 原生标准属性与 WebKit 回退 | 静态审计与窄窗口滚动 |

目录搜索的 canonical owner 是 `Catalog.svelte`，纯过滤由 `display/catalog.ts` 负责，命中片段由 `display/highlight.ts` 负责。远程字段匹配通过方言的只读元数据 SQL 返回名称和注释；普通搜索默认包括字段，正则只匹配已加载的表信息。

Schema 与排序使用既有原生 select；平台负责选项菜单几何和键盘操作。详情本地字段搜索复用相同高亮与清空按钮。检索词不写入 URL 或宿主存储，仅搜索偏好和目录宽度持久化：DBX 内嵌工作台没有可分享路由，关键词可能含内部业务名称。

## Do's and Don'ts

- 显示实际命中的字段或注释摘要，长注释优先呈现命中附近的文本。
- 点击字段匹配表后打开字段页并展示全部字段，仅高亮匹配名称和注释；目录关键词不填入右侧筛选。右侧手动搜索独立控制字段筛选和高亮，清空后恢复目录关键词高亮。
- 中文输入组合期间不派发远程查询；忽略已过期的结果，清空后立即恢复列表并归还输入焦点。
- 正在搜索或查询失败时不宣称「没有匹配的表」。表信息本地命中可先显示，远程失败有明确重试入口。
- 保留宿主只读权限边界，不读取业务表数据，不改变会话授权行为。
