<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte'
  import { loadRecent, rememberConnection, type RecentConnection } from '../../lib/recent'
  import { cleanConnectionName, connectionLabel, connectionSubtitle } from '../../lib/connectionLabels'
  import { groupConnections, mergeDatabases, connectionMatches, currentSessionDatabase, verifyDatabaseSession, type ResourceConnection } from '../../lib/resources'
  import { getAdapter, normalizeDbType } from '../../lib/dialects/registry'
  import { listDatabases } from '../../lib/store'
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
  const selectedLabel = $derived(selected ? connectionLabel(labelContext(selected), connections.indexOf(selected) + 1) : '')
  const selectedSubtitle = $derived(selected ? connectionSubtitle(labelContext(selected)) : '')
  const visibleDatabases = $derived(databases.filter((database) => database.toLocaleLowerCase().includes(databaseQuery.trim().toLocaleLowerCase())))
  const activeDatabase = $derived(selectedId === context.connectionId ? context.database : undefined)

  function labelContext(connection: ResourceConnection) {
    return { ...connection,
      databases: connection.connectionId === selectedId ? mergeDatabases(connection.databases, databases) : connection.databases,
      table: connection.connectionId === context.connectionId ? context.table : undefined }
  }
  function connectionDatabaseHint(connection: ResourceConnection) {
    if (connection.connectionId === selectedId && databases.length) return `${databases.length} 个数据库`
    if (connection.databases.length) return `${connection.databases.length} 个最近数据库`
    return connection.connectionId === selectedId && databaseLoading ? '正在读取数据库' : '选择后查看数据库'
  }

  onMount(() => {
    let alive = true
    void loadRecent(getBridge()).catch(() => []).then((entries) => {
      if (!alive) return
      recent = entries
      loading = false
      if (!selectedId && context.connectionId) void selectConnection(context.connectionId)
    })
    return () => { alive = false }
  })
  onDestroy(() => { request += 1; nameRequest += 1 })

  async function selectConnection(connectionId: string) {
    if (nameSaving) return
    const connection = connections.find((entry) => entry.connectionId === connectionId)
    if (!connection) return
    const seq = ++request
    selectedId = connectionId
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
      if (seq === request) databases = mergeDatabases(connection.databases, available)
    } catch (err) {
      if (seq !== request) return
      databaseError = maskUuids(err instanceof Error ? err.message : String(err))
      denied = isDataAccessDenied(err)
      connectionClosed = isConnectionNotOpen(err)
      failureDatabase = queryDatabase
    } finally { if (seq === request) databaseLoading = false }
  }

  async function open(database?: string) {
    if (!selected || !supported || !resolvedType || openingDatabase !== null || nameSaving) return
    const seq = ++request
    const next = { connectionId: selected.connectionId, name: selected.name, dbType: resolvedType, database }
    databaseLoading = false
    openingDatabase = database ?? ''
    databaseError = ''
    connectionClosed = false
    denied = false
    openFailed = false
    try {
      const bridge = getBridge()
      if (!bridge) throw new Error('请在 DBX 中打开数据库文档')
      await verifyDatabaseSession(bridge, next.connectionId, database)
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
  function retryFailure() { if (openFailed) void open(failureDatabase); else void selectConnection(selectedId) }
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

<section class="resource-page" role={onclose ? 'dialog' : 'region'} aria-modal={onclose ? true : undefined}
  aria-label="选择连接与数据库" use:focusPicker>
  <header class="resource-topbar">
    <div class="product-brand"><span class="brand-symbol"><Icon name="database" size={21} /></span><span>数据库文档<small>数据字典工作台</small></span></div>
    {#if onclose}<button class="btn" disabled={nameSaving} onclick={onclose}><Icon name="back" size={15} />{returnLabel}</button>{/if}
  </header>
  <div class="resource-area">
    <div class="resource-intro"><div><span class="eyebrow">{onclose ? '继续浏览' : '开始浏览'}</span><h1>{onclose ? '切换连接与数据库' : '打开数据字典'}</h1><p>选一个连接，点击数据库即可进入文档。</p></div>
      {#if context.database}<span class="current-location"><span class="status-dot"></span>当前：{context.database}</span>{/if}
    </div>
    <div class="resource-browser" class:has-error={Boolean(databaseError)} class:has-editor={editingName}>
      <aside class="resource-sidebar" aria-label="连接列表">
        <div class="pane-heading"><h2>连接</h2><span class="count-label">{connections.length}</span></div>
        <div class="resource-search"><Icon name="search" size={16} /><input type="search" aria-label="搜索连接" placeholder="搜索连接或最近数据库" bind:value={connectionQuery} /></div>
        <div class="connection-list">
          {#if loading}<div class="picker-loading" role="status"><span class="spinner"></span>正在加载连接…</div>{/if}
          {#each visibleConnections as connection (connection.connectionId)}
            <button class="resource-connection" class:selected={selectedId === connection.connectionId}
              aria-pressed={selectedId === connection.connectionId} disabled={nameSaving} onclick={() => void selectConnection(connection.connectionId)}>
              <span class="connection-symbol"><Icon name="server" size={19} /></span>
              <span class="connection-info"><strong title={connectionLabel(labelContext(connection), connections.indexOf(connection) + 1)}>{connectionLabel(labelContext(connection), connections.indexOf(connection) + 1)}</strong>
                {#if connectionSubtitle(labelContext(connection))}<small class="connection-name" title={connection.name}>{connection.name}</small>{/if}
                <small>{connection.dbType ? connection.dbType.toUpperCase() : '数据库连接'} · {connectionDatabaseHint(connection)}</small></span>
              <Icon name="chevron" size={14} />
            </button>
          {/each}
          {#if !loading && !visibleConnections.length}<div class="list-empty">{connectionQuery ? '没有匹配的连接' : '还没有最近使用的连接'}</div>{/if}
        </div>
        <p class="connection-footnote">从 DBX 右键打开过的连接会出现在这里。</p>
      </aside>

      <main class="resource-main">
        {#if selected}
          <div class="database-heading"><div><span class="eyebrow connection-label" title={selectedLabel}>{selectedLabel}</span>{#if selectedSubtitle}<small class="connection-caption" title={selectedSubtitle}>{selectedSubtitle}</small>{/if}<h2>选择数据库<span class="engine-tag">{resolvedType.toUpperCase()}</span></h2></div>
            <div class="database-heading-actions"><button class="text-btn" bind:this={nameEditButton} aria-label="修改连接显示名称" disabled={nameSaving || openingDatabase !== null} onclick={() => void editName()}><Icon name="edit" size={14} />修改连接名称</button>
              <button class="icon-btn" aria-label="刷新数据库列表" title="刷新数据库列表" disabled={databaseLoading || openingDatabase !== null || nameSaving} onclick={() => void selectConnection(selectedId)}><Icon name="refresh" size={17} /></button></div>
          </div>
          {#if editingName}<form class="connection-name-editor" onsubmit={(event) => { event.preventDefault(); void saveName() }}>
            <label for="connection-display-name">连接显示名称</label><input id="connection-display-name" bind:this={nameInput} bind:value={nameDraft} oninput={() => (nameError = '')} maxlength="80" autocomplete="off" disabled={nameSaving} placeholder="例如：业务开发环境" />
            <div class="name-editor-footer"><span>只修改本插件中的显示名称。</span><div><button type="button" class="btn" disabled={nameSaving} onclick={cancelNameEdit}>取消</button><button class="btn btn-primary" type="submit" disabled={nameSaving}>{nameSaving ? '保存中…' : '保存名称'}</button></div></div>
            {#if nameError}<p role="alert">{nameError}</p>{/if}
          </form>{/if}
          <div class="resource-search database-search"><Icon name="search" size={17} /><input type="search" aria-label="搜索数据库" placeholder="搜索数据库名称…" bind:value={databaseQuery} /><span>{databaseQuery.trim() ? `${visibleDatabases.length} / ` : ''}{databases.length} 个</span></div>
          {#if databaseError}<div class="picker-error" class:connection-needed={connectionClosed} role={connectionClosed ? 'status' : 'alert'}>
            {#if connectionClosed}<strong>请先打开 DBX 数据库会话</strong><span>「{selectedSubtitle || selectedLabel}」{failureDatabase ? ` / ${failureDatabase}` : ''} 当前没有可用的已打开会话。</span>
              <span>在 DBX 连接树中连接该连接并打开{failureDatabase ? `「${failureDatabase}」` : '目标数据库'}，然后返回这里重试；也可从已打开表的右键菜单选择「查看表文档」。</span>
            {:else}<strong>{openFailed ? '暂时无法打开数据库文档' : !supported ? '暂不支持该数据库类型' : '暂时无法读取数据库列表'}</strong><span>{databaseError}</span>
              {#if denied}<span>若本次会话已拒绝授权，请关闭并重新打开工作台，在 DBX 提示中允许访问。</span>{:else}<span>确认 DBX 中的连接状态后重试。</span>{/if}
            {/if}
            <button class="text-btn" disabled={openingDatabase !== null} onclick={retryFailure}>{connectionClosed ? '已在 DBX 打开，重试' : '重新读取'}</button></div>{/if}
          {#if databaseLoading}<div class="database-loading" role="status"><span class="spinner"></span>正在读取数据库…</div>{/if}
            <div class="database-grid">
              {#each visibleDatabases as database (database)}
                <button class="database-card" class:opening={openingDatabase === database} disabled={!supported || !resolvedType || openingDatabase !== null || nameSaving} onclick={() => void open(database)} aria-label={`打开数据库 ${database}`}>
                  <span class="database-symbol"><Icon name="database" size={23} /></span>
                  <span class="database-card-info"><strong title={database}>{database}</strong><span>{openingDatabase === database ? '正在打开文档…' : activeDatabase === database ? '当前打开' : selected.databases.includes(database) ? '最近使用 · 点击打开' : '查看数据字典'}</span></span>
                  {#if openingDatabase === database}<span class="spinner"></span>{:else if activeDatabase === database}<span class="database-active"><Icon name="check" size={14} /></span>{:else}<span class="database-arrow"><Icon name="arrow" size={17} /></span>{/if}
                </button>
              {/each}
              {#if useCurrent && !databaseQuery}<button class="database-card" disabled={openingDatabase !== null || nameSaving} onclick={() => void open()}><span class="database-symbol"><Icon name="database" size={23} /></span><span class="database-card-info"><strong>当前数据库会话</strong><span>{openingDatabase === '' ? '正在打开文档…' : '查看已连接数据库的文档'}</span></span><Icon name="arrow" size={17} /></button>{/if}
            </div>
            {#if !visibleDatabases.length && (!useCurrent || databaseQuery) && !databaseError && !databaseLoading}<div class="database-empty"><Icon name="database" size={32} /><strong>{databaseQuery ? '没有匹配的数据库' : '没有读取到数据库'}</strong><p>{databaseQuery ? '试试其他名称，或清空搜索。' : '在 DBX 中打开该连接的数据库会话后，刷新列表。'}</p></div>{/if}
          <div class="database-footer"><Icon name="arrow" size={14} />点击数据库直接进入，无需再次确认。</div>
        {:else}
          <div class="resource-welcome"><span class="welcome-symbol"><Icon name="database" size={36} /></span><h2>{connections.length ? '你的数据库文档，从这里开始' : '从 DBX 打开第一个连接'}</h2>
            <p>{connections.length ? '从左侧选择连接，在这里浏览它的数据库。' : '在 DBX 的连接上右键，选择「查看数据库文档」。下次打开时，可以直接从这里继续。'}</p>
            <div class="welcome-features"><span><Icon name="table" size={17} />字段与注释</span><span><Icon name="grid" size={17} />索引与约束</span><span><Icon name="export" size={17} />文档导出</span></div>
          </div>
        {/if}
      </main>
    </div>
    <footer class="resource-help"><span>也可以从 DBX 的表右键菜单直接打开表文档。</span>
      {#if diagnostics}<details><summary>连接诊断</summary><code>{diagnostics}</code></details>{/if}
    </footer>
  </div>
</section>

<style>
  .connection-label { display: block; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .connection-name, .connection-caption { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .connection-caption { display: block; max-width: 360px; margin-top: 3px; font-size: 11px; color: var(--muted); }
  .database-heading > div:first-child { min-width: 0; }
  .database-heading-actions { display: flex; align-items: center; gap: 12px; flex: none; }
  .database-heading-actions .text-btn { display: flex; align-items: center; gap: 5px; white-space: nowrap; }
  .connection-name-editor { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 14px; margin: -4px 0 16px; background: var(--bg); border: 1px solid var(--border); border-radius: 9px; }
  .connection-name-editor label { font-size: 12px; font-weight: 600; }
  .connection-name-editor input { width: 100%; min-width: 0; padding: 9px 11px; border: 1px solid var(--border); border-radius: 7px; background: var(--panel); color: var(--text); font: inherit; font-size: 13px; outline: none; }
  .connection-name-editor input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak); }
  .name-editor-footer { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
  .name-editor-footer > span { font-size: 11px; color: var(--muted); }
  .name-editor-footer > div { display: flex; gap: 8px; }
  .connection-name-editor p { margin: 0; font-size: 12px; color: var(--danger); }
  .picker-error.connection-needed { border-left-color: var(--accent); }
  .resource-browser.has-editor { height: clamp(550px, calc(100dvh - 200px), 780px); }
  .resource-browser.has-editor.has-error { height: clamp(640px, calc(100dvh - 150px), 840px); }
  .database-card.opening:disabled { opacity: 1; background: var(--accent-weak); border-color: var(--accent); }
  .resource-browser.has-error { height: clamp(510px, calc(100dvh - 230px), 720px); }
  .resource-page { height: 100%; min-height: 0; overflow: auto; background: var(--bg); }
  .resource-topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 28px; background: var(--panel); border-bottom: 1px solid var(--border); }
  .resource-area { max-width: 1140px; margin: 0 auto; padding: 30px 28px 24px; }
  .resource-intro { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 24px; }
  h1 { font-size: 26px; font-weight: 650; letter-spacing: -.7px; margin: 5px 0 6px; } h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .resource-intro p { margin: 0; font-size: 13px; color: var(--muted); }
  .current-location { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; max-width: 40%; overflow-wrap: anywhere; }
  .resource-browser { display: grid; grid-template-columns: 286px minmax(0, 1fr); height: clamp(410px, calc(100dvh - 310px), 620px); border: 1px solid var(--border); border-radius: 16px; background: var(--panel); overflow: hidden; box-shadow: var(--shadow-sm); }
  .resource-sidebar { display: flex; flex-direction: column; min-height: 0; background: color-mix(in srgb, var(--bg) 72%, var(--panel)); padding: 20px 14px 14px; border-right: 1px solid var(--border); min-width: 0; }
  .pane-heading { display: flex; gap: 10px; align-items: center; margin: 0 6px 16px; }.count-label { background: var(--chip-bg); border-radius: 5px; color: var(--muted); font: 11px var(--mono); padding: 1px 6px; }
  .resource-search { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: var(--muted); }
  .resource-search:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak); }.resource-search input { min-width: 0; width: 100%; border: 0; background: transparent; color: var(--text); outline: none; font: inherit; font-size: 12px; }
  .connection-list { display: flex; flex: 1; min-height: 0; flex-direction: column; gap: 5px; margin: 14px 0; overflow: auto; }
  .resource-connection { display: flex; align-items: center; gap: 11px; padding: 13px 10px; border: 1px solid transparent; border-radius: 9px; color: var(--text); background: transparent; text-align: left; cursor: pointer; font: inherit; width: 100%; }
  .resource-connection:hover { background: var(--panel); }.resource-connection.selected { background: var(--panel); border-color: var(--border); box-shadow: var(--shadow-sm); }.resource-connection.selected .connection-symbol { color: var(--accent); background: var(--accent-weak); }
  .connection-symbol { display: flex; align-items: center; justify-content: center; width: 34px; height: 36px; flex: none; border-radius: 8px; color: var(--muted); background: var(--chip-bg); }.connection-info { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; }.connection-info strong { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.connection-info small { color: var(--muted); font-size: 10px; }.resource-connection > :global(svg) { color: var(--muted); }
  .connection-footnote { font-size: 11px; color: var(--muted); line-height: 1.7; margin: 14px 6px 0; }.list-empty { color: var(--muted); font-size: 12px; padding: 22px 10px; }
  .resource-main { display: flex; flex-direction: column; padding: 25px 28px 20px; min-width: 0; min-height: 0; }.database-heading { display: flex; flex: none; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 20px; }.database-heading h2 { display: flex; align-items: center; gap: 10px; font-size: 19px; margin-top: 5px; }.engine-tag { font: 10px var(--mono); padding: 2px 6px; border: 1px solid var(--border); border-radius: 5px; color: var(--muted); }.database-search { flex: none; padding: 10px 12px; margin-bottom: 18px; background: var(--bg); }.database-search input { font-size: 13px; }.database-search > span { font-size: 11px; white-space: nowrap; }
  .database-grid { display: grid; flex: 1; min-height: 0; align-content: start; overflow: auto; overscroll-behavior: contain; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 12px; }.database-card { display: flex; align-items: center; gap: 13px; text-align: left; padding: 19px 15px; border: 1px solid var(--border); background: var(--panel); border-radius: 11px; color: var(--text); font: inherit; cursor: pointer; min-width: 0; transition: border-color .15s, background .15s, box-shadow .15s; }.database-card:hover { border-color: color-mix(in srgb, var(--accent) 48%, var(--border)); background: var(--accent-weak); box-shadow: var(--shadow-sm); }.database-card:disabled { opacity: .5; cursor: default; }
  .database-symbol { color: var(--accent); }.database-card-info { display: flex; flex-direction: column; min-width: 0; flex: 1; gap: 6px; }.database-card-info strong { font: 600 13px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.database-card-info > span { color: var(--muted); font-size: 11px; }.database-active { color: var(--accent); border-radius: 50%; padding: 3px; background: var(--accent-weak); }.database-arrow { color: var(--muted); }.database-card:hover .database-arrow { color: var(--accent); }
  .database-footer { display: flex; gap: 7px; align-items: center; color: var(--muted); font-size: 11px; margin-top: auto; padding-top: 30px; }.database-loading, .picker-loading { display: flex; gap: 10px; align-items: center; color: var(--muted); padding: 36px 8px; }.picker-loading { padding: 14px 8px; font-size: 12px; }.database-empty { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 34px 14px; color: var(--muted); text-align: center; }.database-empty p { font-size: 12px; margin: 0; }
  .picker-error { display: flex; flex: none; flex-direction: column; gap: 7px; background: var(--bg); border-left: 3px solid var(--danger); padding: 12px 14px; margin-bottom: 18px; font-size: 12px; overflow-wrap: anywhere; color: var(--muted); }.picker-error strong { color: var(--text); }.picker-error .text-btn { align-self: flex-start; padding: 0; margin-top: 2px; }
  .resource-welcome { display: flex; flex: 1; align-items: center; justify-content: center; flex-direction: column; text-align: center; min-height: 315px; padding: 28px 8px; }.welcome-symbol { display: flex; justify-content: center; align-items: center; width: 76px; height: 76px; background: var(--accent-weak); color: var(--accent); border-radius: 20px; margin-bottom: 22px; }.resource-welcome h2 { font-size: 18px; }.resource-welcome p { max-width: 350px; color: var(--muted); line-height: 1.9; margin: 12px 0 24px; }.welcome-features { display: flex; gap: 20px; flex-wrap: wrap; justify-content: center; color: var(--muted); font-size: 11px; }.welcome-features > span { display: flex; align-items: center; gap: 6px; }
  .resource-help { display: flex; justify-content: space-between; gap: 14px; margin-top: 18px; color: var(--muted); font-size: 11px; }.resource-help code { display: block; max-width: 300px; overflow-wrap: anywhere; }.resource-help summary { cursor: pointer; }
  @media(max-width:760px) { .resource-area { padding: 22px 16px; }.resource-topbar { padding: 14px 18px; }.resource-intro { align-items: flex-start; flex-direction: column; gap: 10px; }h1 { font-size: 23px; }.current-location { max-width: 100%; }.resource-browser { grid-template-columns: 1fr; height: auto; }.resource-sidebar { border-right: 0; border-bottom: 1px solid var(--border); padding: 16px; }.connection-list { flex: none; max-height: 190px; margin: 10px 0; }.connection-footnote { display: none; }.resource-main { padding: 22px 18px; }.database-grid { flex: none; grid-template-columns: 1fr; max-height: 380px; }.resource-help { flex-direction: column; }.welcome-features { gap: 12px; }.resource-welcome { min-height: 260px; } }
  @media(max-width:760px) { .resource-browser.has-error, .resource-browser.has-editor, .resource-browser.has-editor.has-error { height: auto; } }
</style>
