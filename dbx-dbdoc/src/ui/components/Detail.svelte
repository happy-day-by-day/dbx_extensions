<script lang="ts">
  import { onDestroy } from 'svelte'
  import type { AppState } from '../state.svelte'
  import type { DbColumn } from '../../lib/dialects/entities'
  import { getBridge, isConnectionNotOpen } from '../../lib/bridge'
  import { mysqlAdapter } from '../../lib/dialects/mysql'
  import { splitHighlight } from '../../lib/display/highlight'
  import { compileFilterPattern } from '../../lib/display/filters'
  import { groupRows } from '../../lib/display/groups'
  import { maskUuids } from '../../lib/display/masking'
  import { databaseIndexDirection, databaseIndexDisplayTitle, databaseIndexKindLabel } from '../../lib/display/indexDisplay'
  import { databaseTypeKindLabel, typeCssClass } from '../../lib/display/typeDisplay'
  import EmptyState from './EmptyState.svelte'
  import Icon from './Icon.svelte'

  let { state: app, onsql, onexport, onretry }: { state: AppState; onsql: () => void; onexport: () => void; onretry: () => void } = $props()
  const tab = $derived(app.detailTab)
  let keyword = $state('')
  let uncommented = $state(false)
  let dense = $state(false)
  let copyMessage = $state('')
  let infoExpanded = $state(false)
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  let degradedColumns = $state<DbColumn[]>([])
  let degradedLoading = $state(false)
  let degradedError = $state('')
  let degradedNonce = $state(0)
  let body = $state<HTMLDivElement>()
  let fieldSearchInput = $state<HTMLInputElement>()
  const columns = $derived(app.degraded ? degradedColumns : app.detail?.columns ?? [])
  const indexGroups = $derived(groupRows(app.detail?.indexes ?? [], (row) => row.index_name))
  const constraintGroups = $derived(groupRows(app.detail?.constraints ?? [], (row) => row.constraint_name))
  const pattern = $derived(compileFilterPattern(keyword.trim()).regex)
  // 目录关键词只参与高亮；字段过滤只使用右侧手动输入的关键词。
  const fieldHighlightPattern = $derived(compileFilterPattern(keyword.trim() || (!app.catalogSearch.regexMode ? app.catalogSearch.keyword : '')).regex)
  const tablePattern = $derived(compileFilterPattern(app.catalogSearch.keyword, app.catalogSearch.regexMode).regex)
  const filteredColumns = $derived(columns.filter((column) => {
    if (uncommented && column.column_comment.trim()) return false
    return !pattern || [column.column_name, column.column_type, column.column_comment, column.column_default ?? ''].some((value) => pattern.test(value))
  }))
  const indexesByColumn = $derived.by(() => {
    const result = new Map<string, typeof indexGroups>()
    for (const group of indexGroups) for (const row of group.rows) {
      const existing = result.get(row.column_name) ?? []
      if (!row.is_expression && !existing.some((item) => item.name === group.name)) result.set(row.column_name, [...existing, group])
    }
    return result
  })
  const fullName = $derived([app.selectedSchema, app.selectedTable].filter(Boolean).join('.'))
  const loading = $derived(app.degraded ? degradedLoading : app.detailLoading)
  const error = $derived(app.degraded ? degradedError : app.errorMessage)
  const loaded = $derived(app.degraded ? !loading && !error : Boolean(app.detail))

  $effect(() => {
    app.selectedTable; app.selectedSchema; app.ctx.connectionId; app.ctx.database
    keyword = ''; uncommented = false; infoExpanded = false
    if (body) body.scrollTop = 0
  })
  $effect(() => {
    degradedNonce
    const table = app.selectedTable
    const ctx = { ...app.ctx }
    if (!app.degraded || !table || !ctx.connectionId) return
    let active = true
    degradedColumns = []
    degradedLoading = true
    degradedError = ''
    void getBridge()?.getTableMetadata({ connectionId: ctx.connectionId, database: ctx.database, schema: ctx.schema, table })
      .then((meta) => {
        if (active) degradedColumns = meta.columns.map((column, i) => mysqlAdapter.mapColumn({
          column_name: column.name, column_type: column.dataType, data_type: column.dataType,
          column_default: column.default, is_nullable: column.nullable ? 'YES' : 'NO', ordinal_position: i + 1
        }))
      }).catch((err) => { if (active) degradedError = err instanceof Error ? err.message : String(err) })
      .finally(() => { if (active) degradedLoading = false })
    return () => { active = false }
  })
  onDestroy(() => clearTimeout(copyTimer))
  async function copy(value: string) {
    copyMessage = await getBridge()?.copyText(value) ? '已复制到剪贴板' : '复制失败，请手动选择文本复制'
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => (copyMessage = ''), 2200)
  }
  function openReferenced(schema: string, table: string) {
    const found = app.catalog.find((row) => row.table_name === table && row.table_schema === schema)
    if (!found) return
    app.navigateTable(schema, table, 'columns')
  }
  function switchTab(next: typeof tab) { app.detailTab = next; if (body) body.scrollTop = 0 }
</script>

<svelte:window onclick={(event) => {
  if (infoExpanded && event.target instanceof Element && !event.target.closest('.table-info')) infoExpanded = false
}} onkeydown={(event) => {
  if (event.key === 'Escape' && infoExpanded && !body?.closest('[inert]')) {
    infoExpanded = false; event.preventDefault(); return
  }
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing
    || body?.closest('[inert]') || (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable="true"]'))) return
  if (event.key === 'ArrowLeft' && app.canGoBack) { event.preventDefault(); app.goBack() }
  else if (event.key === 'ArrowRight' && app.canGoForward) { event.preventDefault(); app.goForward() }
}} />

<section class="detail" aria-label="表文档" aria-busy={loading}>
  {#if !app.selectedTable}
    <EmptyState icon="table" title="选择一张表开始浏览" description="在目录中搜索表名或业务注释，查看字段、索引和约束。" />
  {:else}
    <header class="detail-header">
      <div class="detail-title-row"><div class="table-identity"><h1 title={fullName}>{#each splitHighlight(app.selectedTable, tablePattern) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</h1>
        <button class="icon-btn" title="复制完整表名" aria-label="复制完整表名" onclick={() => void copy(fullName)}><Icon name="copy" size={15} /></button></div>
        <div class="table-navigation" role="group" aria-label="表浏览历史"><button class="icon-btn" aria-label="返回上一张表" title="返回上一张表（Alt + ←）" disabled={!app.canGoBack} onclick={() => app.goBack()}><Icon name="back" size={15} /></button><button class="icon-btn" aria-label="前进到下一张表" title="前进到下一张表（Alt + →）" disabled={!app.canGoForward} onclick={() => app.goForward()}><Icon name="arrow" size={15} /></button></div>
        {#if !app.degraded}<div class="detail-actions"><button class="btn" aria-label="建表 SQL" title="建表 SQL" onclick={onsql} disabled={!app.detail || loading}><Icon name="code" size={15} /><span>建表 SQL</span></button>
          <button class="btn" aria-label="导出本表" title="导出本表" onclick={onexport} disabled={!app.detail || loading}><Icon name="export" size={15} /><span>导出本表</span></button></div>{/if}
      </div>
      <div class="detail-meta">
        {#if app.selectedSchema && app.selectedSchema !== app.ctx.database}<span class="detail-schema" title={app.selectedSchema}>{app.selectedSchema}</span>{/if}
        <p class="detail-comment" title={app.detail?.table.table_comment || ''}>{#each splitHighlight(app.detail?.table.table_comment || (loading ? '正在读取表结构…' : '暂无表注释'), tablePattern) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</p>
        <details class="table-info" bind:open={infoExpanded}>
          <summary title="查看完整表名、注释与数据库属性">表信息<Icon name="down" size={12} /></summary>
          <div class="table-info-panel"><dl>
            <dt>数据库</dt><dd>{app.ctx.database || '—'}</dd>
            {#if app.selectedSchema}<dt>Schema</dt><dd>{app.selectedSchema}</dd>{/if}
            <dt>表名</dt><dd>{app.selectedTable}</dd>
            <dt>注释</dt><dd>{app.detail?.table.table_comment || '暂无表注释'}</dd>
            {#if app.detail?.table.engine}<dt>存储引擎</dt><dd>{app.detail.table.engine}</dd>{/if}
            {#if app.detail?.table.table_collation}<dt>排序规则</dt><dd>{app.detail.table.table_collation}</dd>{/if}
          </dl></div>
        </details>
      </div>
      {#if copyMessage}<div class="copy-feedback" role="status">{copyMessage}</div>{/if}
    </header>
    {#if app.degraded}<div class="notice">{app.dbType} 当前只提供基础字段，注释、索引和约束不可用。</div>{/if}
    {#if error && !loading}<div class="detail-errorbar" role="alert"><span>{isConnectionNotOpen(error) ? '当前数据库会话已关闭。请在 DBX 中重新连接并打开目标数据库，然后重试。' : maskUuids(error)}</span><button class="btn" onclick={() => app.degraded ? degradedNonce += 1 : onretry()}>重试</button></div>{/if}
    {#if app.detail?.warnings?.length}<div class="notice" role="status">{#each app.detail.warnings as warning}<div>{maskUuids(warning)}</div>{/each}</div>{/if}
    <div class="detail-tabs" role="tablist" aria-label="表结构类型">
      {#each [{ id: 'columns', label: '字段', count: columns.length }, { id: 'indexes', label: '索引', count: indexGroups.length }, { id: 'constraints', label: '约束', count: constraintGroups.length }] as item}
        <button role="tab" id={`tab-${item.id}`} aria-selected={tab === item.id} aria-controls="detail-content" class:tab-active={tab === item.id}
          disabled={app.degraded && item.id !== 'columns'} onclick={() => switchTab(item.id as typeof tab)}>{item.label}<span>{item.count}</span></button>
      {/each}
    </div>
    <div class="detail-body" class:fields-content={tab === 'columns' && loaded && !loading} bind:this={body} id="detail-content" role="tabpanel" aria-labelledby={`tab-${tab}`} tabindex="0">
      {#if loading}<div class="detail-skeleton" role="status"><span class="spinner"></span>正在读取 {app.selectedTable} 的表结构…<div></div><div></div><div></div><div></div></div>
      {:else if loaded}
        {#if tab === 'columns'}
          <div class="fields-toolbar"><div class="field-search"><Icon name="search" size={15} /><input bind:this={fieldSearchInput} type="search" aria-label="搜索当前表字段" placeholder="搜索字段名、类型或注释…" bind:value={keyword} />{#if keyword}<button class="icon-btn" aria-label="清空字段搜索" title="显示全部字段" onclick={() => { keyword = ''; fieldSearchInput?.focus() }}><Icon name="close" size={13} /></button>{/if}</div>
            {#if !app.degraded}<label><input type="checkbox" bind:checked={uncommented} />仅无注释</label>{/if}
            <div class="field-options"><span>{filteredColumns.length} / {columns.length} 个字段</span><button class="density-btn" class:chosen={dense} aria-pressed={dense} onclick={() => dense = !dense}><Icon name="grid" size={14} />紧凑</button></div>
          </div>
          {#if filteredColumns.length}
            <!-- 可滚动表格需要焦点以支持方向键 / PageDown，保留内部原生表格语义。 -->
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <div class="table-scroll" role="region" aria-label="字段列表" tabindex="0"><table class="detail-table" class:dense>
              <thead><tr><th>#</th><th>字段名</th><th>数据类型</th><th>可空</th><th>默认值</th>{#if !app.degraded}<th>键 / 索引</th><th>注释</th>{/if}</tr></thead>
              <tbody>{#each filteredColumns as column (column.column_name)}
                <tr><td>{column.ordinal_position ?? '—'}</td>
                  <td><button class="column-name" title="复制字段名" onclick={() => void copy(column.column_name)}>{#each splitHighlight(column.column_name, fieldHighlightPattern) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</button>
                    {#if column.is_identity || column.extra?.includes('auto_increment')}<span class="column-extra">自增</span>{/if}
                    {#if column.generation_expression}<span class="column-extra" title={column.generation_expression}>生成列</span>{/if}
                  </td>
                  <td><span class={typeCssClass(column.column_type)} title={databaseTypeKindLabel(column.column_type)}>{#each splitHighlight(column.column_type, pattern) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span></td>
                  <td><span class:nullable={column.is_nullable === 'YES'} class="nullability">{column.is_nullable === 'YES' ? '是' : '否'}</span></td>
                  <td class="default-cell" title={column.column_default ?? ''}><code>{#each splitHighlight(column.column_default === '' ? "''" : column.column_default ?? '—', pattern) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</code></td>
                  {#if !app.degraded}<td>{#each indexesByColumn.get(column.column_name) ?? [] as group (group.name)}
                    <button class="index-chip" class:primary={group.first.is_primary} title={databaseIndexDisplayTitle(group.first)} onclick={() => switchTab('indexes')}>{databaseIndexKindLabel(group.first)}</button>
                  {/each}</td><td class="comment-cell">{#if column.column_comment}{#each splitHighlight(column.column_comment, fieldHighlightPattern) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}{:else}<span class="muted">—</span>{/if}</td>{/if}
                </tr>
              {/each}</tbody>
            </table></div>
          {:else}<div class="section-empty">{columns.length ? '没有匹配的字段' : '暂无字段信息'}</div>{/if}
        {:else if tab === 'indexes'}
          {#if !indexGroups.length}<div class="section-empty">暂无索引</div>{/if}
          {#each indexGroups as group (group.name)}
            <article class="structure-card"><div class="structure-heading"><h2>{group.name}</h2><span class="index-chip" class:primary={group.first.is_primary}>{databaseIndexKindLabel(group.first)}</span><span class="muted">{group.first.index_type}</span></div>
              <div class="index-columns">{#each group.rows as row, i}<code>{row.is_included ? 'INCLUDE ' : ''}{row.expression || row.column_name}{row.sub_part ? `(${row.sub_part})` : ''}</code><span class="muted">{databaseIndexDirection(row)}</span>{#if i < group.rows.length - 1}<span class="muted">,</span>{/if}{/each}</div>
              {#if group.first.predicate}<p class="muted"><code>WHERE {group.first.predicate}</code></p>{/if}
              {#if group.first.index_comment}<p>{group.first.index_comment}</p>{/if}
            </article>
          {/each}
        {:else}
          {#if app.detail?.checksSupported === false}<p class="muted">当前数据库版本不提供检查约束元数据。</p>{/if}
          {#if !constraintGroups.length}<div class="section-empty">{app.detail?.checksSupported === false ? '暂无外键' : '暂无外键或检查约束'}</div>{/if}
          {#each constraintGroups as group (group.name)}
            <article class="structure-card"><div class="structure-heading"><h2>{group.name}</h2><span class="index-chip">{group.first.constraint_type === 'FOREIGN KEY' ? '外键' : '检查约束'}</span></div>
              {#if group.first.constraint_type === 'FOREIGN KEY'}
                <div class="constraint-relation"><code>{group.rows.map((row) => row.column_name).join(', ')}</code><span class="muted">→</span>
                  <button class="text-btn" title="查看关联表" disabled={!app.catalog.some((row) => row.table_name === group.first.referenced_table && row.table_schema === group.first.referenced_schema)}
                    onclick={() => openReferenced(group.first.referenced_schema, group.first.referenced_table)}>{group.first.referenced_schema}.{group.first.referenced_table}</button>
                  <code>({group.rows.map((row) => row.referenced_column).join(', ')})</code></div>
                <p class="muted">更新：{group.first.update_rule || '—'} · 删除：{group.first.delete_rule || '—'}</p>
              {:else}<pre>{group.first.check_clause}</pre>{/if}
            </article>
          {/each}
        {/if}
      {/if}
    </div>
  {/if}
</section>

<style>
  .detail { display: flex; flex-direction: column; position: relative; min-height: 0; overflow: hidden; background: var(--panel); }
  .detail-header { flex: none; padding: 10px 20px 8px; }
  .detail-title-row { display: flex; gap: 10px; align-items: center; min-height: 30px; }
  .table-identity { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }.table-identity .icon-btn { flex: none; }
  .table-navigation { display: flex; align-items: center; gap: 2px; flex: none; }
  h1 { margin: 0; font: 600 19px var(--mono); letter-spacing: -.35px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .detail-actions { display: flex; gap: 6px; flex: none; }.detail-actions .btn { min-height: 30px; padding: 4px 9px; font-size: 11px; }
  .detail-meta { display: flex; align-items: center; gap: 9px; margin-top: 3px; min-width: 0; color: var(--muted); font-size: 11px; }
  .detail-schema { max-width: 28%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); flex: none; border-right: 1px solid var(--border); padding-right: 9px; }
  .detail-comment { margin: 0; min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .table-info { position: relative; flex: none; }.table-info summary { display: flex; align-items: center; gap: 4px; padding: 2px 5px; border-radius: 4px; cursor: pointer; list-style: none; }.table-info summary::-webkit-details-marker { display: none; }.table-info summary:hover, .table-info[open] summary { color: var(--accent); background: var(--accent-weak); }.table-info summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }.table-info[open] summary :global(svg) { transform: rotate(180deg); }
  .table-info-panel { position: absolute; right: 0; top: calc(100% + 5px); z-index: 10; width: 360px; max-width: calc(100vw - 40px); max-height: min(360px, 50vh); overflow: auto; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); box-shadow: var(--shadow-md); color: var(--text); }.table-info-panel dl { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 8px 12px; margin: 0; }.table-info-panel dt { color: var(--muted); }.table-info-panel dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
  .copy-feedback { position: absolute; bottom: 18px; right: 24px; z-index: 5; max-width: calc(100% - 40px); padding: 10px 14px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow-md); color: var(--accent); font-size: 12px; pointer-events: none; }
  .detail-errorbar { margin: 8px 24px; padding: 10px 12px; border: 1px solid var(--danger); border-radius: 7px; display: flex; align-items: center; gap: 8px; color: var(--danger); overflow-wrap: anywhere; }
  .detail-errorbar span { flex: 1; }
  .detail-tabs { display: flex; flex: none; padding: 0 20px; border-bottom: 1px solid var(--border); gap: 22px; }
  .detail-tabs button { display: flex; gap: 6px; align-items: center; background: transparent; border: 0; border-bottom: 2px solid transparent; color: var(--muted); padding: 7px 2px; font-size: 12px; cursor: pointer; }
  .detail-tabs button.tab-active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
  .detail-tabs span { font: 10px var(--mono); background: var(--chip-bg); border-radius: 4px; padding: 1px 5px; }
  .detail-body { flex: 1; min-height: 0; overflow: auto; padding: 10px 20px 16px; overscroll-behavior: contain; }
  .detail-body.fields-content { display: flex; flex-direction: column; overflow: hidden; }
  .fields-toolbar { display: flex; flex: none; gap: 10px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
  .field-search { display: flex; gap: 7px; align-items: center; width: 270px; max-width: 100%; padding: 5px 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--muted); }
  .field-search:focus-within { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-weak); }
  .field-search input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font-size: 12px; }
  .field-search .icon-btn { padding: 0; min-height: 18px; min-width: 18px; flex: none; }
  .fields-toolbar label { display: flex; gap: 5px; align-items: center; font-size: 12px; color: var(--muted); }
  .field-options { display: flex; align-items: center; gap: 12px; margin-left: auto; color: var(--muted); font-size: 11px; white-space: nowrap; }
  .density-btn { display: flex; align-items: center; gap: 5px; border: 1px solid var(--border); border-radius: 6px; padding: 5px 7px; color: var(--muted); background: transparent; font-size: 11px; cursor: pointer; }.density-btn.chosen { background: var(--accent-weak); color: var(--accent); border-color: transparent; }
  .table-scroll { flex: 0 1 auto; min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: 9px; }
  .detail-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12px; }
  .detail-table th, .detail-table td { padding: 13px 14px; text-align: left; border-bottom: 1px solid var(--border-weak); vertical-align: top; }
  .detail-table.dense td { padding-top: 8px; padding-bottom: 8px; }
  .detail-table th { position: sticky; top: 0; z-index: 1; background: var(--bg); color: var(--muted); font-weight: 500; font-size: 11px; white-space: nowrap; border-bottom-color: var(--border); }
  .detail-table tr:last-child td { border-bottom: 0; }
  .detail-table tbody tr:hover { background: var(--row-hover); }
  .detail-table th:first-child, .detail-table td:first-child { width: 1%; text-align: right; color: var(--muted); white-space: nowrap; }
  .column-name { border: 0; background: none; padding: 0; color: var(--text); font: 500 12px var(--mono); white-space: nowrap; cursor: pointer; }
  .column-name:hover { color: var(--accent); }
  .column-extra { display: block; color: var(--muted); font-size: 10px; }
  .nullability { color: var(--text); font-size: 11px; }.nullability.nullable { color: var(--muted); }
  .default-cell { max-width: 230px; min-width: 55px; overflow-wrap: anywhere; color: var(--muted); }
  .comment-cell { min-width: 150px; max-width: 400px; overflow-wrap: anywhere; }
  .index-chip { display: inline-block; margin: 1px 4px 1px 0; border: 1px solid var(--border); border-radius: 4px; background: var(--chip-bg); color: var(--chip-text); font-size: 10px; padding: 1px 6px; white-space: nowrap; }
  button.index-chip { cursor: pointer; }.index-chip.primary { color: var(--accent); background: var(--accent-weak); border-color: transparent; }
  .structure-card { padding: 20px; border: 1px solid var(--border); border-radius: 11px; margin-bottom: 12px; }
  .structure-heading { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
  h2 { margin: 0; font: 600 13px var(--mono); overflow-wrap: anywhere; }
  .index-columns, .constraint-relation { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .structure-card p { font-size: 12px; margin: 10px 0 0; }.structure-card pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  .section-empty { text-align: center; color: var(--muted); padding: 55px 10px; }
  .detail-skeleton { color: var(--muted); font-size: 12px; }.detail-skeleton .spinner { display: inline-block; margin-right: 8px; vertical-align: middle; }
  .detail-skeleton div { height: 40px; background: var(--bg); border-radius: 5px; margin-top: 14px; }
  @media (max-width: 1100px) { .detail-actions .btn { width: 30px; padding: 5px; }.detail-actions .btn span { display: none; } }
  @media (max-width: 950px) { .detail-header { padding: 10px 14px 8px; }.detail-body { padding: 10px 14px 14px; }.detail-tabs { padding: 0 14px; } h1 { font-size: 17px; }.fields-toolbar { gap: 8px; }.field-search { width: 230px; } }
  @media (max-width: 480px) { .detail-title-row { gap: 6px; }.table-navigation { gap: 0; }.table-navigation .icon-btn { min-width: 26px; }.detail-actions { gap: 4px; }.fields-toolbar { gap: 6px 10px; }.field-search { flex: 1; min-width: 150px; }.field-options { width: 100%; }.field-options .density-btn { margin-left: auto; } }
</style>
