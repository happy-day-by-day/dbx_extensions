<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte'
  import { loadRecent, rememberConnection, type RecentConnection } from '../../lib/recent'
  import { loadOffline } from '../../lib/offline'
  import { cleanConnectionName } from '../../lib/connectionLabels'
  import { groupConnections, mergeDatabases, connectionMatches, currentSessionDatabase, summarizeDocumentCache, type DocumentCacheSummary, type ResourceConnection } from '../../lib/resources'
  import { getAdapter, normalizeDbType } from '../../lib/dialects/registry'
  import { listDatabases, runConcurrentQueue } from '../../lib/store'
  import { maskUuids } from '../../lib/display/masking'
  import { getBridge, isDataAccessDenied, isConnectionNotOpen } from '../../lib/bridge'
  import type { PluginContext } from '../../lib/types'
  import { modalFocus } from '../modalFocus'
  import Icon from './Icon.svelte'

  let { context = {}, diagnostics = null, onopen, onclose, onrename, returnLabel = '返回文档' }:
    { context?: PluginContext; diagnostics?: string | null;
      onopen: (context: PluginContext) => void; onclose?: () => void; onrename?: (connectionId: string, name: string) => void; returnLabel?: string } = $props()

  let recent = $state<RecentConnection[]>([])
  let loading = $state(true)
  let selectedId = $state('')
  let connectionQuery = $state('')
  let databaseQuery = $state('')
  let cachedOnly = $state(false)
  let cacheLoading = $state(false)
  let cacheEntries = $state(new Map<string, DocumentCacheSummary>())
  let listRefreshed = $state(false)
  let cacheRequest = 0
  let databases = $state<string[]>([])
  let databaseLoading = $state(false)
  let databaseError = $state('')
  let denied = $state(false)
  let connectionClosed = $state(false)
  let openFailed = $state(false)
  let failureDatabase = $state<string | undefined>()
  let openingDatabase = $state<string | null>(null)
  let useCurrent = $state(false)
  let supported = $state(true)
  let resolvedType = $state('')
  let editingName = $state(false)
  let nameDraft = $state('')
  let nameError = $state('')
  let nameSaving = $state(false)
  let nameInput = $state<HTMLInputElement>()
  let nameEditButton = $state<HTMLButtonElement>()
  let nameRequest = 0
  let request = 0
  const connections = $derived(groupConnections(recent, context))
  const visibleConnections = $derived(connections.filter((connection) => connectionMatches(connection, connectionQuery)))
  const selected = $derived(connections.find((connection) => connection.connectionId === selectedId))
  const selectedLabel = $derived(selected ? connectionNameOf(selected) : '')
  const visibleDatabases = $derived(databases.filter((database) => database.toLocaleLowerCase().includes(databaseQuery.trim().toLocaleLowerCase()))
    .filter((database) => !cachedOnly || (cacheEntries.has(database) && cacheEntries.get(database)!.state !== 'missing')))
  const cachedCount = $derived([...cacheEntries.values()].filter((entry) => entry.state !== 'missing').length)
  const activeDatabase = $derived(selectedId === context.connectionId ? context.database : undefined)

  function connectionNameOf(connection: ResourceConnection) {
    return cleanConnectionName(connection.name, connection.connectionId) || `未命名连接 ${connections.indexOf(connection) + 1}`
  }
  function formatTime(value: number | null) {
    return value ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '尚无成功记录'
  }
  function cacheLabel(database: string) {
    const entry = cacheEntries.get(database)
    return entry ? entry.state === 'ready' ? '本地缓存' : entry.state === 'partial' ? '缓存不完整' : '待首次同步' : cacheLoading ? '检查中…' : '未读取缓存'
  }
  async function inspectCaches(seq: number) {
    const batch = ++cacheRequest
    const bridge = getBridge()
    const connectionId = selectedId
    const dbType = normalizeDbType(resolvedType)
    if (!bridge?.capabilities?.storage) { cacheLoading = false; return }
    cacheLoading = true
    await runConcurrentQueue([...databases], async (database) => {
      const doc = await loadOffline(bridge, { connectionId, database, dbType })
      if (seq === request && batch === cacheRequest) cacheEntries = new Map([...cacheEntries, [database, summarizeDocumentCache(doc)]])
    }, { concurrency: 4, shouldContinue: () => seq === request && batch === cacheRequest })
    if (seq === request && batch === cacheRequest) cacheLoading = false
  }

  onMount(() => {
    let alive = true
    void loadRecent(getBridge()).catch(() => []).then((entries) => {
      if (!alive) return
      recent = entries
      loading = false
      if (!selectedId) { const id = context.connectionId || connections[0]?.connectionId; if (id) void selectConnection(id) }
    })
    return () => { alive = false }
  })
  onDestroy(() => { request += 1; nameRequest += 1; cacheRequest += 1 })

  async function selectConnection(connectionId: string, refresh = false) {
    if (nameSaving) return
    const connection = connections.find((entry) => entry.connectionId === connectionId)
    if (!connection) return
    const seq = ++request
    selectedId = connectionId
    cachedOnly = false
    cacheEntries = new Map()
    cacheRequest += 1
    listRefreshed = false
    editingName = false
    nameError = ''
    databaseQuery = ''
    databaseError = ''
    denied = false
    connectionClosed = false
    openFailed = false
    failureDatabase = undefined
    openingDatabase = null
    supported = true
    useCurrent = false
    resolvedType = connection.dbType
    databases = [...connection.databases]
    databaseLoading = false
    // Opening the picker uses remembered databases; only its refresh button queries the host.
    void inspectCaches(seq)
    if (!refresh) { useCurrent = !getAdapter(connection.dbType)?.listDatabases && !databases.length; return }
    databaseLoading = true
    const bridge = getBridge()
    const queryDatabase = currentSessionDatabase(context, connectionId)
    try {
      if (!bridge) throw new Error('请在 DBX 中打开数据库文档')
      let type = normalizeDbType(connection.dbType)
      if (!connection.dbType) {
        const probe = await bridge.queryData({ connectionId, database: queryDatabase, sql: 'SELECT 1', maxRows: 1 })
        if (seq !== request) return
        type = normalizeDbType(probe.dbType)
        resolvedType = probe.dbType
      }
      const adapter = getAdapter(type)
      if (!adapter) {
        supported = false
        throw new Error('该类型暂不支持整库文档，请从具体表的右键菜单查看基础字段')
      }
      if (!adapter.listDatabases) { useCurrent = !databases.length; return }
      const available = await listDatabases(bridge, adapter, connectionId,
        { db: queryDatabase ?? null, schema: null, table: null }, true)
      if (seq === request) { databases = mergeDatabases(connection.databases, available); listRefreshed = true; void inspectCaches(seq) }
    } catch (err) {
      if (seq !== request) return
      databaseError = maskUuids(err instanceof Error ? err.message : String(err))
      denied = isDataAccessDenied(err)
      connectionClosed = isConnectionNotOpen(err)
      failureDatabase = queryDatabase
    } finally { if (seq === request) databaseLoading = false }
  }

  async function open(database?: string) {
    if (!selected || !supported || openingDatabase !== null || nameSaving) return
    const seq = ++request
    const next = { connectionId: selected.connectionId, name: selected.name, dbType: resolvedType, database }
    databaseLoading = false
    openingDatabase = database ?? ''
    databaseError = ''
    connectionClosed = false
    denied = false
    openFailed = false
    try {
      if (seq === request) onopen(next)
    } catch (err) {
      if (seq !== request) return
      databaseError = maskUuids(err instanceof Error ? err.message : String(err))
      connectionClosed = isConnectionNotOpen(err)
      denied = isDataAccessDenied(err)
      openFailed = true
      failureDatabase = database
    } finally { if (seq === request) openingDatabase = null }
  }
  function retryFailure() { if (openFailed) void open(failureDatabase); else void selectConnection(selectedId, true) }
  function focusPicker(node: HTMLElement) { if (onclose) return modalFocus(node) }

  async function editName() {
    if (!selected) return
    editingName = true
    nameDraft = selected.name
    nameError = ''
    await tick()
    nameInput?.focus()
    nameInput?.select()
  }
  async function saveName() {
    if (!selected || nameSaving) return
    const name = cleanConnectionName(nameDraft, selected.connectionId)
    if (!name) { nameError = '请输入便于识别的连接名称，例如「业务开发环境」。'; return }
    const bridge = getBridge()
    if (!bridge?.capabilities?.storage) { nameError = '当前 DBX 不支持保存显示名称，请升级后重试。'; return }
    const seq = ++nameRequest
    const connectionId = selected.connectionId
    nameSaving = true
    nameError = ''
    try {
      const entries = await rememberConnection(bridge, { connectionId, name, dbType: resolvedType || selected.dbType,
        database: selectedId === context.connectionId ? context.database : selected.databases[0] })
      if (seq !== nameRequest) return
      recent = entries
      onrename?.(connectionId, name)
      cancelNameEdit()
    } catch (err) {
      if (seq === nameRequest) nameError = `显示名称未保存：${maskUuids(err instanceof Error ? err.message : String(err))}`
    } finally { if (seq === nameRequest) nameSaving = false }
  }
  function cancelNameEdit() {
    editingName = false
    void tick().then(() => nameEditButton?.focus())
  }
</script>

<svelte:window onkeydown={(event) => {
  if (event.key !== 'Escape' || nameSaving) return
  if (editingName) { event.preventDefault(); cancelNameEdit() }
  else if (onclose) { event.preventDefault(); onclose() }
}} />

<section class="switcher" role={onclose ? 'dialog' : 'region'} aria-modal={onclose ? true : undefined} aria-label="选择连接与数据库" use:focusPicker>
  <header class="switcher-topbar">
    <div class="switcher-brand"><span class="brand-icon"><Icon name="database" size={18} /></span><strong>数据库文档</strong><span class="topbar-separator">/</span><span>切换文档</span></div>
    {#if onclose}<button class="btn return-button" disabled={nameSaving} onclick={onclose}><Icon name="back" size={14} />{returnLabel}</button>{/if}
  </header>

  <div class="switcher-body">
    <aside class="connections-pane" aria-label="连接列表">
      <div class="pane-title"><h2>连接</h2><span>{connections.length}</span></div>
      <div class="search-field"><Icon name="search" size={15} /><input type="search" aria-label="搜索连接" placeholder="搜索连接或库名" bind:value={connectionQuery} /></div>
      <div class="connections-list">
        {#if loading}<div class="pane-empty" role="status"><span class="spinner"></span>加载最近记录…</div>{/if}
        {#each visibleConnections as connection (connection.connectionId)}
          <button class="connection-row" class:active={selectedId === connection.connectionId} aria-pressed={selectedId === connection.connectionId}
            aria-label={`选择连接 ${connectionNameOf(connection)}`} disabled={nameSaving} onclick={() => void selectConnection(connection.connectionId)}>
            <span class="connection-icon"><Icon name="server" size={17} /></span>
            <span class="connection-text"><strong title={connectionNameOf(connection)}>{connectionNameOf(connection)}</strong><small>{connection.dbType ? connection.dbType.toUpperCase() : '类型待识别'}<span>·</span>{connection.databases.length} 个最近数据库</small></span>
            {#if selectedId === connection.connectionId}<Icon name="chevron" size={13} />{/if}
          </button>
        {/each}
        {#if !loading && !visibleConnections.length}<div class="pane-empty">{connectionQuery ? '没有匹配的连接' : '暂无最近连接'}{#if connectionQuery}<button class="text-btn" onclick={() => connectionQuery = ''}>清空搜索</button>{/if}</div>{/if}
      </div>
      <div class="connections-help"><Icon name="database" size={14} /><span>从 DBX 连接右键打开文档后，连接会保存在这里。</span></div>
    </aside>

    <main class="documents-pane">
      {#if selected}
        <div class="documents-heading">
          <div class="heading-copy"><div class="heading-label">选择数据库文档</div><div class="connection-title"><h1 title={selectedLabel}>{selectedLabel}</h1><span class="engine-label">{resolvedType ? resolvedType.toUpperCase() : '数据库'}</span><button class="icon-btn" bind:this={nameEditButton} aria-label="修改连接显示名称" title="修改连接显示名称" disabled={nameSaving || openingDatabase !== null} onclick={() => void editName()}><Icon name="edit" size={14} /></button></div><p>点击数据库打开文档，优先读取本地缓存。</p></div>
          <button class="btn list-refresh" aria-label="刷新数据库列表" title="从当前连接重新读取数据库列表，不同步表文档" disabled={databaseLoading || openingDatabase !== null || nameSaving} onclick={() => void selectConnection(selectedId, true)}><span class:spinning={databaseLoading}><Icon name="refresh" size={15} /></span><span>{databaseLoading ? '读取中…' : '刷新列表'}</span></button>
        </div>

        {#if editingName}<form class="name-editor" novalidate onsubmit={(event) => { event.preventDefault(); void saveName() }}>
          <label for="connection-display-name">连接显示名称</label><div class="name-editor-controls"><input id="connection-display-name" bind:this={nameInput} bind:value={nameDraft} oninput={() => nameError = ''} maxlength="80" autocomplete="off" disabled={nameSaving} placeholder="例如：业务开发环境" /><button type="button" class="btn" disabled={nameSaving} onclick={cancelNameEdit}>取消</button><button class="btn btn-primary" type="submit" disabled={nameSaving}>{nameSaving ? '保存中…' : '保存'}</button></div><small>仅修改本插件中的名称。</small>{#if nameError}<p role="alert">{nameError}</p>{/if}
        </form>{/if}

        <div class="documents-toolbar">
          <div class="document-tabs" role="group" aria-label="文档筛选"><button class:chosen={!cachedOnly} aria-pressed={!cachedOnly} onclick={() => cachedOnly = false}>全部数据库<span>{databases.length}</span></button><button class:chosen={cachedOnly} aria-pressed={cachedOnly} onclick={() => cachedOnly = true}>有本地缓存<span>{cachedCount}</span></button></div>
          <div class="search-field database-search"><Icon name="search" size={15} /><input type="search" aria-label="搜索数据库" placeholder="搜索数据库名称" bind:value={databaseQuery} /></div>
        </div>

        {#if databaseError}<div class="list-error" role={connectionClosed ? 'status' : 'alert'}><Icon name="database" size={17} /><div><strong>{connectionClosed ? '数据库列表未更新' : '暂时无法刷新列表'}</strong><p>{connectionClosed ? `请在 DBX 中连接「${selectedLabel}」${failureDatabase ? `并打开「${failureDatabase}」` : ''}后重试。已保存的文档仍可打开。` : databaseError}</p>{#if denied}<p>请在 DBX 授权提示中允许访问；已拒绝时需重新打开工作台。</p>{/if}</div><button class="text-btn" disabled={databaseLoading || openingDatabase !== null} onclick={retryFailure}>重试</button></div>{/if}

        <div class="documents-list" aria-label="数据库文档列表" aria-busy={databaseLoading || cacheLoading}>
          <div class="list-columns" aria-hidden="true"><span>数据库</span><span>本地缓存</span><span class="date-column">最后成功同步</span><span></span></div>
          {#each visibleDatabases as database (database)}
            {@const cached = cacheEntries.get(database)}
            <button class="document-row" class:current={activeDatabase === database} disabled={!supported || openingDatabase !== null || nameSaving}
              aria-label={`打开数据库 ${database}`} aria-current={activeDatabase === database ? 'page' : undefined} onclick={() => void open(database)}>
              <span class="document-identity"><span class="database-icon"><Icon name="database" size={18} /></span><span class="database-name"><span><strong title={database}>{database}</strong>{#if activeDatabase === database}<small class="current-tag">当前文档</small>{/if}</span>{#if cached && cached.state !== 'missing'}<small>{cached.state === 'partial' ? `${cached.cachedTableCount} / ${cached.tableCount} 张表已缓存` : `${cached.tableCount} 张表`}</small>{:else}<small>{cached?.state === 'missing' ? '打开后可手动刷新，创建本地文档' : '读取缓存信息，不访问数据库'}</small>{/if}</span></span>
              <span class="cache-cell"><span class="cache-label" class:cache-ready={cached?.state === 'ready'} class:cache-partial={cached?.state === 'partial'}><span class="cache-dot"></span>{cacheLabel(database)}</span><small class="mobile-date">{cached?.state !== 'missing' && cached ? formatTime(cached.lastSyncedAt) : '尚未同步'}</small></span>
              <span class="sync-date date-column">{cached && cached.state !== 'missing' ? formatTime(cached.lastSyncedAt) : '—'}</span>
              <span class="row-action">{#if openingDatabase === database}<span class="spinner"></span>{:else}<Icon name={activeDatabase === database ? 'check' : 'arrow'} size={16} />{/if}</span>
            </button>
          {/each}
          {#if useCurrent && !databaseQuery && !cachedOnly}<button class="document-row current-session" disabled={openingDatabase !== null || nameSaving} onclick={() => void open()}><span class="document-identity"><span class="database-icon"><Icon name="database" size={18} /></span><span class="database-name"><strong>默认数据库</strong><small>打开当前连接的默认文档</small></span></span><span class="cache-cell">默认范围</span><span class="date-column"></span><Icon name="arrow" size={16} /></button>{/if}
          {#if !visibleDatabases.length && (!useCurrent || databaseQuery || cachedOnly)}<div class="documents-empty" role="status">{#if databaseLoading || (cachedOnly && cacheLoading)}<span class="spinner"></span><h2>{databaseLoading ? '正在读取数据库列表' : '正在检查本地缓存'}</h2>{:else}<Icon name={databaseQuery ? 'search' : 'database'} size={28} /><h2>{databaseQuery ? '没有匹配的数据库' : cachedOnly ? '这个连接还没有本地缓存' : '还没有最近使用的数据库'}</h2><p>{databaseQuery ? '换一个名称搜索，或清空搜索条件。' : cachedOnly ? '切换到全部数据库，打开文档后点击刷新即可创建缓存。' : '从 DBX 的数据库右键打开文档，或连接后点击右上角「刷新列表」。'}</p>{#if databaseQuery || cachedOnly}<button class="btn" onclick={() => { databaseQuery = ''; cachedOnly = false }}>查看全部数据库</button>{/if}{/if}</div>{/if}
        </div>
        <footer class="documents-footer"><span>{listRefreshed ? '最近使用与本次读取的数据库' : '列表来自最近使用记录'}{cacheLoading ? ' · 正在检查缓存' : ''}</span><span>仅点击刷新时读取数据库</span></footer>
      {:else}
        <div class="first-use"><span class="first-use-icon"><Icon name="database" size={30} /></span><h1>{loading ? '正在打开最近文档' : '还没有数据库文档'}</h1><p>{loading ? '正在加载本地记录…' : '在 DBX 中右键点击连接或数据库，选择「查看数据库文档」。'}</p><small>打开过的连接会出现在左侧，后续可以直接切换。</small></div>
      {/if}
      {#if diagnostics}<details class="connection-diagnostics"><summary>连接诊断</summary><code>{diagnostics}</code></details>{/if}
    </main>
  </div>
</section>

<style>
  .switcher { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--panel); overflow: auto; }
  .switcher-topbar { min-height: 58px; flex: none; display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 10px 24px; border-bottom: 1px solid var(--border); }
  .switcher-brand { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--muted); }
  .switcher-brand strong { color: var(--text); font-weight: 600; }
  .brand-icon { display: grid; place-items: center; width: 29px; height: 29px; border-radius: 7px; color: var(--accent); background: var(--accent-weak); }
  .topbar-separator { color: var(--border); padding: 0 2px; }
  .return-button { font-size: 12px; padding: 5px 10px; }
  .switcher-body { display: grid; grid-template-columns: 250px minmax(0,1fr); flex: 1; min-height: 0; }
  .connections-pane { display: flex; flex-direction: column; min-height: 0; min-width: 0; padding: 26px 14px 18px; border-right: 1px solid var(--border); background: color-mix(in srgb, var(--bg) 65%, var(--panel)); }
  .pane-title { display: flex; align-items: center; gap: 8px; margin: 0 10px 17px; }
  h2 { margin: 0; font-size: 13px; font-weight: 600; }
  .pane-title > span { color: var(--muted); font: 11px var(--mono); }
  .search-field { display: flex; align-items: center; gap: 7px; border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; color: var(--muted); background: var(--panel); }
  .search-field:focus-within { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-weak); }
  .search-field input { width: 100%; min-width: 0; padding: 0; border: 0; background: transparent; color: var(--text); outline: none; font: inherit; font-size: 12px; }
  .connections-list { display: flex; flex-direction: column; gap: 4px; flex: 1; min-height: 0; overflow: auto; margin: 14px -2px 0; padding: 2px; }
  .connection-row { display: flex; align-items: center; gap: 9px; width: 100%; min-width: 0; padding: 11px 9px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--text); text-align: left; font: inherit; cursor: pointer; }
  .connection-row:hover { background: var(--row-hover); }
  .connection-row.active { background: var(--accent-weak); border-color: color-mix(in srgb, var(--accent) 18%, transparent); }
  .connection-row.active > :global(svg), .connection-row.active .connection-icon { color: var(--accent); }
  .connection-icon { display: flex; flex: none; color: var(--muted); }
  .connection-text { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 5px; }
  .connection-text strong { font-size: 12px; font-weight: 550; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .connection-text small { display: flex; gap: 5px; color: var(--muted); font-size: 10px; white-space: nowrap; }
  .connections-help { display: flex; align-items: flex-start; gap: 7px; margin: 22px 7px 0; color: var(--muted); font-size: 11px; line-height: 1.8; }
  .connections-help :global(svg) { flex: none; margin-top: 3px; }
  .pane-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 9px; padding: 18px 10px; color: var(--muted); font-size: 12px; }
  .documents-pane { display: flex; flex-direction: column; min-height: 0; min-width: 0; padding: 32px clamp(20px,3.3vw,48px) 20px; overflow: auto; }
  .documents-heading { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 30px; flex: none; }
  .heading-copy { min-width: 0; }
  .heading-label { color: var(--muted); font-size: 11px; margin-bottom: 7px; }
  .connection-title { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
  h1 { font-size: 21px; font-weight: 600; letter-spacing: -.5px; line-height: 1.4; margin: 0; overflow-wrap: anywhere; }
  .connection-title h1 { min-width: 0; max-width: 100%; }
  .connection-title .icon-btn { width: 25px; height: 25px; }
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
  .documents-list { flex: 1; min-height: 180px; border-top: 1px solid var(--border); }
  .list-columns, .document-row { display: grid; grid-template-columns: minmax(0,1fr) 138px 155px 22px; align-items: center; column-gap: 16px; }
  .list-columns { padding: 11px 13px; color: var(--muted); font-size: 10px; border-bottom: 1px solid var(--border); }
  .document-row { width: 100%; min-height: 77px; padding: 14px 13px; text-align: left; background: transparent; border: 0; border-bottom: 1px solid var(--border); color: var(--text); font: inherit; cursor: pointer; }
  .document-row:hover { background: var(--row-hover); }
  .document-row.current { background: color-mix(in srgb, var(--accent-weak) 45%, transparent); }
  .document-row:focus-visible, .connection-row:focus-visible, .document-tabs button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .document-row:disabled, .connection-row:disabled { opacity: .6; cursor: default; }
  .document-identity { display: flex; min-width: 0; align-items: center; gap: 12px; }
  .database-icon { color: var(--muted); display: flex; flex: none; }
  .database-name { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .database-name > span { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .database-name strong { font: 500 13px var(--mono); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .database-name small { font-size: 10px; color: var(--muted); }
  .database-name .current-tag { flex: none; padding: 1px 5px; border-radius: 4px; background: var(--accent-weak); color: var(--accent); font-size: 9px; }
  .cache-cell { display: flex; flex-direction: column; gap: 5px; color: var(--muted); font-size: 11px; }
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
  .documents-footer { display: flex; flex: none; flex-wrap: wrap; justify-content: space-between; gap: 6px 16px; margin-top: 20px; color: var(--muted); font-size: 10px; }
  .first-use { flex: 1; }.first-use h1 { font-size: 20px; color: var(--text); }.first-use p { max-width: 380px; margin: 0; font-size: 13px; line-height: 1.9; }.first-use small { font-size: 11px; }
  .first-use-icon { display: grid; place-items: center; width: 64px; height: 64px; margin-bottom: 8px; border-radius: 15px; background: var(--accent-weak); color: var(--accent); }
  .name-editor { display: flex; flex-direction: column; gap: 9px; padding: 14px; margin: -9px 0 23px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg); font-size: 12px; }
  .name-editor label { font-weight: 600; }.name-editor-controls { display: flex; gap: 7px; }.name-editor input { flex: 1; min-width: 0; padding: 8px 10px; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 5px; font: inherit; }.name-editor input:focus { outline: 2px solid var(--accent-weak); border-color: var(--accent); }.name-editor .btn { font-size: 11px; }.name-editor small { color: var(--muted); }.name-editor p { margin: 0; color: var(--danger); }
  .connection-diagnostics { flex: none; padding-top: 15px; color: var(--muted); font-size: 10px; }.connection-diagnostics code { display: block; overflow-wrap: anywhere; }
  .spinning { animation: spin 1s linear infinite; }@keyframes spin { to { transform: rotate(360deg); } }
  @media(max-width:1000px) { .switcher-body { grid-template-columns: 218px minmax(0,1fr); }.documents-pane { padding: 26px 22px 18px; }.list-columns, .document-row { grid-template-columns: minmax(0,1fr) 112px 125px 18px; column-gap: 10px; }.database-name .current-tag { display: none; } }
  @media(max-width:800px) { .date-column { display: none; }.mobile-date { display: block; }.list-columns, .document-row { grid-template-columns: minmax(0,1fr) 118px 18px; }.documents-toolbar { flex-wrap: wrap; gap: 10px; }.database-search { width: 100%; } }
  @media(max-width:600px) { .switcher-topbar { padding: 10px 16px; min-height: 54px; }.topbar-separator, .topbar-separator + span { display: none; }.switcher-body { display: flex; flex-direction: column; }.connections-pane { flex: none; padding: 16px; border-right: 0; border-bottom: 1px solid var(--border); }.pane-title { margin: 0 0 12px; }.connections-list { flex-direction: row; overflow-x: auto; flex: none; margin: 10px -2px 0; gap: 7px; }.connection-row { width: 205px; flex: none; min-height: 58px; border-color: var(--border); }.connections-help { display: none; }.documents-pane { flex: 1; padding: 23px 16px 20px; overflow: visible; }.documents-heading { margin-bottom: 22px; gap: 10px; align-items: flex-start; }h1 { font-size: 18px; }.connection-title { gap: 6px; }.heading-label { font-size: 10px; }.documents-heading p { font-size: 11px; line-height: 1.8; }.list-refresh { font-size: 11px; padding: 6px 8px; }.document-tabs { gap: 16px; }.list-columns, .document-row { grid-template-columns: minmax(0,1fr) 111px 16px; column-gap: 8px; }.list-columns { padding: 10px 6px; }.document-row { min-height: 78px; padding: 12px 6px; }.database-icon { display: none; }.database-name strong { font-size: 12px; }.database-name small { font-size: 9px; line-height: 1.5; }.documents-footer { font-size: 9px; }.first-use { min-height: 260px; padding: 30px 12px; } }
</style>
