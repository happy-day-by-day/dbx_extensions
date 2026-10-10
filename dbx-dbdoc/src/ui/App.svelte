<script lang="ts">
  import { onMount } from 'svelte'
  import { getBridge, isDataAccessDenied, isConnectionNotOpen, onUnrecognizedContext } from '../lib/bridge'
  import { getAdapter, normalizeDbType } from '../lib/dialects/registry'
  import { connKeyOf, createSessionCache, loadCatalog, loadDetail } from '../lib/store'
  import { loadRecent, rememberConnection, contextWithRecent } from '../lib/recent'
  import { cleanConnectionName, connectionLabel, connectionSubtitle } from '../lib/connectionLabels'
  import { maskUuids } from '../lib/display/masking'
  import type { PluginContext } from '../lib/types'
  import type { DbTable } from '../lib/dialects/entities'
  import { createAppState } from './state.svelte'
  import Catalog from './components/Catalog.svelte'
  import Detail from './components/Detail.svelte'
  import EmptyState from './components/EmptyState.svelte'
  import ExportDialog from './components/ExportDialog.svelte'
  import Guide from './components/Guide.svelte'
  import Header from './components/Header.svelte'
  import SqlDialog from './components/SqlDialog.svelte'
  import SidebarResize from './components/SidebarResize.svelte'
  import Icon from './components/Icon.svelte'
  import QueryWorkbench from './components/QueryWorkbench.svelte'
  import { TABLE_QUERY_WORKBENCH_ID } from '../lib/tableQuery'
  import './styles.css'

  const app = createAppState()
  const cache = createSessionCache()
  let sqlOpen = $state(false)
  let exportOpen = $state(false)
  let pickerOpen = $state(false)
  let queryMode = $state(false)
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

  async function refreshCatalog(force = false) {
    if (app.catalogRefreshing) return
    const bridge = getBridge()
    const adapter = getAdapter(app.dbType)
    const ctx = { ...app.ctx }
    if (!bridge || !adapter || !ctx.connectionId) return
    const keepDocument = app.phase === 'ready'
    const seq = ++catalogSeq
    const ref = refOf(ctx)
    if (force) cache.clear(connKeyOf(ctx.connectionId, ref))
    app.catalogRefreshing = true
    app.catalogError = ''
    if (!app.catalog.length) app.phase = 'loading-catalog'
    try {
      const result = await loadCatalog(bridge, adapter, ctx.connectionId, ref, cache)
      if (disposed || seq !== catalogSeq) return
      app.catalog = result.tables
      app.truncated = result.truncated
      app.schemas = [...new Set(result.tables.map((t) => t.table_schema))].sort()
      if (app.schemaFilter && !app.schemas.includes(app.schemaFilter)) app.schemaFilter = null
      const current = result.tables.find((t) => t.table_name === app.selectedTable && t.table_schema === app.selectedSchema)
      const activeTarget = { ...app.ctx, table: app.ctxTargetTable ?? app.ctx.table,
        schema: app.ctxTargetTable ? app.selectedSchema ?? undefined : app.ctx.schema }
      const target = targetRow(activeTarget, result.tables)
      if (current) select(current)
      else if (target) select(target)
      else if (activeTarget.table) {
        app.navigateTable(activeTarget.schema ?? null, activeTarget.table)
        app.ctxTargetTable = activeTarget.table
      } else if (result.tables[0]) select(result.tables[0])
      else { app.selectedTable = null; app.selectedSchema = null; app.detail = null }
      app.errorMessage = ''
      app.phase = 'ready'
      if (force) app.revision += 1
    } catch (err) {
      if (disposed || seq !== catalogSeq) return
      const message = err instanceof Error ? err.message : String(err)
      if (keepDocument && !isDataAccessDenied(err)) {
        app.catalogError = message
        app.phase = 'ready'
      } else {
        app.errorMessage = message
        app.phase = isDataAccessDenied(err) ? 'denied' : 'error'
      }
    } finally {
      if (seq === catalogSeq) app.catalogRefreshing = false
    }
  }

  async function boot() {
    const seq = ++bootSeq
    catalogSeq += 1
    app.catalogRefreshing = false
    app.catalogError = ''
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
      let normalized = normalizeDbType(ctx.dbType ?? '')
      if (!ctx.dbType && bridge.capabilities?.dataApi) {
        const probe = await bridge.queryData({ connectionId: ctx.connectionId!, database: ctx.database, sql: 'SELECT 1', maxRows: 1 })
        if (seq !== bootSeq || disposed) return
        normalized = normalizeDbType(probe.dbType)
      }
      app.dbType = normalized === 'unknown' ? ctx.dbType ?? '未知' : normalized
      if (normalized !== 'unknown') app.ctx = { ...app.ctx, dbType: normalized }
      if (!ctx.dbType && normalized !== 'unknown') void rememberConnection(bridge, app.ctx).catch(() => undefined)
      if (normalized === 'unknown') {
        if (ctx.table && bridge.capabilities?.schemaMetadataApi) {
          app.degraded = true
          app.navigateTable(ctx.schema ?? null, ctx.table)
          app.phase = 'ready'
        } else app.phase = 'unsupported'
        return
      }
      if (!bridge.capabilities?.dataApi) throw new Error('当前 DBX 版本未提供只读数据查询，请升级 DBX 后重试')
      const adapter = getAdapter(normalized)!
      if (!ctx.database && adapter.listDatabases) {
        app.phase = 'guide'
        return
      }
      await refreshCatalog()
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
      const width = Number(await bridge.storageGet('dbdoc.sidebarWidth').catch(() => null))
      if (width >= 224 && width <= 520) sidebarWidth = width
      const ctx = await bridge.getContext()
      if (disposed) return
      lastHostContext = { ...(pendingContext ?? ctx ?? {}) }
      initialized = true
      app.ctx = { ...lastHostContext }
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
    const row = app.catalog.find((t) => t.table_name === table && t.table_schema === schema)
    const bridge = getBridge()
    if (!bridge) return
    const ref = { db: database ?? null, schema: null, table: null }
    let active = true
    app.detail = null
    app.detailLoading = true
    app.errorMessage = ''
    const timer = setTimeout(() => {
      void loadDetail(bridge, adapter, connectionId, ref, schema, table, cache).then((detail) => {
        if (!active || disposed) return
        app.detail = { ...detail, table: row ? { ...detail.table, ...row, column_count: detail.columns.length } : detail.table }
      }).catch((err) => {
        if (active && !disposed) app.errorMessage = err instanceof Error ? err.message : String(err)
      }).finally(() => { if (active && !disposed) app.detailLoading = false })
    }, cache.detail(connKeyOf(connectionId, ref), schema, table) ? 0 : 100)
    return () => { active = false; clearTimeout(timer) }
  })

  function retryDetail() {
    if (app.ctx.connectionId) cache.clear(connKeyOf(app.ctx.connectionId, refOf(app.ctx)))
    app.revision += 1
  }
  function chooseResource(ctx: PluginContext) {
    pickerOpen = false
    if (app.phase === 'ready' && ctx.connectionId === app.ctx.connectionId && ctx.database === app.ctx.database) {
      app.ctx.name = cleanConnectionName(ctx.name, ctx.connectionId) || app.ctx.name
      return
    }
    app.ctx = ctx
    void boot()
  }
  function changeResource() { pickerOpen = true }
  function renameConnection(connectionId: string, name: string) { if (connectionId === app.ctx.connectionId) app.ctx.name = name }
  function openExport(mode: 'table' | 'schema') { exportMode = mode; exportOpen = true }
  function saveSidebar() { void getBridge()?.storageSet('dbdoc.sidebarWidth', String(sidebarWidth)).catch(() => undefined) }
  $effect(() => {
    const place = connectionLabel(app.ctx)
    if (queryMode) return
    document.title = `${app.selectedTable || place || '数据库文档'} · 数据库文档`
  })
</script>

{#if queryMode && app.phase === 'ready'}
  <QueryWorkbench context={app.ctx} />
{:else if queryMode && app.phase === 'error'}
  <EmptyState icon="refresh" title="查询页初始化失败" description={maskUuids(app.errorMessage)} actionLabel="重试" onaction={() => void initApp()} />
{:else if app.phase === 'booting'}
  <div class="boot" role="status"><span class="spinner"></span>正在打开数据库文档…</div>
{:else if app.phase === 'guide'}
  <Guide context={app.ctx} diagnostics={app.diagMessage || null} onopen={chooseResource} onrename={renameConnection} />
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
    <Header connectionName={connectionSubtitle(app.ctx) || connectionLabel(app.ctx)} database={app.ctx.database || ''} dbType={app.dbType}
      tableCount={app.catalog.length} columnCount={app.catalog.reduce((sum, t) => sum + (t.column_count || 0), 0)}
      truncated={app.truncated} busy={app.catalogRefreshing} degraded={app.degraded}
      onrefresh={() => void refreshCatalog(true)} onexport={() => openExport('schema')} onchangeresource={changeResource} />
    {#if app.catalogError}<div class="refresh-notice" role="status"><div><strong>刷新失败，仍在显示上次读取的文档</strong><span>{isConnectionNotOpen(app.catalogError) ? '数据库会话已关闭，请在 DBX 中打开目标数据库后重试。' : maskUuids(app.catalogError)}</span></div><button class="btn" aria-label="重试刷新文档" onclick={() => void refreshCatalog(true)}>重试刷新</button><button class="icon-btn" aria-label="关闭刷新提示" onclick={() => (app.catalogError = '')}><Icon name="close" size={16} /></button></div>{/if}
    <div class="split" style={`--sidebar-width: ${sidebarWidth}px`}>
      <Catalog state={app} />
      <SidebarResize value={sidebarWidth} onchange={(value) => { sidebarWidth = value }} oncommit={saveSidebar} />
      {#if app.phase === 'loading-catalog'}
        <div class="boot" role="status"><span class="spinner"></span>正在读取表清单…</div>
      {:else}
        <Detail state={app} onsql={() => (sqlOpen = true)} onexport={() => openExport('table')} onretry={retryDetail} />
      {/if}
    </div>
  </div>
{/if}
{#if sqlOpen}<SqlDialog state={app} onclose={() => (sqlOpen = false)} />{/if}
{#if exportOpen}<ExportDialog state={app} initialMode={exportMode} onclose={() => (exportOpen = false)} />{/if}
{#if pickerOpen}<div class="resource-overlay"><Guide context={{ ...app.ctx, dbType: app.dbType }}
  diagnostics={app.diagMessage || null} onopen={chooseResource} onrename={renameConnection} onclose={() => (pickerOpen = false)} returnLabel={app.phase === 'ready' ? '返回文档' : '返回'} /></div>{/if}
