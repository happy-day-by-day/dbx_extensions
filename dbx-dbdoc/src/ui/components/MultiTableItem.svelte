<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { createAppState, type AppState } from '../state.svelte'
  import type { DbTable } from '../../lib/dialects/entities'
  import type { TableDetail } from '../../lib/markdown'
  import Detail from './Detail.svelte'

  let { state: parent, table, sourceVersion, dense, ondensitychange, load, onsql, onexport, onrefresh, onreferenced }: {
    state: AppState; table: DbTable; sourceVersion: number; dense: boolean
    ondensitychange: (dense: boolean) => void
    load: (table: DbTable) => Promise<TableDetail>
    onsql: (state: AppState) => void; onexport: (state: AppState) => void
    onrefresh: () => void; onreferenced: (schema: string, table: string) => void
  } = $props()
  const item = createAppState()
  const instanceId = $props.id()
  let container: HTMLDivElement
  let visible = $state(false)
  let retry = $state(0)
  onMount(() => {
    if (typeof IntersectionObserver === 'undefined') { visible = true; return }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { visible = true; observer.disconnect() }
    }, { rootMargin: '600px' })
    observer.observe(container)
    return () => observer.disconnect()
  })
  $effect(() => {
    if (!visible) return
    const ctx = { ...parent.ctx }, dbType = parent.dbType, offline = parent.offline
    const catalog = parent.catalog
    untrack(() => {
      item.ctx = ctx; item.dbType = dbType; item.offline = offline
      item.catalog = catalog
    })
  })
  $effect(() => { item.catalogSearch = parent.catalogSearch })
  $effect(() => {
    if (!visible) return
    const selected = table
    sourceVersion; retry
    let active = true
    untrack(() => item.navigateTable(selected.table_schema, selected.table_name))
    item.detail = null
    item.detailLoading = true
    item.errorMessage = ''
    // Capture this resource now without tracking the loader's internal state reads.
    void untrack(() => load(selected)).then(detail => {
      if (active) item.detail = detail
    }).catch(error => {
      if (active) item.errorMessage = error instanceof Error ? error.message : String(error)
    }).finally(() => { if (active) item.detailLoading = false })
    return () => { active = false }
  })
</script>

<div class="multi-table-item" bind:this={container} data-table={JSON.stringify([table.table_schema, table.table_name])}>
  {#if visible}
    <Detail state={item} {dense} {ondensitychange} embedded {instanceId} {onreferenced}
      onsql={() => onsql(item)} onexport={() => onexport(item)} onretry={() => parent.offline ? onrefresh() : retry += 1} />
  {:else}
    <div class="placeholder" role="status"><strong>{table.table_schema}.{table.table_name}</strong><span>滚动到此处读取文档…</span></div>
  {/if}
</div>

<style>
  .multi-table-item { flex: none; min-width: 0; scroll-margin-top: 0; border-bottom: 1px solid var(--border); }
  .placeholder { min-height: 120px; padding: 12px; display: flex; flex-direction: column; gap: 10px; color: var(--muted); font-size: 12px; }
  .placeholder strong { font-family: var(--mono); overflow-wrap: anywhere; }
</style>
