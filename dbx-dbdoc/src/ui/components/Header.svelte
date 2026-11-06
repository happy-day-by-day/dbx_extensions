<script lang="ts">
  import Icon from './Icon.svelte'
  let { connectionName, database, dbType, tableCount, columnCount, truncated, busy, degraded, offline, offlineInfo = null, syncStatus = null, onrefresh, onexport, onchangeresource }:
    { connectionName: string; database: string; dbType: string; tableCount: number; columnCount: number; truncated: boolean;
      busy: boolean; degraded: boolean; offline: boolean;
      offlineInfo?: { savedAt: number; lastSyncedAt?: number; detailAt: number; cachedCount: number; refreshError: string } | null;
      syncStatus?: { label: string; description: string; busy: boolean; failed: boolean; retryDisabled: boolean; onretry: () => void } | null; onrefresh: () => void; onexport: () => void; onchangeresource: () => void } = $props()
  function dismissOfflineInfo(node: HTMLDetailsElement) {
    const onPointer = (event: PointerEvent) => { if (!node.contains(event.target as Node)) node.open = false }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && node.open) { node.open = false; node.querySelector('summary')?.focus() }
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return { destroy() { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey) } }
  }
</script>

<header class="workspace-header">
  <div class="workspace-topbar">
    <div class="product-brand"><span class="brand-symbol"><Icon name="database" size={17} /></span><span>数据库文档</span></div>
    <span class="topbar-divider"></span>
    <button class="resource-switcher" aria-label="切换连接与数据库" title="切换连接与数据库" onclick={onchangeresource}>
      <span class="resource-switcher-name"><strong title={database || connectionName}>{database || connectionName}</strong>{#if connectionName && connectionName !== database}<small title={connectionName}>{connectionName}</small>{/if}</span>
      <span class="engine-tag">{dbType.toUpperCase()}</span><Icon name="down" size={15} />
    </button>
    <div class="workspace-actions">
      {#if offline && offlineInfo}<details class="offline-status" use:dismissOfflineInfo>
        <summary aria-label="本地缓存说明" title="点击查看最后同步时间并刷新本地缓存">本地缓存<Icon name="down" size={12} /></summary>
        <div class="offline-info">
          <strong>本地缓存</strong><p>当前显示本地缓存，内容可能已变更。已缓存 {offlineInfo.cachedCount} / {tableCount} 张表。</p>
          <p>最后同步时间：{offlineInfo.lastSyncedAt ? new Date(offlineInfo.lastSyncedAt).toLocaleString() : '尚无整库同步成功记录'}{#if offlineInfo.detailAt}<br />当前表更新时间：{new Date(offlineInfo.detailAt).toLocaleString()}{/if}</p>
          {#if !offlineInfo.savedAt}<p>尚无本地缓存，点击「刷新」创建文档。</p>{/if}
          <p>点击「刷新」重新读取数据库并更新全部表的缓存。如连接尚未打开，请先在 DBX 中连接「{connectionName}」并打开「{database || '目标数据库'}」。</p>
          {#if offlineInfo.refreshError}<p class="offline-error" role="status">刷新失败：{offlineInfo.refreshError}</p>{/if}
          <button class="btn" disabled={busy} onclick={onrefresh}><Icon name="refresh" size={14} />{busy ? '刷新中…' : '刷新本地缓存'}</button>
        </div>
      </details>{/if}
      {#if syncStatus}<span class="sync-status" class:sync-failed={syncStatus.failed} role="status" title={syncStatus.description} aria-label={syncStatus.description}>
        {#if syncStatus.busy}<span class="spinner"></span>{:else if !syncStatus.failed}<Icon name="check" size={13} />{/if}<span>{syncStatus.label}</span>
        {#if syncStatus.failed && !syncStatus.busy}<button class="icon-btn" aria-label="重试离线同步" title="重试离线同步" disabled={syncStatus.retryDisabled} onclick={syncStatus.onretry}><Icon name="refresh" size={13} /></button>{/if}
      </span>{/if}
      <span class="workspace-stats"><span><b>{tableCount.toLocaleString()}</b> 张表</span><span><b>{columnCount.toLocaleString()}</b> 个字段</span></span>
      <button class="btn refresh-button" aria-label="刷新文档" title="重新读取数据库并更新本地缓存" onclick={onrefresh} disabled={busy || degraded}><span class:rotating={busy}><Icon name="refresh" size={16} /></span><span>{busy ? '刷新中' : '刷新'}</span></button>
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
  .offline-status { position: relative; font-size: 11px; }
  .offline-status summary { display: flex; align-items: center; gap: 4px; padding: 3px 6px; border-radius: 5px; color: var(--accent); background: var(--accent-weak); cursor: pointer; list-style: none; white-space: nowrap; }
  .offline-status summary::-webkit-details-marker { display: none; }
  .offline-status summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .offline-info { position: absolute; right: 0; top: calc(100% + 12px); z-index: 50; width: min(340px, calc(100vw - 32px)); box-sizing: border-box; padding: 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: var(--text); box-shadow: 0 8px 28px #0002; font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
  .offline-info p { margin: 8px 0; color: var(--muted); }
  .offline-info p.offline-error { color: var(--danger); }
  .workspace-actions .offline-info .btn { width: auto; }
  .sync-status { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); font-size: 11px; white-space: nowrap; }
  .sync-status .spinner { width: 11px; height: 11px; }
  .sync-status.sync-failed { color: var(--danger); }
  .sync-status .icon-btn { width: 22px; height: 22px; padding: 3px; color: inherit; }
  .rotating { animation: spin 1s linear infinite; display: inline-flex; }@keyframes spin { to { transform: rotate(360deg); } }
  @media(max-width:1100px) { .workspace-stats { display: none; }.resource-switcher-name small { display: none; }.resource-switcher { flex: 1; max-width: 420px; } }
  @media(max-width:760px) { .offline-info { position: fixed; top: 54px; right: 12px; }.workspace-topbar { padding: 7px 12px; gap: 9px; }.product-brand > span:last-child, .topbar-divider, .resource-switcher .engine-tag { display: none; }.resource-switcher { max-width: none; gap: 6px; }.workspace-actions { margin-left: 0; gap: 4px; }.refresh-button > span:last-child, .export-button > span { display: none; }.workspace-actions .btn { width: 30px; padding: 5px; } }
</style>
