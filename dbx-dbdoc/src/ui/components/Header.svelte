<script lang="ts">
  import Icon from './Icon.svelte'
  let { connectionName, database, dbType, tableCount, columnCount, truncated, busy, degraded, onrefresh, onexport, onchangeresource }:
    { connectionName: string; database: string; dbType: string; tableCount: number; columnCount: number; truncated: boolean;
      busy: boolean; degraded: boolean; onrefresh: () => void; onexport: () => void; onchangeresource: () => void } = $props()
</script>

<header class="workspace-header">
  <div class="workspace-topbar">
    <div class="product-brand"><span class="brand-symbol"><Icon name="database" size={17} /></span><span>数据库文档</span></div>
    <span class="topbar-divider"></span>
    <button class="resource-switcher" aria-label="切换连接与数据库" title="切换连接与数据库" onclick={onchangeresource}>
      <span class="resource-switcher-name"><strong title={database || connectionName}>{database || connectionName}</strong>{#if connectionName && connectionName !== database}<small title={connectionName}>{connectionName}</small>{/if}</span>
      <span class="engine-tag">{dbType.toUpperCase()}</span><Icon name="down" size={15} />
    </button>
    <div class="workspace-actions"><span class="workspace-stats"><span><b>{tableCount.toLocaleString()}</b> 张表</span><span><b>{columnCount.toLocaleString()}</b> 个字段</span></span>
      <button class="btn refresh-button" aria-label="刷新文档" title="重新读取目录和当前表" onclick={onrefresh} disabled={busy || degraded}><span class:rotating={busy}><Icon name="refresh" size={16} /></span><span>{busy ? '刷新中' : '刷新'}</span></button>
      <button class="btn btn-primary export-button" aria-label="导出文档" title="导出文档" onclick={onexport} disabled={busy || degraded || !tableCount}><Icon name="export" size={16} /><span>导出文档</span></button>
    </div>
  </div>
  {#if truncated}<div class="workspace-truncation" role="status">表清单达到宿主查询上限，文档与整库导出只包含已加载的表。</div>{/if}
</header>

<style>
  .workspace-header { flex: none; background: var(--panel); border-bottom: 1px solid var(--border); }
  .workspace-topbar { display: flex; align-items: center; gap: 14px; padding: 7px 16px; min-height: 48px; }
  .product-brand { gap: 7px; font-size: 12px; }.product-brand .brand-symbol { width: 26px; height: 26px; border-radius: 7px; }
  .topbar-divider { height: 20px; width: 1px; background: var(--border); flex: none; }
  .resource-switcher { display: flex; align-items: center; gap: 9px; min-width: 0; max-width: 520px; border: 1px solid transparent; border-radius: 7px; padding: 4px 6px; margin: -4px -6px; background: transparent; color: var(--text); cursor: pointer; text-align: left; font: inherit; }
  .resource-switcher:hover { background: var(--bg); border-color: var(--border); }.resource-switcher-name { min-width: 0; display: flex; align-items: baseline; gap: 10px; }.resource-switcher-name strong { font: 600 12px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }.resource-switcher-name small { font-size: 10px; color: var(--muted); max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 2; }.resource-switcher > :global(svg) { color: var(--muted); }
  .engine-tag { font: 10px var(--mono); color: var(--muted); background: var(--bg); border: 1px solid var(--border); border-radius: 5px; padding: 2px 6px; }
  .workspace-actions { margin-left: auto; display: flex; align-items: center; gap: 7px; flex: none; }.workspace-actions .btn { min-height: 30px; padding: 4px 9px; font-size: 11px; gap: 6px; }.workspace-stats { display: flex; gap: 12px; color: var(--muted); font-size: 10px; margin-right: 6px; white-space: nowrap; }.workspace-stats b { color: var(--text); font-weight: 600; }.workspace-truncation { padding: 6px 16px; border-top: 1px solid var(--border); font-size: 11px; color: var(--muted); background: var(--accent-weak); }
  .rotating { animation: spin 1s linear infinite; display: inline-flex; }@keyframes spin { to { transform: rotate(360deg); } }
  @media(max-width:1100px) { .workspace-stats { display: none; }.resource-switcher-name small { display: none; }.resource-switcher { flex: 1; max-width: 420px; } }
  @media(max-width:760px) { .workspace-topbar { padding: 7px 12px; gap: 9px; }.product-brand > span:last-child, .topbar-divider, .resource-switcher .engine-tag { display: none; }.resource-switcher { max-width: none; gap: 6px; }.workspace-actions { margin-left: 0; gap: 4px; }.refresh-button > span:last-child, .export-button > span { display: none; }.workspace-actions .btn { width: 30px; padding: 5px; } }
</style>
