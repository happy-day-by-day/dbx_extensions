<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { AppState } from '../state.svelte'
  import type { DbTable } from '../../lib/dialects/entities'
  import { compileFilterPattern } from '../../lib/display/filters'
  import { selectCatalogTables, virtualRange } from '../../lib/display/catalog'
  import { splitHighlight } from '../../lib/display/highlight'
  import { maskUuids } from '../../lib/display/masking'
  import { searchColumnMatches } from '../../lib/store'
  import { tableSearchKey, columnMatchPreview, type ColumnMatch } from '../../lib/display/columnSearch'
  import { getAdapter } from '../../lib/dialects/registry'
  import { getBridge } from '../../lib/bridge'
  import Icon from './Icon.svelte'

  let { state: app, searchOffline, offlineVersion }: {
    state: AppState
    searchOffline: (keyword: string, schema: string | null) => Map<string, ColumnMatch[]>
    offlineVersion: number
  } = $props()
  let keyword = $state('')
  let committedKeyword = $state('')
  let composing = $state(false)
  let regexMode = $state(false)
  let columnMatches = $state(new Map<string, ColumnMatch[]>())
  let searchRetry = $state(0)
  let uncommented = $state(false)
  const sort = $derived(app.catalogSort)
  let searchError = $state('')
  let searching = $state(false)
  let openingQuery = $state(false)
  let queryError = $state('')
  let prefsLoaded = $state(false)
  let filtersOpen = $state(false)
  let compact = $state(false)
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K'
  const filterCount = $derived(Number(regexMode) + Number(uncommented))
  let scrollTop = $state(0)
  let height = $state(500)
  let viewport: HTMLDivElement
  let searchInput: HTMLInputElement
  const pattern = $derived(compileFilterPattern(committedKeyword.trim(), regexMode))
  const visible = $derived(selectCatalogTables(app.catalog, {
    keyword: committedKeyword, regexMode, schema: app.schemaFilter, columnHits: app.columnHits, uncommented, sort
  }))
  const range = $derived(virtualRange(visible.length, scrollTop, height))
  const rows = $derived(visible.slice(range.start, range.end))
  const selectionHidden = $derived(!app.multiTableMode && Boolean(app.selectedTable) && !visible.some(isSelected))

  function isSelected(table: DbTable) {
    return table.table_name === app.selectedTable && table.table_schema === app.selectedSchema
  }
  function select(table: DbTable) {
    if (app.multiTableMode) { app.navigateTable(table.table_schema, table.table_name); app.toggleCheckedTable(table); return }
    const fieldMatch = columnMatches.has(tableSearchKey(table.table_schema, table.table_name))
    app.navigateTable(table.table_schema, table.table_name, fieldMatch ? 'columns' : undefined)
  }
  async function openQuery(table: DbTable) {
    if (openingQuery) return
    const context = { ...app.ctx, dbType: app.dbType, schema: table.table_schema, table: table.table_name }
    openingQuery = true
    queryError = ''
    try {
      const bridge = getBridge()
      if (!bridge?.openTableQuery) throw new Error('当前 DBX 版本不支持打开查询标签页')
      await bridge.openTableQuery(context)
    } catch (error) {
      queryError = maskUuids(error instanceof Error ? error.message : String(error))
    } finally { openingQuery = false }
  }
  function reveal(index: number) {
    if (!viewport) return
    const top = index * 72
    if (top < viewport.scrollTop) viewport.scrollTop = top
    else if (top + 72 > viewport.scrollTop + height) viewport.scrollTop = top + 72 - height
    scrollTop = viewport.scrollTop
  }
  function navigate(event: KeyboardEvent) {
    if (event.isComposing || composing) return
    if (event.key === 'Enter' && event.currentTarget === searchInput) { searchRetry += 1; return }
    if (!visible.length) return
    // 多表行使用原生按钮的 Enter / Space 点击，避免与视口快捷键重复切换。
    const row = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.catalog-row') : null
    if (app.multiTableMode && row && ['Enter', ' '].includes(event.key)) return
    if (event.key === 'Enter' || (app.multiTableMode && event.key === ' ' && event.currentTarget !== searchInput)) {
      const table = visible.find(isSelected)
      if (app.multiTableMode) { if (table) { event.preventDefault(); app.toggleCheckedTable(table) }; return }
      if (table) { event.preventDefault(); void openQuery(table) }
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    if (event.currentTarget === searchInput && !['ArrowDown', 'ArrowUp'].includes(event.key)) return
    event.preventDefault()
    const index = visible.findIndex(table => app.multiTableMode && row
      ? tableSearchKey(table.table_schema, table.table_name) === row.dataset.table : isSelected(table))
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1
      : Math.max(0, Math.min(visible.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
    if (app.multiTableMode) app.navigateTable(visible[next].table_schema, visible[next].table_name)
    else select(visible[next])
    reveal(next)
    if (app.multiTableMode && event.currentTarget !== searchInput) {
      const key = tableSearchKey(visible[next].table_schema, visible[next].table_name)
      void tick().then(() => [...viewport.querySelectorAll<HTMLButtonElement>('.catalog-row')]
        .find(button => button.dataset.table === key)?.focus({ preventScroll: true }))
    }
  }
  function clearSearch() { keyword = ''; committedKeyword = ''; composing = false; searchInput?.focus() }
  function clearFilters() { clearSearch(); uncommented = false; regexMode = false; app.schemaFilter = null }

  // 离线字段搜索立即读取内存中的本地文档；在线查询仍保持 300ms 防抖。
  $effect(() => {
    const kw = committedKeyword.trim()
    const enabled = !regexMode && !app.degraded && !composing
    const connectionId = app.ctx.connectionId
    const database = app.ctx.database
    const adapter = getAdapter(app.dbType)
    const phase = app.phase
    const schema = app.schemaFilter
    const immediate = searchRetry
    app.revision
    let active = true
    app.columnHits = new Set()
    columnMatches = new Map()
    searchError = ''
    searching = false
    if (!enabled || !kw || phase !== 'ready') return
    if (app.offline) {
      offlineVersion
      const matches = searchOffline(kw, schema)
      columnMatches = matches
      app.columnHits = new Set(matches.keys())
      return
    }
    if (!connectionId || !adapter) return
    searching = true
    const run = () => {
      const bridge = getBridge()
      if (!bridge) { searching = false; searchError = '字段搜索暂不可用，请重新打开文档后重试'; return }
      void searchColumnMatches(bridge, adapter, connectionId, { db: database ?? null, schema, table: null }, kw,
        () => { if (active) searchError = '字段搜索结果被宿主截断，请缩小搜索范围' })
        .then((matches) => { if (active) { columnMatches = matches; app.columnHits = new Set(matches.keys()) } })
        .catch((err) => { if (active) searchError = `字段搜索失败：${err instanceof Error ? err.message : String(err)}` })
        .finally(() => { if (active) searching = false })
    }
    const timer = setTimeout(run, immediate ? 0 : 300)
    return () => { active = false; clearTimeout(timer) }
  })

  $effect(() => { app.catalogSearch = { keyword: committedKeyword.trim(), regexMode } })

  $effect(() => {
    committedKeyword; regexMode; uncommented; sort; app.schemaFilter
    if (viewport) viewport.scrollTop = 0
    scrollTop = 0
  })
  $effect(() => {
    const index = visible.findIndex(isSelected)
    if (index >= 0) reveal(index)
  })
  $effect(() => {
    if (!prefsLoaded) return
    void getBridge()?.storageSet('dbdoc.prefs', JSON.stringify({ regexMode, sort })).catch(() => undefined)
  })
  onMount(() => {
    let active = true
    void getBridge()?.storageGet('dbdoc.prefs').then((raw) => {
      if (!active || !raw) return
      try {
        const prefs = JSON.parse(raw)
        regexMode = prefs.regexMode === true
        app.catalogSort = prefs.sort === 'columns' ? 'columns' : 'name'
      } catch { /* 无效偏好使用默认值 */ }
    }).catch(() => undefined).finally(() => { if (active) prefsLoaded = true })
    return () => { active = false }
  })
</script>

<svelte:window onkeydown={async (event) => {
  if (!event.isComposing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !searchInput?.closest('[inert]')) {
    event.preventDefault(); compact = false; await tick(); searchInput?.focus(); searchInput?.select()
  }
}} />

<nav class="catalog" class:compact aria-label="表目录">
  <div class="catalog-tools">
    <div class="catalog-heading"><span class="catalog-title"><Icon name="table" size={16} />表目录<span class="catalog-total">{app.catalog.length.toLocaleString()}</span></span>{#if !app.degraded}<div class="view-mode" role="group" aria-label="文档查看模式"><button class:chosen={!app.multiTableMode} aria-pressed={!app.multiTableMode} onclick={() => app.setMultiTableMode(false)}>单表</button><button class:chosen={app.multiTableMode} aria-pressed={app.multiTableMode} onclick={() => app.setMultiTableMode(true)}>多表</button></div>{/if}<button class="catalog-collapse" aria-expanded={!compact} onclick={() => compact = !compact}>{compact ? '展开目录' : '收起目录'}<span class:expanded={!compact}><Icon name="down" size={14} /></span></button></div>
    <div class="catalog-fields">
    {#if app.schemas.length > 1}<label class="catalog-scope"><span>范围</span><select aria-label="筛选 Schema" value={app.schemaFilter ?? ''}
      onchange={(event) => (app.schemaFilter = event.currentTarget.value || null)}><option value="">全部 Schema</option>{#each app.schemas as schema (schema)}<option value={schema}>{schema}</option>{/each}</select></label>{/if}
    <div class="search-box">
      <Icon name="search" size={16} />
      <input bind:this={searchInput} class="input" type="search" placeholder={regexMode || app.degraded ? '搜索表名、表注释…' : '搜索表、字段和注释…'} aria-label="搜索表目录"
        title="搜索表名、表注释、字段名和字段注释；Ctrl / ⌘ K 聚焦，上下键选择表" value={keyword} onkeydown={navigate}
        oninput={(event) => { keyword = event.currentTarget.value; if (!composing && !(event instanceof InputEvent && event.isComposing)) { committedKeyword = keyword; searchRetry = 0 } }}
        oncompositionstart={() => (composing = true)} oncompositionend={(event) => { composing = false; keyword = event.currentTarget.value; committedKeyword = keyword; searchRetry = 0 }} />
      {#if keyword}<button class="icon-btn" title="清空搜索" aria-label="清空搜索" onclick={clearSearch}><Icon name="close" size={14} /></button>{:else}<kbd>{shortcut}</kbd>{/if}
    </div>
    <div class="catalog-result"><button class="filter-toggle" class:filter-active={filterCount > 0} aria-expanded={filtersOpen} onclick={() => (filtersOpen = !filtersOpen)}><Icon name="filter" size={15} />筛选{#if filterCount}<span>{filterCount}</span>{/if}</button>
      <select aria-label="表目录排序" value={sort} onchange={(event) => app.catalogSort = event.currentTarget.value === 'columns' ? 'columns' : 'name'}><option value="name">名称排序</option><option value="columns">字段数排序</option></select>
    </div>
    {#if app.multiTableMode}<div class="selection-tools"><span>已选 {app.checkedTables.size}</span><button class="text-btn" title="选中当前搜索和筛选结果中的全部表" disabled={!visible.length} onclick={() => app.checkedTables = new Set([...app.checkedTables, ...visible.map(table => tableSearchKey(table.table_schema, table.table_name))])}>全选当前结果</button><button class="text-btn" disabled={!app.checkedTables.size} onclick={() => app.checkedTables = new Set()}>清空</button></div>{/if}
    {#if filtersOpen}<div class="catalog-options">
      <button class="chip" class:chip-active={regexMode} aria-pressed={regexMode} title="正则匹配表名、注释和 Schema"
        onclick={() => (regexMode = !regexMode)}>.* 正则</button>
      <button class="chip" class:chip-active={uncommented} aria-pressed={uncommented} onclick={() => (uncommented = !uncommented)}>无注释</button>
    </div>{/if}
    {#if regexMode}<p class="catalog-hint">正则仅匹配表名、表注释与 Schema</p>{/if}
    {#if pattern.error || searchError}<div class="catalog-error" role="alert"><span>{maskUuids(pattern.error || searchError)}</span>{#if searchError && !searching}<button class="text-btn" onclick={() => searchRetry += 1}>重试字段搜索</button>{/if}</div>{/if}
    {#if queryError}<div class="catalog-error" role="alert"><span>无法打开查询：{queryError}</span><button class="text-btn" onclick={() => queryError = ''}>关闭提示</button></div>{/if}
    {#if selectionHidden}<div class="catalog-selection">正在查看 {app.selectedTable}<button class="text-btn" onclick={clearFilters}>清除筛选</button></div>{/if}
    </div>
  </div>
  <!-- 目录视口保留焦点以支持方向键选择和虚拟列表滚动。 -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="catalog-viewport" bind:this={viewport} bind:clientHeight={height} onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
    role={app.multiTableMode ? "group" : "listbox"} aria-label="数据库表" tabindex="0" onkeydown={navigate} aria-busy={app.catalogRefreshing || searching}>
    {#if !visible.length}
      <div class="catalog-empty"><span class="empty-symbol">{#if searching}<span class="spinner"></span>{:else}<Icon name={committedKeyword || uncommented ? 'search' : 'table'} size={25} />{/if}</span><strong>{app.catalogRefreshing ? '正在读取表清单' : searching ? '正在搜索字段和注释' : searchError ? '字段搜索未完成' : committedKeyword || uncommented ? '没有匹配的表' : '该范围内暂无表'}</strong>
        <span>{searching ? '表信息匹配结果会先显示' : searchError ? '可重试字段搜索，或修改关键词' : committedKeyword || uncommented ? '试试其他关键字，或清除筛选' : '确认连接和数据库选择是否正确'}</span>
        {#if committedKeyword || uncommented}<button class="btn" onclick={clearFilters}>清除筛选</button>{/if}
      </div>
    {:else}
      <div aria-hidden="true" style={`height: ${range.before}px`}></div>
      {#each rows as table (JSON.stringify([table.table_schema, table.table_name]))}
        {@const matches = columnMatches.get(tableSearchKey(table.table_schema, table.table_name)) ?? []}
        {@const preview = matches.length ? columnMatchPreview(matches[0], committedKeyword) : ''}
        <div class="catalog-entry">
        <button class="catalog-row" class:catalog-row-active={app.multiTableMode ? app.checkedTables.has(tableSearchKey(table.table_schema, table.table_name)) : isSelected(table)} role={app.multiTableMode ? undefined : "option"} aria-selected={app.multiTableMode ? undefined : isSelected(table)} aria-pressed={app.multiTableMode ? app.checkedTables.has(tableSearchKey(table.table_schema, table.table_name)) : undefined}
          aria-setsize={app.multiTableMode ? undefined : visible.length} aria-posinset={app.multiTableMode ? undefined : visible.indexOf(table) + 1} tabindex={app.multiTableMode && isSelected(table) ? 0 : -1}
          aria-label={app.multiTableMode ? `选择表 ${table.table_schema}.${table.table_name}` : undefined} data-table={tableSearchKey(table.table_schema, table.table_name)}
          title={`${table.table_schema}.${table.table_name}\n${table.table_comment || '暂无注释'}${matches.length ? '\n匹配字段：' + matches.map((match) => match.name + (match.comment ? ' · ' + match.comment : '')).join('\n') : ''}\n${app.multiTableMode ? '点击选择或取消；高亮表示已选中' : '双击打开查询'}`} onclick={() => select(table)} ondblclick={() => { if (!app.multiTableMode) void openQuery(table) }}>
          <span class="catalog-row-main"><span class="table-symbol"><Icon name="table" size={15} /></span>
            <span class="catalog-name">{#each splitHighlight(table.table_name, pattern.regex) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span>
            <span class="catalog-cols">{table.column_count} 列</span>
          </span>
          <span class="catalog-comment" class:field-preview={matches.length > 0}>{#if preview}{#each splitHighlight(preview, pattern.regex) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}{:else if table.table_comment}{#each splitHighlight(table.table_comment, pattern.regex) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}{:else}暂无注释{/if}</span>
          <span class="catalog-row-meta">{#each splitHighlight(table.table_schema || '—', pattern.regex) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}{#if matches.length}<span class="field-hit">字段匹配 · {matches.length}</span>{/if}</span>
        </button>
        </div>
      {/each}
      <div aria-hidden="true" style={`height: ${range.after}px`}></div>
    {/if}
  </div>
  <div class="catalog-footer"><span role="status" aria-live="polite">{openingQuery ? '正在打开查询…' : searching ? '正在搜索字段和注释…' : `${app.offline ? '本地搜索 · ' : ''}${visible.length.toLocaleString()} / ${app.catalog.length.toLocaleString()} 张表`}</span><span title={app.multiTableMode ? '点击表行选择或取消；上下键移动，Enter / 空格切换选择' : '上下键选择表；双击表或在目录中按 Enter 打开查询'}>{app.multiTableMode ? '点击选择 · 高亮已选' : '双击 / Enter 查询'}</span></div>
</nav>

<style>
  .catalog { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .catalog-collapse { display: none; align-items: center; gap: 5px; border: 0; background: none; color: var(--muted); font-size: 11px; cursor: pointer; padding: 3px 0 3px 8px; }.catalog-collapse span { display: flex; }.catalog-collapse span.expanded { transform: rotate(180deg); }
  .catalog-tools { flex: none; padding: 12px 12px 8px; border-bottom: 1px solid var(--border); }
  .catalog-title { display: flex; gap: 8px; align-items: center; font-size: 13px; font-weight: 600; }.catalog-title :global(svg) { color: var(--muted); }
  .catalog-scope { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 11px; margin: 8px 0; }.catalog-scope select { flex: 1; width: 100%; max-width: none; background: var(--panel); color: var(--text); padding: 5px 7px; border: 1px solid var(--border); border-radius: 6px; }
  .catalog-heading, .catalog-result { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; gap: 8px; }
  .catalog-total { font-size: 11px; color: var(--muted); font-weight: 400; }
  .search-box { display: flex; gap: 6px; align-items: center; border: 1px solid var(--border); border-radius: 7px; padding: 0 8px; color: var(--muted); background: var(--bg); }
  .search-box:focus-within { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-weak); }
  .search-box .input { min-width: 0; width: 100%; border: 0; box-shadow: none; background: transparent; padding: 7px 0; font-size: 12px; }
  kbd { font: 10px var(--mono); white-space: nowrap; opacity: .7; }
  .catalog-options { display: flex; gap: 6px; margin: 10px 0 0; flex-wrap: wrap; }
  .catalog-options .chip { padding: 3px 7px; font-size: 11px; border-radius: 5px; }
  .catalog-result { font-size: 11px; color: var(--muted); margin: 9px 0 0; }
  .filter-toggle { display: flex; align-items: center; gap: 5px; font: inherit; color: var(--muted); background: transparent; border: 0; padding: 3px 0; cursor: pointer; }.filter-active { color: var(--accent); }.filter-toggle > span { font-size: 10px; background: var(--accent-weak); padding: 0 4px; border-radius: 3px; }
  select { border: 0; font: inherit; color: var(--muted); background: var(--panel); max-width: 105px; cursor: pointer; }
  .catalog-error { font-size: 11px; color: var(--danger); overflow-wrap: anywhere; display: flex; gap: 4px; flex-direction: column; margin-top: 8px; align-items: flex-start; }.catalog-hint { margin: 7px 0 0; color: var(--muted); font-size: 10px; }
  .catalog-selection { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
  .view-mode { display: inline-flex; flex: none; gap: 8px; margin-left: auto; }
  .view-mode button { border: 0; border-bottom: 2px solid transparent; padding: 1px 2px; background: transparent; color: var(--muted); font: inherit; font-size: 11px; line-height: 18px; cursor: pointer; }
  .view-mode button:hover, .view-mode button.chosen { color: var(--accent); }
  .view-mode button.chosen { border-bottom-color: var(--accent); }
  .selection-tools { display: flex; gap: 6px; align-items: center; margin-top: 4px; font-size: 11px; color: var(--muted); }
  .selection-tools > span { margin-right: auto; }
  .selection-tools .text-btn { padding: 2px; }
  .catalog-entry { height: 72px; display: flex; align-items: center; min-width: 0; }
  .catalog-viewport { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; padding: 8px 8px; }
  .catalog-row { display: flex; flex-direction: column; position: relative; width: 100%; height: 72px; padding: 9px 10px; gap: 3px; text-align: left; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--text); cursor: pointer; }
  .catalog-row:hover { background: var(--row-hover); }
  .catalog-row-active, .catalog-row-active:hover { background: var(--accent-weak); }.catalog-row-active::before { content: ''; width: 3px; height: 25px; background: var(--accent); border-radius: 3px; position: absolute; left: -2px; top: 13px; }
  .catalog-row-main { display: flex; align-items: center; gap: 8px; min-width: 0; width: 100%; line-height: 18px; }
  .table-symbol { color: var(--muted); font-size: 14px; flex: none; }
  .catalog-row-active .table-symbol { color: var(--accent); }
  .catalog-name { font: 500 12px var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.catalog-row-active .catalog-name { color: var(--accent); font-weight: 600; }
  .catalog-cols { flex: none; margin-left: auto; font: 11px var(--mono); color: var(--muted); }
  .catalog-comment { margin-left: 23px; font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .field-preview { color: var(--text); font-size: 11px; }
  .catalog-row-meta { display: flex; gap: 8px; margin-left: 22px; font-size: 10px; line-height: 13px; color: var(--muted); opacity: .8; }
  .field-hit { color: var(--accent); }
  .catalog-empty { display: flex; flex-direction: column; gap: 8px; align-items: center; text-align: center; padding: 40px 14px; color: var(--muted); font-size: 12px; }
  .empty-symbol { font-size: 32px; opacity: .5; }
  .empty-symbol .spinner { display: inline-block; }
  .catalog-footer { display: flex; justify-content: space-between; gap: 8px; padding: 9px 14px; font-size: 10px; color: var(--muted); border-top: 1px solid var(--border); }
  @media(max-width:760px) { .catalog-collapse { display: flex; }.catalog-heading { justify-content: flex-start; }.catalog-collapse { margin-left: auto; }.catalog.compact { height: 44px; }.catalog.compact .catalog-fields, .catalog.compact .catalog-viewport, .catalog.compact .catalog-footer { display: none; }.catalog.compact .catalog-tools { border-bottom: 0; }.catalog.compact .catalog-heading { margin-bottom: 0; } }
</style>
