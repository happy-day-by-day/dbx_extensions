<script lang="ts">
  import { tick } from 'svelte'
  import type { AppState } from '../state.svelte'
  import type { DbTable } from '../../lib/dialects/entities'
  import type { TableDetail } from '../../lib/markdown'
  import { selectedCatalogTables } from '../../lib/display/catalog'
  import { tableSearchKey } from '../../lib/display/columnSearch'
  import MultiTableItem from './MultiTableItem.svelte'
  import EmptyState from './EmptyState.svelte'
  let { state: app, sourceVersion, dense, ondensitychange, load, onsql, onexport, onrefresh }: {
    state: AppState; sourceVersion: number; dense: boolean
    ondensitychange: (dense: boolean) => void; load: (table: DbTable) => Promise<TableDetail>
    onsql: (state: AppState) => void; onexport: (state: AppState) => void; onrefresh: () => void
  } = $props()
  const tables = $derived(selectedCatalogTables(app.catalog, app.checkedTables, app.catalogSort))
  let documents: HTMLDivElement
  async function revealReference(schema: string, table: string) {
    const key = tableSearchKey(schema, table)
    app.checkedTables = new Set([...app.checkedTables, key])
    await tick()
    const target = [...documents.querySelectorAll<HTMLElement>('[data-table]')].find(node => node.dataset.table === key)
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
</script>

<section class="multi-detail" aria-label="多表文档">
  <div class="multi-documents" bind:this={documents}>
    {#each tables as table (tableSearchKey(table.table_schema, table.table_name))}
      <MultiTableItem state={app} {table} {sourceVersion} {dense} {ondensitychange} {load} {onsql} {onexport} {onrefresh} onreferenced={(schema, name) => void revealReference(schema, name)} />
    {:else}
      <EmptyState icon="table" title="选择要查看的表" description="点击左侧目录中的表，高亮表示已选中；右侧将按目录顺序连续展示。搜索或筛选不会清除已选表。" />
    {/each}
  </div>
</section>

<style>
  .multi-detail { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; overflow: hidden; background: var(--bg); }
  .multi-documents { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; overscroll-behavior: contain; }
</style>
