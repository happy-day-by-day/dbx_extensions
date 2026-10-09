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

  let { state: app }: { state: AppState } = $props()
  let keyword = $state('')
  let committedKeyword = $state('')
  let composing = $state(false)
  let regexMode = $state(false)
  let columnMatches = $state(new Map<string, ColumnMatch[]>())
  let searchRetry = $state(0)
  let uncommented = $state(false)
  let sort = $state<'name' | 'columns'>('name')
  let searchError = $state('')
  let searching = $state(false)
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
  const selectionHidden = $derived(Boolean(app.selectedTable) && !visible.some(isSelected))

  function isSelected(table: DbTable) {
    return table.table_name === app.selectedTable && table.table_schema === app.selectedSchema
  }
  function select(table: DbTable) {
    const fieldMatch = columnMatches.has(tableSearchKey(table.table_schema, table.table_name))
    app.navigateTable(table.table_schema, table.table_name, fieldMatch ? 'columns' : undefined)
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
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    if (event.currentTarget === searchInput && !['ArrowDown', 'ArrowUp'].includes(event.key)) return
    event.preventDefault()
    const index = visible.findIndex(isSelected)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1
      : Math.max(0, Math.min(visible.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
    select(visible[next]); reveal(next)
  }
  function clearSearch() { keyword = ''; committedKeyword = ''; composing = false; searchInput?.focus() }
  function clearFilters() { clearSearch(); uncommented = false; regexMode = false; app.schemaFilter = null }

  // 仅字段搜索访问数据库。变化时立即废弃旧结果，300ms 后才派发新请求。
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
    if (!enabled || !kw || !connectionId || !adapter || phase !== 'ready') return
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
        sort = prefs.sort === 'columns' ? 'columns' : 'name'
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
    <div class="catalog-heading"><span class="catalog-title"><Icon name="table" size={17} />表目录</span><span class="catalog-total">{app.catalog.length.toLocaleString()}</span><button class="catalog-collapse" aria-expanded={!compact} onclick={() => compact = !compact}>{compact ? '展开目录' : '收起目录'}<span class:expanded={!compact}><Icon name="down" size={14} /></span></button></div>
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
      <select aria-label="表目录排序" bind:value={sort}><option value="name">名称排序</option><option value="columns">字段数排序</option></select>
    </div>
    {#if filtersOpen}<div class="catalog-options">
      <button class="chip" class:chip-active={regexMode} aria-pressed={regexMode} title="正则匹配表名、注释和 Schema"
        onclick={() => (regexMode = !regexMode)}>.* 正则</button>
      <button class="chip" class:chip-active={uncommented} aria-pressed={uncommented} onclick={() => (uncommented = !uncommented)}>无注释</button>
    </div>{/if}
    {#if regexMode}<p class="catalog-hint">正则仅匹配表名、表注释与 Schema</p>{/if}
    {#if pattern.error || searchError}<div class="catalog-error" role="alert"><span>{maskUuids(pattern.error || searchError)}</span>{#if searchError && !searching}<button class="text-btn" onclick={() => searchRetry += 1}>重试字段搜索</button>{/if}</div>{/if}
    {#if selectionHidden}<div class="catalog-selection">正在查看 {app.selectedTable}<button class="text-btn" onclick={clearFilters}>清除筛选</button></div>{/if}
    </div>
  </div>
  <div class="catalog-viewport" bind:this={viewport} bind:clientHeight={height} onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
    role="listbox" aria-label="数据库表" tabindex="0" onkeydown={navigate} aria-busy={app.catalogRefreshing || searching}>
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
        <button class="catalog-row" class:catalog-row-active={isSelected(table)} role="option" aria-selected={isSelected(table)}
          aria-setsize={visible.length} aria-posinset={visible.indexOf(table) + 1} tabindex="-1"
          title={`${table.table_schema}.${table.table_name}\n${table.table_comment || '暂无注释'}${matches.length ? '\n匹配字段：' + matches.map((match) => match.name + (match.comment ? ' · ' + match.comment : '')).join('\n') : ''}`} onclick={() => select(table)}>
          <span class="catalog-row-main"><span class="table-symbol"><Icon name="table" size={15} /></span>
            <span class="catalog-name">{#each splitHighlight(table.table_name, pattern.regex) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span>
            <span class="catalog-cols">{table.column_count} 列</span>
          </span>
          <span class="catalog-comment" class:field-preview={matches.length > 0}>{#if preview}{#each splitHighlight(preview, pattern.regex) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}{:else if table.table_comment}{#each splitHighlight(table.table_comment, pattern.regex) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}{:else}暂无注释{/if}</span>
          <span class="catalog-row-meta">{#each splitHighlight(table.table_schema || '—', pattern.regex) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}{#if matches.length}<span class="field-hit">字段匹配 · {matches.length}</span>{/if}</span>
        </button>
      {/each}
      <div aria-hidden="true" style={`height: ${range.after}px`}></div>
    {/if}
  </div>
  <div class="catalog-footer"><span role="status" aria-live="polite">{searching ? '正在搜索字段和注释…' : `${visible.length.toLocaleString()} / ${app.catalog.length.toLocaleString()} 张表`}</span><span>↑ ↓ 选择</span></div>
</nav>

<style>
  .catalog { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .catalog-collapse { display: none; align-items: center; gap: 5px; border: 0; background: none; color: var(--muted); font-size: 11px; cursor: pointer; padding: 3px 0 3px 8px; }.catalog-collapse span { display: flex; }.catalog-collapse span.expanded { transform: rotate(180deg); }
  .catalog-tools { flex: none; padding: 19px 16px 12px; border-bottom: 1px solid var(--border); }
  .catalog-title { display: flex; gap: 8px; align-items: center; font-size: 13px; font-weight: 600; }.catalog-title :global(svg) { color: var(--muted); }
  .catalog-scope { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 11px; margin: 12px 0; }.catalog-scope select { flex: 1; width: 100%; max-width: none; background: var(--panel); color: var(--text); padding: 7px 9px; border: 1px solid var(--border); border-radius: 6px; }
  .catalog-heading, .catalog-result { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; gap: 8px; }
  .catalog-total { font-size: 11px; color: var(--muted); background: var(--chip-bg); padding: 1px 7px; border-radius: 5px; }
  .search-box { display: flex; gap: 6px; align-items: center; border: 1px solid var(--border); border-radius: 7px; padding: 0 8px; color: var(--muted); background: var(--bg); }
  .search-box:focus-within { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-weak); }
  .search-box .input { min-width: 0; width: 100%; border: 0; box-shadow: none; background: transparent; padding: 10px 0; font-size: 12px; }
  kbd { font: 10px var(--mono); white-space: nowrap; opacity: .7; }
  .catalog-options { display: flex; gap: 6px; margin: 10px 0 0; flex-wrap: wrap; }
  .catalog-options .chip { padding: 3px 7px; font-size: 11px; border-radius: 5px; }
  .catalog-result { font-size: 11px; color: var(--muted); margin: 9px 0 0; }
  .filter-toggle { display: flex; align-items: center; gap: 5px; font: inherit; color: var(--muted); background: transparent; border: 0; padding: 3px 0; cursor: pointer; }.filter-active { color: var(--accent); }.filter-toggle > span { font-size: 10px; background: var(--accent-weak); padding: 0 4px; border-radius: 3px; }
  select { border: 0; font: inherit; color: var(--muted); background: var(--panel); max-width: 105px; cursor: pointer; }
  .catalog-error { font-size: 11px; color: var(--danger); overflow-wrap: anywhere; display: flex; gap: 4px; flex-direction: column; margin-top: 8px; align-items: flex-start; }.catalog-hint { margin: 7px 0 0; color: var(--muted); font-size: 10px; }
  .catalog-selection { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
  .catalog-viewport { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; padding: 8px 8px; }
  .catalog-row { display: flex; flex-direction: column; position: relative; width: 100%; height: 72px; padding: 9px 10px; gap: 3px; text-align: left; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--text); cursor: pointer; }
  .catalog-row:hover { background: var(--row-hover); }
  .catalog-row-active { background: var(--accent-weak); }.catalog-row-active::before { content: ''; width: 3px; height: 25px; background: var(--accent); border-radius: 3px; position: absolute; left: -2px; top: 13px; }
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
  @media(max-width:760px) { .catalog-collapse { display: flex; }.catalog-heading { justify-content: flex-start; }.catalog-total { margin-left: auto; }.catalog.compact { height: 56px; }.catalog.compact .catalog-fields, .catalog.compact .catalog-viewport, .catalog.compact .catalog-footer { display: none; }.catalog.compact .catalog-tools { border-bottom: 0; }.catalog.compact .catalog-heading { margin-bottom: 0; } }
</style>
