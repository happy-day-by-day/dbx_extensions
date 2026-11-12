<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte'
  import type { AppState } from '../state.svelte'
  import type { DbTable } from '../../lib/dialects/entities'
  import type { TableDetail } from '../../lib/markdown'
  import { selectedCatalogTables } from '../../lib/display/catalog'
  import { tableSearchKey } from '../../lib/display/columnSearch'
  import MultiTableItem from './MultiTableItem.svelte'
  import EmptyState from './EmptyState.svelte'
  import Icon from './Icon.svelte'
  let { state: app, sourceVersion, dense, ondensitychange, load, onsql, onexport, onrefresh }: {
    state: AppState; sourceVersion: number; dense: boolean
    ondensitychange: (dense: boolean) => void; load: (table: DbTable) => Promise<TableDetail>
    onsql: (state: AppState) => void; onexport: (state: AppState) => void; onrefresh: () => void
  } = $props()
  const tables = $derived(selectedCatalogTables(app.catalog, app.checkedTables, app.catalogSort))
  let documents = $state<HTMLDivElement>()
  let activeKey = $state('')
  const currentIndex = $derived(Math.max(0, tables.findIndex(table => tableSearchKey(table.table_schema, table.table_name) === activeKey)))
  const currentKey = $derived(tables[currentIndex] ? tableSearchKey(tables[currentIndex].table_schema, tables[currentIndex].table_name) : '')
  let frame = 0
  let jumpTimer: ReturnType<typeof setTimeout> | undefined
  let jumping = false
  let anchorKey = ''
  let resizeObserver: ResizeObserver | undefined
  const tableNodes = () => documents ? [...documents.querySelectorAll<HTMLElement>('[data-table]')] : []
  function stopJump() { jumping = false; anchorKey = ''; clearTimeout(jumpTimer) }
  function settleJump() {
    clearTimeout(jumpTimer)
    // Retain the requested table when the scroll range cannot align its top.
    // The next manual scroll resumes viewport tracking.
    jumpTimer = setTimeout(() => { jumping = false }, 180)
  }
  function trackPosition() {
    if (jumping || !documents) return
    const top = documents.getBoundingClientRect().top + 12
    const nodes = tableNodes()
    let current = nodes[0]
    for (const node of nodes) {
      if (node.getBoundingClientRect().top > top) break
      current = node
    }
    if (current) activeKey = current.dataset.table ?? ''
  }
  function onScroll() {
    if (jumping) { settleJump(); return }
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(trackPosition)
  }
  function alignTable(key: string, behavior: ScrollBehavior) {
    const target = tableNodes().find(node => node.dataset.table === key)
    if (!target || !documents) return
    activeKey = key
    jumping = true
    documents.scrollTo({
      top: documents.scrollTop + target.getBoundingClientRect().top - documents.getBoundingClientRect().top - 10,
      behavior
    })
    settleJump()
  }
  function jumpTo(key: string) {
    anchorKey = key
    alignTable(key, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth')
  }
  function move(direction: -1 | 1) {
    const table = tables[currentIndex + direction]
    if (table) jumpTo(tableSearchKey(table.table_schema, table.table_name))
  }
  $effect(() => {
    const keys = tables.map(table => tableSearchKey(table.table_schema, table.table_name))
    let cancelled = false
    // Selection and catalog sorting may change independently of scroll position.
    untrack(() => {
      if (!keys.includes(activeKey)) { stopJump(); activeKey = keys[0] ?? '' }
    })
    void tick().then(() => {
      if (cancelled) return
      resizeObserver?.disconnect()
      resizeObserver = new ResizeObserver(() => {
        // Lazy documents can expand while travelling to a distant table.
        // Keep that target anchored until the user resumes manual navigation.
        if (anchorKey) alignTable(anchorKey, 'auto')
        else trackPosition()
      })
      tableNodes().forEach(node => resizeObserver!.observe(node))
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(trackPosition)
    })
    return () => { cancelled = true; resizeObserver?.disconnect() }
  })
  onDestroy(() => { cancelAnimationFrame(frame); clearTimeout(jumpTimer); resizeObserver?.disconnect() })
  async function revealReference(schema: string, table: string) {
    const key = tableSearchKey(schema, table)
    app.checkedTables = new Set([...app.checkedTables, key])
    await tick()
    jumpTo(key)
  }
</script>

<svelte:window onkeydown={(event) => { if (event.target instanceof Node && documents?.contains(event.target)) stopJump() }} />

<section class="multi-detail" aria-label="多表文档">
  {#if tables.length}
    <nav class="multi-navigation" aria-label="已选表快速跳转">
      <label for="selected-table-jump">已选表</label>
      <select id="selected-table-jump" aria-label="跳转到已选表" value={currentKey} title={tables[currentIndex] ? `${tables[currentIndex].table_schema}.${tables[currentIndex].table_name}` : ''}
        onchange={(event) => jumpTo(event.currentTarget.value)}>
        {#each tables as table, index (tableSearchKey(table.table_schema, table.table_name))}
          <option value={tableSearchKey(table.table_schema, table.table_name)}>{index + 1}. {table.table_schema ? `${table.table_schema}.` : ''}{table.table_name}{table.table_comment ? ` · ${table.table_comment}` : ''}</option>
        {/each}
      </select>
      <span class="nav-position" role="status" aria-label={`当前第 ${currentIndex + 1} 张，共 ${tables.length} 张已选表`}>{currentIndex + 1} / {tables.length}</span>
      <button class="icon-btn" aria-label="上一张已选表" title="上一张已选表" disabled={currentIndex === 0} onclick={() => move(-1)}><Icon name="back" size={14} /></button>
      <button class="icon-btn" aria-label="下一张已选表" title="下一张已选表" disabled={currentIndex >= tables.length - 1} onclick={() => move(1)}><Icon name="arrow" size={14} /></button>
    </nav>
  {/if}
  <div class="multi-documents" role="region" aria-label="已选表文档列表" bind:this={documents} onscroll={onScroll} onwheel={stopJump} ontouchstart={stopJump} onpointerdown={stopJump}>
    {#each tables as table (tableSearchKey(table.table_schema, table.table_name))}
      <MultiTableItem state={app} {table} current={tableSearchKey(table.table_schema, table.table_name) === currentKey} {sourceVersion} {dense} {ondensitychange} {load} {onsql} {onexport} {onrefresh} onreferenced={(schema, name) => void revealReference(schema, name)} />
    {:else}
      <EmptyState icon="table" title="选择要查看的表" description="点击左侧目录中的表，高亮表示已选中；右侧将按目录顺序连续展示。搜索或筛选不会清除已选表。" />
    {/each}
  </div>
</section>

<style>
  .multi-detail { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; overflow: hidden; background: var(--bg); }
  .multi-navigation { flex: none; min-height: 34px; display: flex; align-items: center; gap: 6px; padding: 3px 10px; border-bottom: 1px solid var(--border); background: var(--panel); }
  .multi-navigation label { flex: none; color: var(--muted); font-size: 11px; }
  .multi-navigation select { flex: 1; width: 0; min-width: 0; max-width: 520px; padding: 4px 5px; border: 1px solid var(--border); border-radius: 4px; background: var(--panel); color: var(--text); font: 11px var(--mono); text-overflow: ellipsis; }
  .multi-navigation select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .multi-navigation .icon-btn { min-width: 24px; min-height: 24px; padding: 3px; }
  .nav-position { margin-left: auto; flex: none; color: var(--muted); font: 10px var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .multi-documents { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding: 10px; overscroll-behavior: contain; scroll-padding-top: 10px; }
  @media(max-width:600px) { .multi-navigation { padding: 3px 6px; gap: 4px; }.multi-documents { padding: 6px; gap: 10px; } }
</style>
