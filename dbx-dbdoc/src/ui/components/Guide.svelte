<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import type { RecentConnection } from '../../lib/recent'
  import { cleanConnectionName } from '../../lib/connectionLabels'
  import { groupConnections, documentResources, loadLocalDocumentList, summarizeDocumentCache, type DocumentCacheSummary, type DocumentResource, type ResourceConnection } from '../../lib/resources'
  import { getAdapter, normalizeDbType } from '../../lib/dialects/registry'
  import { maskUuids } from '../../lib/display/masking'
  import { getBridge } from '../../lib/bridge'
  import type { PluginContext } from '../../lib/types'
  import { modalFocus } from '../modalFocus'
  import Icon from './Icon.svelte'
  import SnapshotDirectoryButton from './SnapshotDirectoryButton.svelte'
  import BatchRefreshDialog from './BatchRefreshDialog.svelte'
  import ClearCacheDialog from './ClearCacheDialog.svelte'
  import type { BatchTarget } from '../../lib/batchRefresh'

  let { onsnapshot, snapshotChanged = 0, context = {}, diagnostics = null, onopen, onclose, oncacheupdated, oncachecleared, syncBlocked = false, returnLabel = '返回文档' }:
    { onsnapshot?: () => void; snapshotChanged?: number; context?: PluginContext; diagnostics?: string | null;
      onopen: (context: PluginContext) => void; onclose?: () => void; oncacheupdated?: (target: BatchTarget) => void; oncachecleared?: (context: PluginContext) => void; syncBlocked?: boolean; returnLabel?: string } = $props()

  let batchOpen = $state(false)
  let clearTarget = $state<DocumentResource | null>(null)
  let searchInput = $state<HTMLInputElement>()
  const clearContext = $derived<PluginContext>(clearTarget ? {
    connectionId: clearTarget.connection.connectionId, database: clearTarget.database,
    dbType: normalizeDbType(clearTarget.connection.dbType), name: clearTarget.connection.name
  } : {})
  let recent = $state<RecentConnection[]>([])
  let loading = $state(true)
  let databaseQuery = $state('')
  let cachedOnly = $state(false)
  type SortField = 'database' | 'connection' | 'lastSyncedAt'
  type SortOrder = 'default' | `${SortField}-${'asc' | 'desc'}`
  let sortOrder = $state<SortOrder>('default')
  const nameOrder = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
  const sortField = $derived(sortOrder.split('-')[0])
  const sortDirection = $derived(sortOrder.endsWith('-desc') ? -1 : 1)
  let cacheEntries = $state(new Map<string, DocumentCacheSummary>())
  let databaseLoading = $state(false)
  let databaseError = $state('')
  let openFailed = $state(false)
  let failureConnectionId = $state('')
  let failureDatabase = $state<string | undefined>()
  let openingDatabase = $state<string | null>(null)
  let request = 0
  const connections = $derived(groupConnections(recent, context))
  const selected = $derived(connections.find((connection) => connection.connectionId === context.connectionId) ?? connections[0])
  const selectedLabel = $derived(selected ? connectionNameOf(selected) : '')
  const resolvedType = $derived(selected?.dbType ?? '')
  const useCurrent = $derived(selected && !getAdapter(selected.dbType)?.listDatabases && !selected.databases.length)
  const documents = $derived(documentResources(connections))
  const visibleDatabases = $derived(documents.filter((document) => [document.database, connectionNameOf(document.connection)]
    .some((value) => value.toLocaleLowerCase().includes(databaseQuery.trim().toLocaleLowerCase())))
    .filter((document) => !cachedOnly || (cacheEntries.has(document.key) && cacheEntries.get(document.key)!.state !== 'missing'))
    .sort(compareDocuments))
  const cachedCount = $derived(documents.filter((document) => cacheEntries.has(document.key) && cacheEntries.get(document.key)!.state !== 'missing').length)

  function connectionNameOf(connection: ResourceConnection) {
    return cleanConnectionName(connection.name, connection.connectionId) || `未命名连接 ${connections.indexOf(connection) + 1}`
  }
  function compareDocuments(a: DocumentResource, b: DocumentResource) {
    if (sortField === 'default') return 0
    if (sortField === 'lastSyncedAt') {
      const left = cacheEntries.get(a.key)?.lastSyncedAt ?? null
      const right = cacheEntries.get(b.key)?.lastSyncedAt ?? null
      // Unknown successful-sync times always follow known times in either direction.
      if (left === null) return right === null ? 0 : 1
      if (right === null) return -1
      return (left - right) * sortDirection
    }
    return nameOrder.compare(sortField === 'database' ? a.database : connectionNameOf(a.connection),
      sortField === 'database' ? b.database : connectionNameOf(b.connection)) * sortDirection
  }
  function nextSort(field: SortField): SortOrder {
    const descending = sortField === field ? sortDirection === 1 : field === 'lastSyncedAt'
    return `${field}-${descending ? 'desc' : 'asc'}`
  }
  function sortLabel(field: SortField, label: string) {
    const current = sortField === field ? `，当前${sortDirection === 1 ? '升序' : '降序'}` : ''
    return `${label}排序${current}，点击${nextSort(field).endsWith('-asc') ? '升序' : '降序'}`
  }
  function sortIndicator(field: SortField) { return sortField === field ? sortDirection === 1 ? '↑' : '↓' : '↕' }
  function formatTime(value: number | null) {
    return value ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '尚无成功记录'
  }
  function cacheLabel(key: string) {
    const entry = cacheEntries.get(key)
    return entry ? entry.state === 'ready' ? '本地缓存' : entry.state === 'partial' ? '缓存不完整' : '待首次同步' : databaseLoading ? '检查中…' : '未读取缓存'
  }

  onMount(() => { void refreshList() })
  $effect(() => { if (snapshotChanged) void refreshList() })
  onDestroy(() => { request += 1 })

  async function refreshList() {
    const seq = ++request
    databaseLoading = true
    databaseError = ''
    openFailed = false
    try {
      const snapshot = await loadLocalDocumentList(getBridge(), context)
      if (seq !== request) return
      recent = snapshot.recent
      cacheEntries = snapshot.cacheEntries
    } catch (err) {
      if (seq === request) databaseError = `本地文档列表未更新：${maskUuids(err instanceof Error ? err.message : String(err))}`
    } finally {
      if (seq === request) { databaseLoading = false; loading = false }
    }
  }

  async function open(database?: string, connectionId = selected?.connectionId) {
    const connection = connections.find((entry) => entry.connectionId === connectionId)
    if (!connection || openingDatabase !== null) return
    const seq = ++request
    databaseLoading = false
    loading = false
    openingDatabase = JSON.stringify([connectionId, database ?? ''])
    databaseError = ''
    openFailed = false
    try {
      onopen({ connectionId, name: connection.name, dbType: connection.dbType, database })
    } catch (err) {
      if (seq !== request) return
      databaseError = maskUuids(err instanceof Error ? err.message : String(err))
      openFailed = true
      failureConnectionId = connection.connectionId
      failureDatabase = database
    } finally { if (seq === request) openingDatabase = null }
  }
  function cacheUpdated(target: BatchTarget) {
    oncacheupdated?.(target)
  }
  function cacheCleared() {
    if (!clearTarget) return
    // Invalidate pending list reads before updating local counts and sort keys.
    request += 1
    databaseLoading = false
    cacheEntries = new Map(cacheEntries).set(clearTarget.key, summarizeDocumentCache(null))
    oncachecleared?.(clearContext)
  }
  function closeClear() {
    clearTarget = null
    queueMicrotask(() => {
      if (!document.activeElement || document.activeElement === document.body) searchInput?.focus()
    })
  }
  async function openBatch() {
    const location = await getBridge()?.getSnapshotDirectoryStatus?.()
    if (location && location.status !== 'ready' && onsnapshot) { onsnapshot(); return }
    batchOpen = true
  }
  async function closeBatch() { batchOpen = false; await refreshList() }
  function retryFailure() { if (openFailed) void open(failureDatabase, failureConnectionId); else void refreshList() }
  function focusPicker(node: HTMLElement) { if (onclose) return modalFocus(node) }
</script>

<svelte:window onkeydown={(event) => {
  if (batchOpen || clearTarget || event.key !== 'Escape') return
  if (onclose) { event.preventDefault(); onclose() }
}} />

<section class="switcher" inert={batchOpen || clearTarget !== null} role={onclose ? 'dialog' : 'region'} aria-modal={onclose ? true : undefined} aria-label="选择连接与数据库" use:focusPicker>
  <header class="switcher-topbar">
    <div class="switcher-brand"><span class="brand-icon"><Icon name="database" size={18} /></span><strong>数据库文档</strong><span class="topbar-separator">/</span><span>切换文档</span></div>
    <div class="topbar-actions">{#if onsnapshot}<SnapshotDirectoryButton onclick={onsnapshot} disabled={syncBlocked || batchOpen} />{/if}<button class="btn batch-trigger" disabled={syncBlocked || databaseLoading || openingDatabase !== null} title={syncBlocked ? '请等待当前文档同步完成' : '读取已连接连接下的数据库列表并批量生成整库文档'} onclick={() => void openBatch()}><Icon name="refresh" size={14} />批量生成文档</button>
    {#if onclose}<button class="btn return-button" onclick={onclose}><Icon name="back" size={14} />{returnLabel}</button>{/if}</div>
  </header>

  <div class="switcher-body">
    <main class="documents-pane">
      {#if databaseError}<div class="list-error" role="alert"><Icon name="database" size={17} /><div><strong>{openFailed ? '暂时无法打开文档' : '暂时无法刷新本地列表'}</strong><p>{databaseError}</p></div><button class="text-btn" disabled={databaseLoading || openingDatabase !== null} onclick={retryFailure}>重试</button></div>{/if}
      {#if selected}
        <div class="documents-heading">
          <div class="heading-copy"><div class="heading-label">选择数据库文档</div><div class="connection-title"><h1 title={selectedLabel}>{selectedLabel}</h1><span class="engine-label">{resolvedType ? resolvedType.toUpperCase() : '数据库'}</span></div><p>点击数据库打开文档，优先读取本地缓存。</p></div>
          <button class="btn list-refresh" aria-label="刷新数据库列表" title="重新读取本地文档记录和缓存状态" disabled={databaseLoading || openingDatabase !== null} onclick={() => void refreshList()}><span class:spinning={databaseLoading}><Icon name="refresh" size={15} /></span><span>{databaseLoading ? '读取中…' : '刷新列表'}</span></button>
        </div>

        <div class="documents-toolbar">
          <div class="document-tabs" role="group" aria-label="文档筛选"><button class:chosen={!cachedOnly} aria-pressed={!cachedOnly} onclick={() => cachedOnly = false}>全部数据库<span>{documents.length}</span></button><button class:chosen={cachedOnly} aria-pressed={cachedOnly} onclick={() => cachedOnly = true}>有本地缓存<span>{cachedCount}</span></button></div>
          <div class="list-controls">
            <div class="search-field database-search"><Icon name="search" size={15} /><input type="search" aria-label="搜索数据库" placeholder="搜索数据库或连接名称" bind:value={databaseQuery} bind:this={searchInput} /></div>
            <select class="mobile-sort" aria-label="文档本地排序" bind:value={sortOrder}>
              <option value="default">默认顺序</option>
              <option value="database-asc">数据库 ↑</option><option value="database-desc">数据库 ↓</option>
              <option value="connection-asc">连接名称 ↑</option><option value="connection-desc">连接名称 ↓</option>
              <option value="lastSyncedAt-desc">同步时间：最新优先</option><option value="lastSyncedAt-asc">同步时间：最早优先</option>
            </select>
          </div>
        </div>

        <div class="documents-list" aria-label="数据库文档列表" aria-busy={databaseLoading}>
          <div class="list-columns">
            <button class="column-sort" class:sorted={sortField === 'database'} aria-label={sortLabel('database', '数据库')} aria-pressed={sortField === 'database'} onclick={() => sortOrder = nextSort('database')}>数据库<span aria-hidden="true">{sortIndicator('database')}</span></button>
            <button class="column-sort connection-column" class:sorted={sortField === 'connection'} aria-label={sortLabel('connection', '连接名称')} aria-pressed={sortField === 'connection'} onclick={() => sortOrder = nextSort('connection')}>连接名称<span aria-hidden="true">{sortIndicator('connection')}</span></button>
            <span>本地缓存</span>
            <button class="column-sort date-column" class:sorted={sortField === 'lastSyncedAt'} aria-label={sortLabel('lastSyncedAt', '最后成功同步')} aria-pressed={sortField === 'lastSyncedAt'} onclick={() => sortOrder = nextSort('lastSyncedAt')}>最后成功同步<span aria-hidden="true">{sortIndicator('lastSyncedAt')}</span></button>
            <span></span>
          </div>
          {#each visibleDatabases as document (document.key)}
            {@const database = document.database}
            {@const connectionLabel = connectionNameOf(document.connection)}
            {@const current = document.connection.connectionId === context.connectionId && database === context.database}
            {@const cached = cacheEntries.get(document.key)}
            <div class="document-entry" class:current={current}>
            <button class="document-row" class:current={current} disabled={openingDatabase !== null}
              aria-label={`打开数据库 ${database}，连接 ${connectionLabel}`} aria-current={current ? 'page' : undefined} onclick={() => void open(database, document.connection.connectionId)}>
              <span class="document-identity"><span class="database-icon"><Icon name="database" size={18} /></span><span class="database-name"><span><strong title={database}>{database}</strong>{#if current}<small class="current-tag">当前文档</small>{/if}</span>{#if cached && cached.state !== 'missing'}<small>{cached.state === 'partial' ? `${cached.cachedTableCount} / ${cached.tableCount} 张表已缓存` : `${cached.tableCount} 张表`}</small>{:else}<small>{cached?.state === 'missing' ? '打开后可手动刷新，创建本地文档' : '读取缓存信息，不访问数据库'}</small>{/if}<small class="mobile-connection">连接：{connectionLabel}</small></span></span>
              <span class="connection-cell connection-column">{connectionLabel}</span>
              <span class="cache-cell"><span class="cache-label" class:cache-ready={cached?.state === 'ready'} class:cache-partial={cached?.state === 'partial'}><span class="cache-dot"></span>{cacheLabel(document.key)}</span><small class="mobile-date">{cached?.state !== 'missing' && cached ? formatTime(cached.lastSyncedAt) : '尚未同步'}</small></span>
              <span class="sync-date date-column">{cached && cached.state !== 'missing' ? formatTime(cached.lastSyncedAt) : '—'}</span>
              <span class="row-action">{#if openingDatabase === document.key}<span class="spinner"></span>{:else}<Icon name={current ? 'check' : 'arrow'} size={16} />{/if}</span>
            </button>
            {#if cached && cached.state !== 'missing'}<button class="clear-cache" title={syncBlocked ? '请等待当前文档同步完成' : '清除此库的本地缓存'} aria-label={`清除数据库 ${database} 的缓存，连接 ${connectionLabel}`} disabled={syncBlocked || databaseLoading || openingDatabase !== null} onclick={() => clearTarget = document}><Icon name="trash" size={14} /></button>{/if}
            </div>
          {/each}
          {#if useCurrent && !databaseQuery && !cachedOnly}<button class="document-row current-session" disabled={openingDatabase !== null} onclick={() => void open()}><span class="document-identity"><span class="database-icon"><Icon name="database" size={18} /></span><span class="database-name"><strong>默认数据库</strong><small>打开当前连接的默认文档</small><small class="mobile-connection">连接：{selectedLabel}</small></span></span><span class="connection-cell connection-column">{selectedLabel}</span><span class="cache-cell">默认范围</span><span class="date-column"></span><Icon name="arrow" size={16} /></button>{/if}
          {#if !visibleDatabases.length && (!useCurrent || databaseQuery || cachedOnly)}<div class="documents-empty" role="status">{#if databaseLoading}<span class="spinner"></span><h2>正在读取本地文档记录</h2>{:else}<Icon name={databaseQuery ? 'search' : 'database'} size={28} /><h2>{databaseQuery ? '没有匹配的数据库' : cachedOnly ? '还没有本地缓存' : '还没有最近使用的数据库'}</h2><p>{databaseQuery ? '换一个名称搜索，或清空搜索条件。' : cachedOnly ? '切换到全部数据库，打开文档后点击刷新即可创建缓存。' : '从 DBX 的数据库右键打开文档后，点击「刷新列表」更新本地记录。'}</p>{#if databaseQuery || cachedOnly}<button class="btn" onclick={() => { databaseQuery = ''; cachedOnly = false }}>查看全部数据库</button>{/if}{/if}</div>{/if}
        </div>
      {:else}
        <div class="first-use"><span class="first-use-icon"><Icon name="database" size={30} /></span><h1>{loading ? '正在打开最近文档' : '还没有数据库文档'}</h1><p>{loading ? '正在加载本地记录…' : '在 DBX 中右键点击连接或数据库，选择「查看数据库文档」。'}</p><small>打开过的数据库会保存在这里，后续可以直接切换。</small></div>
      {/if}
      {#if diagnostics}<details class="connection-diagnostics"><summary>连接诊断</summary><code>{diagnostics}</code></details>{/if}
    </main>
  </div>
</section>

{#if batchOpen}<BatchRefreshDialog {documents} onclose={() => void closeBatch()} onupdated={cacheUpdated} />{/if}
{#if clearTarget}<ClearCacheDialog context={clearContext} connectionName={connectionNameOf(clearTarget.connection)} onclose={closeClear} oncleared={cacheCleared} />{/if}

<style>
  .switcher { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--panel); overflow: auto; }
  .switcher-topbar { min-height: 58px; flex: none; display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 10px 24px; border-bottom: 1px solid var(--border); }
  .switcher-brand { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--muted); }
  .switcher-brand strong { color: var(--text); font-weight: 600; }
  .brand-icon { display: grid; place-items: center; width: 29px; height: 29px; border-radius: 7px; color: var(--accent); background: var(--accent-weak); }
  .topbar-separator { color: var(--border); padding: 0 2px; }
  .topbar-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
  .batch-trigger { font-size: 12px; padding: 5px 10px; }
  .return-button { font-size: 12px; padding: 5px 10px; }
  .switcher-body { display: flex; flex: 1; min-height: 0; }
  h2 { margin: 0; font-size: 13px; font-weight: 600; }
  .search-field { display: flex; align-items: center; gap: 7px; border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; color: var(--muted); background: var(--panel); }
  .search-field:focus-within { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-weak); }
  .search-field input { width: 100%; min-width: 0; padding: 0; border: 0; background: transparent; color: var(--text); outline: none; font: inherit; font-size: 12px; }
  .documents-pane { display: flex; flex: 1; flex-direction: column; min-height: 0; min-width: 0; padding: 32px clamp(20px,3.3vw,48px) 20px; overflow: auto; }
  .documents-heading { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 30px; flex: none; }
  .heading-copy { min-width: 0; }
  .heading-label { color: var(--muted); font-size: 11px; margin-bottom: 7px; }
  .connection-title { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
  h1 { font-size: 21px; font-weight: 600; letter-spacing: -.5px; line-height: 1.4; margin: 0; overflow-wrap: anywhere; }
  .connection-title h1 { min-width: 0; max-width: 100%; }
  .engine-label { font: 10px var(--mono); color: var(--muted); background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 2px 5px; }
  .documents-heading p { margin: 8px 0 0; color: var(--muted); font-size: 12px; }
  .list-refresh { flex: none; font-size: 12px; padding: 7px 11px; }
  .list-refresh > span { display: inline-flex; }
  .documents-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 17px; flex: none; }
  .document-tabs { display: flex; align-items: center; gap: 17px; }
  .document-tabs button { display: flex; align-items: center; gap: 6px; padding: 9px 0; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--muted); font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer; }
  .document-tabs button.chosen { color: var(--text); border-bottom-color: var(--accent); font-weight: 600; }
  .document-tabs button span { color: var(--muted); font: 10px var(--mono); background: var(--bg); border-radius: 4px; padding: 1px 5px; }
  .database-search { width: 235px; }
  .list-controls { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .mobile-sort { display: none; padding: 8px 5px; border: 1px solid var(--border); border-radius: 6px; color: var(--text); background: var(--panel); font: inherit; font-size: 11px; }
  .documents-list { flex: 1 0 auto; min-height: 180px; border-top: 1px solid var(--border); }
  .list-columns, .document-row { display: grid; grid-template-columns: minmax(0,1fr) minmax(120px,.65fr) 138px 155px 22px; align-items: center; column-gap: 16px; }
  .list-columns { padding: 11px 47px 11px 13px; color: var(--muted); font-size: 10px; border-bottom: 1px solid var(--border); }
  .document-entry { position: relative; padding-right: 34px; border-bottom: 1px solid var(--border); }
  .document-entry.current { background: color-mix(in srgb, var(--accent-weak) 45%, transparent); }
  .document-entry .document-row { border-bottom: 0; }
  .document-entry .document-row.current { background: transparent; }
  .clear-cache { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); width: 26px; height: 26px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--muted); cursor: pointer; }
  .clear-cache:hover { color: var(--danger); background: var(--row-hover); }
  .clear-cache:focus-visible { outline: 2px solid var(--accent); }
  .clear-cache:disabled { opacity: .35; cursor: default; }
  @media(max-width:600px) { .documents-list .list-columns { padding-right: 40px; } }
  .column-sort { display: inline-flex; justify-self: start; align-items: center; gap: 5px; border: 0; padding: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .column-sort > span { opacity: .5; font-size: 12px; }
  .column-sort:hover, .column-sort.sorted { color: var(--accent); }.column-sort.sorted > span { opacity: 1; }
  .column-sort:focus-visible, .mobile-sort:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 3px; }
  .document-row { width: 100%; padding: 7px 13px; text-align: left; background: transparent; border: 0; border-bottom: 1px solid var(--border); color: var(--text); font: inherit; cursor: pointer; }
  .document-row:hover { background: var(--row-hover); }
  .document-row.current { background: color-mix(in srgb, var(--accent-weak) 45%, transparent); }
  .document-row:focus-visible, .document-tabs button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .document-row:disabled { opacity: .6; cursor: default; }
  .document-identity { display: flex; min-width: 0; align-items: center; gap: 12px; }
  .database-icon { color: var(--muted); display: flex; flex: none; }
  .database-name { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .database-name > span { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
  .database-name strong { font: 500 13px var(--mono); min-width: 0; overflow-wrap: anywhere; }
  .database-name small { font-size: 10px; color: var(--muted); }
  .database-name .current-tag { flex: none; padding: 1px 5px; border-radius: 4px; background: var(--accent-weak); color: var(--accent); font-size: 9px; }
  .connection-cell { min-width: 0; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  .mobile-connection { display: none; overflow-wrap: anywhere; }
  .cache-cell { display: flex; flex-direction: column; gap: 2px; color: var(--muted); font-size: 11px; }
  .cache-label { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .cache-dot { width: 5px; height: 5px; flex: none; border-radius: 50%; background: var(--muted); opacity: .45; }
  .cache-ready .cache-dot { background: var(--accent); opacity: 1; }
  .cache-partial { color: var(--danger); }
  .cache-partial .cache-dot { background: var(--danger); opacity: 1; }
  .sync-date { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .mobile-date { display: none; font-size: 9px; }
  .row-action { display: flex; justify-content: center; color: var(--muted); }
  .document-row.current .row-action, .document-row:hover .row-action { color: var(--accent); }
  .list-error { display: flex; align-items: flex-start; gap: 10px; padding: 12px; margin-bottom: 16px; border: 1px solid var(--border); border-left: 3px solid var(--danger); border-radius: 6px; background: var(--bg); font-size: 12px; }
  .list-error > :global(svg) { flex: none; color: var(--danger); }
  .list-error > div { flex: 1; min-width: 0; }
  .list-error strong { font-weight: 600; }
  .list-error p { margin: 4px 0 0; color: var(--muted); overflow-wrap: anywhere; line-height: 1.7; }
  .list-error .text-btn { flex: none; }
  .documents-empty, .first-use { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 54px 20px; min-height: 260px; text-align: center; color: var(--muted); }
  .documents-empty h2 { font-size: 14px; color: var(--text); }.documents-empty p { max-width: 360px; font-size: 12px; line-height: 1.8; margin: 0; }
  .documents-empty > :global(svg) { opacity: .65; }
  .documents-empty .btn { margin-top: 4px; font-size: 11px; }
  .first-use { flex: 1; }.first-use h1 { font-size: 20px; color: var(--text); }.first-use p { max-width: 380px; margin: 0; font-size: 13px; line-height: 1.9; }.first-use small { font-size: 11px; }
  .first-use-icon { display: grid; place-items: center; width: 64px; height: 64px; margin-bottom: 8px; border-radius: 15px; background: var(--accent-weak); color: var(--accent); }
  .connection-diagnostics { flex: none; padding-top: 15px; color: var(--muted); font-size: 10px; }.connection-diagnostics code { display: block; overflow-wrap: anywhere; }
  .spinning { animation: spin 1s linear infinite; }@keyframes spin { to { transform: rotate(360deg); } }
  @media(max-width:1000px) { .documents-pane { padding: 26px 22px 18px; }.list-columns, .document-row { grid-template-columns: minmax(0,1fr) minmax(100px,.65fr) 112px 125px 18px; column-gap: 10px; } }
  @media(max-width:800px) { .connection-column { display: none; }.mobile-connection { display: block; }.date-column { display: none; }.mobile-date { display: block; }.list-columns, .document-row { grid-template-columns: minmax(0,1fr) 118px 18px; }.documents-toolbar { flex-wrap: wrap; gap: 10px; }.list-controls { width: 100%; }.database-search { flex: 1; min-width: 0; width: auto; }.mobile-sort { display: block; max-width: 145px; } }
  @media(max-width:600px) { .switcher-topbar { padding: 10px 16px; min-height: 54px; }.topbar-separator, .topbar-separator + span { display: none; }.documents-pane { flex: 1; padding: 23px 16px 20px; }.documents-heading { margin-bottom: 22px; gap: 10px; align-items: flex-start; }h1 { font-size: 18px; }.connection-title { gap: 6px; }.heading-label { font-size: 10px; }.documents-heading p { font-size: 11px; line-height: 1.8; }.list-refresh { font-size: 11px; padding: 6px 8px; }.document-tabs { gap: 16px; }.list-columns, .document-row { grid-template-columns: minmax(0,1fr) 111px 16px; column-gap: 8px; }.list-columns { padding: 10px 6px; }.document-row { padding: 6px; }.database-icon { display: none; }.database-name strong { font-size: 12px; }.database-name small { font-size: 9px; line-height: 1.5; }.first-use { min-height: 260px; padding: 30px 12px; } }
</style>
