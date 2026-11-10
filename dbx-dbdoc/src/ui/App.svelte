<script lang="ts">
  import { onMount } from 'svelte'
  import { getBridge, isDataAccessDenied, isConnectionNotOpen, onUnrecognizedContext } from '../lib/bridge'
  import { getAdapter, normalizeDbType } from '../lib/dialects/registry'
  import { connKeyOf, createSessionCache, loadCatalog, loadDetail } from '../lib/store'
  import { loadOffline, saveOffline, finishOfflineSync, cacheAllTables, searchOfflineColumnMatches, withOfflineDetail, offlineTableKey, type OfflineDocument, type OfflineSyncIssue } from '../lib/offline'
  import { loadRecent, rememberConnection, contextWithRecent } from '../lib/recent'
  import { cleanConnectionName, connectionLabel, connectionSubtitle } from '../lib/connectionLabels'
  import { databaseDocumentTitle } from '../lib/workbenchTitle'
  import { maskUuids } from '../lib/display/masking'
  import type { PluginContext } from '../lib/types'
  import type { DbTable } from '../lib/dialects/entities'
  import { createAppState } from './state.svelte'
  import Catalog from './components/Catalog.svelte'
  import Detail from './components/Detail.svelte'
  import EmptyState from './components/EmptyState.svelte'
  import ExportDialog from './components/ExportDialog.svelte'
  import Guide from './components/Guide.svelte'
  import SnapshotDirectoryDialog from './components/SnapshotDirectoryDialog.svelte'
  import Header from './components/Header.svelte'
  import SqlDialog from './components/SqlDialog.svelte'
  import SidebarResize from './components/SidebarResize.svelte'
  import Icon from './components/Icon.svelte'
  import QueryWorkbench from './components/QueryWorkbench.svelte'
  import { TABLE_QUERY_WORKBENCH_ID } from '../lib/tableQuery'
  import './styles.css'

  const app = createAppState()
  const cache = createSessionCache()
  let offlineDocument = $state.raw<OfflineDocument | null>(null)
  let offlineVersion = $state(0)
  let syncIssues = $state<OfflineSyncIssue[]>([])
  let syncBusy = $state(false)
  let syncDone = $state(0)
  let syncFailed = $state(0)
  let syncTotal = $state(0)
  let cachedTableCount = $state(0)
  let syncSeq = 0
  let sqlOpen = $state(false)
  let exportOpen = $state(false)
  let snapshotOpen = $state(false)
  let snapshotChanged = $state(0)
  let pickerOpen = $state(false)
  let pickerCacheChanged = false
  let queryMode = $state(false)
  let hostInitialized = $state(false)
  let exportMode = $state<'table' | 'schema'>('table')
  let sidebarWidth = $state(304)
  let bootSeq = 0
  let catalogSeq = 0
  let disposed = false
  let offContext: (() => void) | undefined
  let gotContextEvent = false
  let lastHostContext: PluginContext | undefined
  const refOf = (ctx: PluginContext) => ({ db: ctx.database ?? null, schema: null, table: null })

  function select(row: DbTable) {
    app.navigateTable(row.table_schema, row.table_name)
  }

  function targetRow(ctx: PluginContext, rows: DbTable[]) {
    if (!ctx.table) return null
    const scoped = ctx.schema ? rows.filter((t) => t.table_schema === ctx.schema) : rows
    return scoped.find((t) => t.table_name === ctx.table)
      ?? scoped.find((t) => t.table_name.toLowerCase() === ctx.table!.toLowerCase()) ?? null
  }

  async function refreshCatalog() {
    if (app.catalogRefreshing || syncBusy) return
    const bridge = getBridge()
    const ctx = { ...app.ctx }
    if (!bridge || !ctx.connectionId) return
    const location = await bridge.getSnapshotDirectoryStatus?.()
    if (location && location.status !== 'ready') { snapshotOpen = true; return }
    const previous = offlineDocument
    const seq = ++catalogSeq
    const sync = ++syncSeq
    const active = () => !disposed && seq === catalogSeq && sync === syncSeq
    const ref = refOf(ctx)
    app.catalogRefreshing = true
    app.catalogError = ''
    app.storageError = ''
    app.offline = true
    app.phase = 'ready'
    syncIssues = []
    syncDone = 0
    syncFailed = 0
    syncTotal = 0
    try {
      let type = normalizeDbType(ctx.dbType ?? app.dbType)
      if (type === 'unknown' && !ctx.dbType) {
        const probe = await bridge.queryData({ connectionId: ctx.connectionId, database: ctx.database, sql: 'SELECT 1', maxRows: 1 })
        if (!active()) return
        type = normalizeDbType(probe.dbType)
      }
      const adapter = getAdapter(type)
      if (!adapter) {
        if (ctx.table && bridge.capabilities?.schemaMetadataApi) {
          app.degraded = true
          app.offline = false
          app.navigateTable(ctx.schema ?? null, ctx.table)
          app.phase = 'ready'
          return
        }
        throw new Error('该数据库类型暂不支持完整文档')
      }
      ctx.dbType = type
      // All fetched metadata stays private until the complete snapshot is saved.
      const catalog = await loadCatalog(bridge, adapter, ctx.connectionId, ref)
      if (!active()) return
      let staged: OfflineDocument = { version: 1, savedAt: Date.now(), catalog, details: {} }
      syncBusy = true
      syncTotal = catalog.tables.length
      await cacheAllTables(catalog.tables,
        (table) => loadDetail(bridge, adapter, ctx.connectionId!, ref, table.table_schema, table.table_name), {
          shouldContinue: active,
          onIssue: (issue) => { if (active()) syncIssues = [...syncIssues, issue] },
          onProgress: (done, failed) => { if (active()) { syncDone = done; syncFailed = failed } },
          onDetail: (detail) => { if (active()) staged = withOfflineDetail(staged, detail) }
        })
      if (!active()) return
      const committed = await finishOfflineSync(staged, syncDone, syncFailed,
        (document) => active() ? persistOffline(bridge, ctx, document) : Promise.resolve(false), previous, active)
      if (!active()) return
      if (!committed || committed === previous) {
        app.catalogError = catalog.truncated ? '表目录未能完整读取，本次刷新未替换本地缓存。'
          : app.storageError || '整库同步未完成，本次刷新未替换本地缓存。'
        return
      }
      offlineDocument = committed
      cache.clear(connKeyOf(ctx.connectionId, ref))
      app.dbType = type
      app.ctx.dbType = type
      void rememberConnection(bridge, ctx).catch(() => undefined)
      app.offlineSavedAt = committed.savedAt
      offlineVersion += 1
      cachedTableCount = Object.keys(committed.details).length
      app.catalog = committed.catalog.tables
      app.truncated = committed.catalog.truncated
      app.schemas = [...new Set(app.catalog.map((table) => table.table_schema))].sort()
      if (app.schemaFilter && !app.schemas.includes(app.schemaFilter)) app.schemaFilter = null
      const current = app.catalog.find((table) => table.table_name === app.selectedTable && table.table_schema === app.selectedSchema)
      const targetContext = { ...app.ctx, table: app.ctxTargetTable ?? app.ctx.table,
        schema: app.ctxTargetTable ? app.selectedSchema ?? undefined : app.ctx.schema }
      const target = targetRow(targetContext, app.catalog)
      if (current) select(current)
      else if (target) select(target)
      else if (targetContext.table) {
        app.navigateTable(targetContext.schema ?? null, targetContext.table)
        app.ctxTargetTable = targetContext.table
      } else if (app.catalog[0]) select(app.catalog[0])
      else { app.selectedTable = null; app.selectedSchema = null; app.detail = null }
      app.errorMessage = ''
      app.revision += 1
    } catch (err) {
      if (!active()) return
      // A failed refresh never replaces the visible or persistent document.
      app.catalogError = err instanceof Error ? err.message : String(err)
    } finally {
      if (active()) { app.catalogRefreshing = false; syncBusy = false }
    }
  }

  function syncAllDocuments() { return refreshCatalog() }

  async function persistOffline(bridge: NonNullable<ReturnType<typeof getBridge>>, ctx: PluginContext, doc: OfflineDocument) {
    let storageMessage = ''
    const saved = await saveOffline(bridge, ctx, doc, (message) => { storageMessage = message })
    if (!disposed && ctx.connectionId === app.ctx.connectionId && ctx.database === app.ctx.database) {
      app.storageError = saved ? '' : `离线文档未能保存到本地：${maskUuids(storageMessage || '当前 DBX 不支持持久存储')}。请检查存储支持或可用空间后刷新。`
    }
    return saved
  }

  async function boot() {
    const seq = ++bootSeq
    catalogSeq += 1
    syncSeq += 1
    syncBusy = false
    syncDone = 0
    syncFailed = 0
    syncIssues = []
    syncTotal = 0
    cachedTableCount = 0
    app.catalogRefreshing = false
    app.catalogError = ''
    app.offline = false
    app.offlineSavedAt = 0
    app.offlineDetailAt = 0
    app.storageError = ''
    offlineDocument = null
    offlineVersion += 1
    app.resetHistory()
    sqlOpen = false
    exportOpen = false
    pickerOpen = false
    app.catalog = []
    app.schemas = []
    app.schemaFilter = null
    app.selectedTable = null
    app.selectedSchema = null
    app.ctxTargetTable = null
    app.detail = null
    app.detailLoading = false
    app.errorMessage = ''
    app.degraded = false
    app.columnHits = new Set()
    if (!app.ctx.connectionId) { app.phase = 'guide'; return }
    app.phase = 'booting'
    const bridge = getBridge()
    if (!bridge) { app.phase = 'error'; app.errorMessage = '请在 DBX 中打开数据库文档插件'; return }
    let ctx = { ...app.ctx }
    try {
      // 在连接入口进入引导或查询失败之前保存名称，表入口缺少名称时继承同连接的记录。
      const recent = await rememberConnection(bridge, ctx).catch(() => loadRecent(bridge).catch(() => []))
      if (seq !== bootSeq || disposed) return
      // 等待存储时宿主可能已更新名称，旧读取结果不能覆盖刚收到的名称。
      ctx = contextWithRecent({ ...ctx, name: app.ctx.name }, recent)
      app.ctx = ctx
      const normalized = normalizeDbType(ctx.dbType ?? '')
      app.dbType = normalized === 'unknown' ? ctx.dbType ?? '' : normalized
      if (normalized !== 'unknown') app.ctx = { ...app.ctx, dbType: normalized }
      const adapter = getAdapter(normalized)
      if (!ctx.database && adapter?.listDatabases) { app.phase = 'guide'; return }
      const savedDocument = await loadOffline(bridge, app.ctx)
      if (seq !== bootSeq || disposed) return
      offlineDocument = savedDocument
      offlineVersion += 1
      app.offline = true
      app.offlineSavedAt = savedDocument?.savedAt ?? 0
      app.catalog = savedDocument?.catalog.tables ?? []
      app.truncated = savedDocument?.catalog.truncated ?? false
      app.schemas = [...new Set(app.catalog.map((table) => table.table_schema))].sort()
      cachedTableCount = Object.keys(savedDocument?.details ?? {}).length
      const target = targetRow(ctx, app.catalog)
      if (target) select(target)
      else if (ctx.table) {
        app.navigateTable(ctx.schema ?? null, ctx.table)
        app.ctxTargetTable = ctx.table
      } else if (app.catalog[0]) select(app.catalog[0])
      app.phase = 'ready'

    } catch (err) {
      if (disposed || seq !== bootSeq) return
      app.errorMessage = err instanceof Error ? err.message : String(err)
      app.phase = isDataAccessDenied(err) ? 'denied' : 'error'
    }
  }

  async function applyContext(next: PluginContext) {
    const ctx = next.connectionId === app.ctx.connectionId
      ? { ...next, name: cleanConnectionName(next.name, next.connectionId) || app.ctx.name, dbType: next.dbType ?? app.ctx.dbType } : next
    const same = (['connectionId', 'database', 'schema', 'table', 'dbType'] as const).every((key) => app.ctx[key] === ctx[key])
    if (same) {
      if (ctx.name !== app.ctx.name) {
        app.ctx.name = ctx.name
        void rememberConnection(getBridge(), ctx).catch(() => undefined)
      }
      return
    }
    // 同库的表右键只切换浏览目标，保留目录搜索与历史，不重新初始化整个工作台。
    if (app.phase === 'ready' && !app.degraded && ctx.connectionId === app.ctx.connectionId
      && ctx.database === app.ctx.database && normalizeDbType(ctx.dbType ?? '') === app.dbType) {
      app.ctx.name = ctx.name
      app.ctx.schema = ctx.schema
      app.ctx.table = ctx.table
      app.ctx.dbType = ctx.dbType
      void rememberConnection(getBridge(), ctx).catch(() => undefined)
      if (ctx.table) {
        const row = targetRow(ctx, app.catalog)
        if (row) app.navigateTable(row.table_schema, row.table_name, 'columns')
        else { app.navigateTable(ctx.schema ?? null, ctx.table, 'columns'); app.ctxTargetTable = ctx.table }
      }
      return
    }
    app.ctx = ctx
    await boot()
  }

  // 插件内切库后，宿主重复发送原快照不应覆盖用户选择；只响应真正变化的宿主上下文。
  function receiveContext(next: PluginContext) {
    if (lastHostContext && (['connectionId', 'database', 'schema', 'table', 'dbType', 'name'] as const)
      .every((key) => lastHostContext![key] === next[key])) return
    lastHostContext = { ...next }
    if (queryMode) { app.ctx = { ...next }; return }
    void applyContext(next)
  }

  async function applyTheme() {
    const theme = await getBridge()?.getTheme()
    if (!disposed && (theme === 'dark' || theme === 'light')) document.documentElement.dataset.theme = theme
  }

  async function initApp() {
    hostInitialized = false
    const bridge = getBridge()
    if (!bridge) { app.phase = 'error'; app.errorMessage = '请在 DBX 中打开数据库文档插件'; return }
    try {
      offContext?.()
      gotContextEvent = false
      let initialized = false
      let pendingContext: PluginContext | null = null
      offContext = bridge.onContextChange((next) => {
        gotContextEvent = true
        if (!initialized) pendingContext = next
        else receiveContext(next)
      })
      await bridge.ready()
      if (disposed) return
      await applyTheme()
      queryMode = bridge.getContributionId?.() === TABLE_QUERY_WORKBENCH_ID
      if (queryMode) {
        const ctx = await bridge.getContext()
        if (disposed) return
        lastHostContext = { ...(pendingContext ?? ctx ?? {}) }
        initialized = true
        app.ctx = { ...lastHostContext }
        app.phase = 'ready'
        return
      }
      await bridge.getSnapshotDirectoryStatus?.()
      const width = Number(await bridge.storageGet('dbdoc.sidebarWidth').catch(() => null))
      if (width >= 224 && width <= 520) sidebarWidth = width
      const ctx = await bridge.getContext()
      if (disposed) return
      lastHostContext = { ...(pendingContext ?? ctx ?? {}) }
      initialized = true
      app.ctx = { ...lastHostContext }
      hostInitialized = true
      await boot()
    } catch (err) {
      if (!disposed) { app.phase = 'error'; app.errorMessage = `初始化失败：${err instanceof Error ? err.message : String(err)}` }
    }
  }

  onMount(() => {
    void initApp()
    const offDiagnostic = onUnrecognizedContext((message) => { app.diagMessage = message ?? '' })
    const onEnv = () => { void applyTheme() }
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      void applyTheme()
      if (!gotContextEvent) void getBridge()?.getContext().then((ctx) => { if (ctx) receiveContext(ctx) }).catch(() => undefined)
    }
    window.addEventListener('dbx-plugin-env', onEnv)
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      disposed = true
      bootSeq += 1
      catalogSeq += 1
      syncSeq += 1
      offContext?.()
      offDiagnostic()
      window.removeEventListener('dbx-plugin-env', onEnv)
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  })

  // 依赖变更立即使旧请求失效；异步加载只消费派发时的上下文快照。
  $effect(() => {
    if (queryMode) return
    const table = app.selectedTable
    const schema = app.selectedSchema ?? ''
    const connectionId = app.ctx.connectionId
    const database = app.ctx.database
    const adapter = getAdapter(app.dbType)
    app.revision
    if (app.phase !== 'ready' || app.degraded || !table || !connectionId || !adapter) return
    const offline = app.offline
    const row = app.catalog.find((t) => t.table_name === table && t.table_schema === schema)
    const bridge = getBridge()
    if (!bridge) return
    const ref = { db: database ?? null, schema: null, table: null }
    let active = true
    app.detail = null
    app.detailLoading = true
    app.errorMessage = ''
    app.offlineDetailAt = 0
    if (offline) {
      offlineVersion
      const entry = offlineDocument?.details[offlineTableKey(schema, table)]
      app.detail = entry ? { ...entry.value, table: row ? { ...entry.value.table, ...row } : entry.value.table } : null
      app.offlineDetailAt = entry?.savedAt ?? 0
      app.detailLoading = false
      if (!entry) app.errorMessage = '此表的离线同步尚未完成。在 DBX 中连接并打开目标数据库，然后点击顶部「刷新」重新同步全部表。'
      return
    }
    const storedDetail = offlineDocument?.details[offlineTableKey(schema, table)]
    const cachedDetail = cache.detail(connKeyOf(connectionId, ref), schema, table)
      ?? (storedDetail && storedDetail.savedAt >= offlineDocument!.savedAt ? storedDetail.value : undefined)
    const timer = setTimeout(() => {
      void (cachedDetail ? Promise.resolve(cachedDetail) : loadDetail(bridge, adapter, connectionId, ref, schema, table, cache)).then((detail) => {
        if (!active || disposed) return
        app.detail = { ...detail, table: row ? { ...detail.table, ...row, column_count: detail.columns.length } : detail.table }

      }).catch((err) => {
        if (active && !disposed) {
          if (!isDataAccessDenied(err) && offlineDocument) {
            app.offline = true
            app.offlineSavedAt = offlineDocument.savedAt
          } else app.errorMessage = err instanceof Error ? err.message : String(err)
        }
      }).finally(() => { if (active && !disposed) app.detailLoading = false })
    }, cachedDetail ? 0 : 100)
    return () => { active = false; clearTimeout(timer) }
  })

  function retryDetail() {
    if (app.offline) { void refreshCatalog(); return }
    if (app.ctx.connectionId) cache.clear(connKeyOf(app.ctx.connectionId, refOf(app.ctx)))
    app.revision += 1
  }
  function chooseResource(ctx: PluginContext) {
    pickerOpen = false
    const cacheChanged = pickerCacheChanged
    pickerCacheChanged = false
    if (!cacheChanged && app.phase === 'ready' && ctx.connectionId === app.ctx.connectionId && ctx.database === app.ctx.database) {
      app.ctx.name = cleanConnectionName(ctx.name, ctx.connectionId) || app.ctx.name
      return
    }
    app.ctx = ctx
    void boot()
  }
  function changeResource() { pickerCacheChanged = false; pickerOpen = true }
  function closeResourcePicker() {
    pickerOpen = false
    if (pickerCacheChanged) { pickerCacheChanged = false; void boot() }
  }
  function openExport(mode: 'table' | 'schema') { exportMode = mode; exportOpen = true }
  function saveSidebar() { void getBridge()?.storageSet('dbdoc.sidebarWidth', String(sidebarWidth)).catch(() => undefined) }
  $effect(() => {
    if (queryMode) return
    const title = databaseDocumentTitle(app.ctx)
    document.title = title
    if (hostInitialized) void getBridge()?.setWorkbenchTitle?.(title)
  })
</script>

<div style="display: contents" inert={snapshotOpen}>
{#if queryMode && app.phase === 'ready'}
  <QueryWorkbench context={app.ctx} />
{:else if queryMode && app.phase === 'error'}
  <EmptyState icon="refresh" title="查询页初始化失败" description={maskUuids(app.errorMessage)} actionLabel="重试" onaction={() => void initApp()} />
{:else if app.phase === 'booting'}
  <div class="boot" role="status"><span class="spinner"></span>正在打开数据库文档…</div>
{:else if app.phase === 'guide'}
  <Guide onsnapshot={() => snapshotOpen = true} {snapshotChanged} context={app.ctx} diagnostics={app.diagMessage || null} onopen={chooseResource} syncBlocked={app.catalogRefreshing || syncBusy} />
{:else if app.phase === 'unsupported'}
  <EmptyState icon="database" title="暂不支持该数据库类型" description="{app.dbType} 暂不支持完整文档；可从具体表的右键菜单查看基础字段。" actionLabel="选择其他连接" onaction={changeResource} />
{:else if app.phase === 'denied'}
  <EmptyState icon="database" title="数据访问未授权" description={`${maskUuids(app.errorMessage)}\n若本次会话已拒绝授权，请关闭并重新打开工作台，在 DBX 的授权提示中允许访问。`} actionLabel="重试" onaction={() => void boot()} secondaryLabel="切换连接与数据库" onsecondary={changeResource} />
{:else if app.phase === 'error'}
  <EmptyState icon="refresh" title={isConnectionNotOpen(app.errorMessage) ? '请先打开 DBX 数据库会话' : '文档读取失败'}
    description={isConnectionNotOpen(app.errorMessage) ? `请在 DBX 连接树中连接「${connectionSubtitle(app.ctx) || connectionLabel(app.ctx)}」并打开${app.ctx.database ? `「${app.ctx.database}」` : '目标数据库'}，然后重试；也可从已打开表的右键菜单选择「查看表文档」。` : maskUuids(app.errorMessage)}
    actionLabel="重试" onaction={() => void (app.ctx.connectionId ? boot() : initApp())} secondaryLabel="切换连接与数据库" onsecondary={changeResource} />
{:else}
  <div class="layout" inert={sqlOpen || exportOpen || pickerOpen}>
    <Header onsnapshot={() => snapshotOpen = true} connectionName={connectionSubtitle(app.ctx) || connectionLabel(app.ctx)} database={app.ctx.database || ''} dbType={app.dbType}
      tableCount={app.catalog.length} columnCount={app.catalog.reduce((sum, t) => sum + (t.column_count || 0), 0)}
      truncated={app.truncated} busy={app.catalogRefreshing} degraded={app.degraded} offline={app.offline}
      offlineInfo={app.offline ? { savedAt: app.offlineSavedAt, lastSyncedAt: offlineDocument?.lastSyncedAt, detailAt: app.offlineDetailAt, cachedCount: cachedTableCount,
        refreshError: isConnectionNotOpen(app.catalogError) ? '数据库会话已关闭，请在 DBX 中打开目标数据库后重试。' : maskUuids(app.catalogError) } : null}
      syncStatus={(syncBusy || syncFailed > 0 || syncDone < syncTotal || Boolean(app.storageError) || !app.offline) && !app.degraded && app.phase === 'ready' ? {
        label: syncBusy ? `同步 ${syncDone}/${syncTotal}` : app.storageError ? '缓存保存失败' : syncFailed || syncDone < syncTotal || app.truncated ? `同步未完成${syncFailed ? ` · ${syncFailed} 张表` : ''}` : '已同步',
        description: syncBusy ? `正在同步全部表的离线文档，已处理 ${syncDone} / ${syncTotal} 张表。完成前请保持数据库连接及此页面打开。` : app.storageError || `离线文档已处理 ${syncDone} / ${syncTotal} 张表${syncFailed ? `，其中 ${syncFailed} 张表读取失败或信息不完整` : ''}。${app.truncated ? '目录被宿主截断，尚未覆盖整个数据库。' : syncFailed || syncDone < syncTotal ? '可重试同步，展开同步问题查看具体原因。' : '离线缓存覆盖当前数据库的全部表结构。'}`,
        busy: syncBusy,
        failed: Boolean(app.storageError || syncFailed || syncDone < syncTotal || app.truncated) && !syncBusy,
        retryDisabled: app.catalogRefreshing,
        onretry: () => void (app.truncated ? refreshCatalog() : syncAllDocuments())
      } : null}
      onrefresh={() => void refreshCatalog()} onexport={() => openExport('schema')} onchangeresource={changeResource} />
    {#if syncIssues.length}<details class="sync-issues"><summary>查看 {syncIssues.length} 张表的同步问题</summary><ul>{#each syncIssues as issue}<li><button class="text-btn" onclick={() => app.navigateTable(issue.schema, issue.table)}>{issue.schema ? `${issue.schema}.` : ''}{issue.table}</button>{#each issue.messages as message}<div>{maskUuids(message)}</div>{/each}</li>{/each}</ul></details>{/if}
    {#if app.storageError}<div class="notice" role="status">{app.storageError}</div>{/if}
    {#if app.catalogError && !app.offline}<div class="refresh-notice" role="status"><div><strong>刷新失败，仍在显示上次读取的文档</strong><span>{isConnectionNotOpen(app.catalogError) ? '数据库会话已关闭，请在 DBX 中打开目标数据库后重试。' : maskUuids(app.catalogError)}</span></div><button class="btn" aria-label="重试刷新文档" onclick={() => void refreshCatalog()}>重试刷新</button><button class="icon-btn" aria-label="关闭刷新提示" onclick={() => (app.catalogError = '')}><Icon name="close" size={16} /></button></div>{/if}
    <div class="split" style={`--sidebar-width: ${sidebarWidth}px`}>
      <Catalog state={app} {offlineVersion} searchOffline={(keyword, schema) => searchOfflineColumnMatches(offlineDocument, keyword, schema)} />
      <SidebarResize value={sidebarWidth} onchange={(value) => { sidebarWidth = value }} oncommit={saveSidebar} />
      {#if app.offline && !offlineDocument && app.catalogRefreshing}
        <div class="boot" role="status"><span class="spinner"></span>{syncBusy ? `正在同步 ${syncDone} / ${syncTotal} 张表，全部成功后显示文档…` : '正在读取表目录…'}</div>
      {:else if app.offline && !offlineDocument && app.phase !== 'loading-catalog'}
        <EmptyState icon="refresh" title="尚无本地文档" description="请在 DBX 中连接并打开目标数据库，然后点击「刷新」创建全库离线文档。之后打开文档将直接使用缓存。" actionLabel="刷新并同步文档" onaction={() => void refreshCatalog()} />
      {:else if app.phase === 'loading-catalog'}
        <div class="boot" role="status"><span class="spinner"></span>正在读取表清单…</div>
      {:else}
        <Detail state={app} onsql={() => (sqlOpen = true)} onexport={() => openExport('table')} onretry={retryDetail} />
      {/if}
    </div>
  </div>
{/if}
{#if sqlOpen}<SqlDialog state={app} onclose={() => (sqlOpen = false)} />{/if}
{#if exportOpen}<ExportDialog state={app} initialMode={exportMode} getOfflineDocument={() => offlineDocument} onclose={() => (exportOpen = false)} />{/if}
{#if pickerOpen}<div class="resource-overlay"><Guide onsnapshot={() => snapshotOpen = true} {snapshotChanged} context={{ ...app.ctx, dbType: app.dbType }}
  diagnostics={app.diagMessage || null} onopen={chooseResource} syncBlocked={app.catalogRefreshing || syncBusy} oncacheupdated={(target) => { if (target.connectionId === app.ctx.connectionId && target.database === app.ctx.database) pickerCacheChanged = true }} onclose={closeResourcePicker} returnLabel={app.phase === 'ready' ? '返回文档' : '返回'} /></div>{/if}

</div>

<style>
  .sync-issues { flex: none; padding: 8px 20px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--muted); }
  .sync-issues summary { cursor: pointer; }
  .sync-issues ul { max-height: 180px; overflow: auto; padding-left: 20px; }
  .sync-issues li { margin: 8px 0; overflow-wrap: anywhere; }
</style>

{#if snapshotOpen}<SnapshotDirectoryDialog onclose={() => { snapshotOpen = false }} onchanged={() => { snapshotChanged += 1; if (app.ctx.connectionId) void boot() }} />{/if}
