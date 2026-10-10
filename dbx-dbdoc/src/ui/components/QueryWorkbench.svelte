<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import { getBridge, isConnectionNotOpen, isDataAccessDenied } from '../../lib/bridge'
  import { createTableSelectSql, TABLE_QUERY_MAX_ROWS } from '../../lib/tableQuery'
  import { connectionSubtitle } from '../../lib/connectionLabels'
  import { maskUuids } from '../../lib/display/masking'
  import type { PluginContext, QueryResult } from '../../lib/types'
  import Icon from './Icon.svelte'

  let { context }: { context: PluginContext } = $props()
  let sql = $state('')
  let result = $state<QueryResult | null>(null)
  let executedSql = $state('')
  let busy = $state(false)
  let error = $state('')
  let copyState = $state<'idle' | 'ok' | 'fail'>('idle')
  let editor: HTMLTextAreaElement
  let generation = 0
  let lastIdentity = ''
  let disposed = false
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ Enter' : 'Ctrl Enter'
  const fullName = $derived([context.schema, context.table].filter(Boolean).join('.'))
  const identity = $derived(JSON.stringify([context.connectionId, context.database, context.schema, context.table, context.dbType]))
  const dataAvailable = $derived(getBridge()?.capabilities?.dataApi === true)
  const canExecute = $derived(Boolean(context.connectionId && sql.trim() && !busy && dataAvailable))

  $effect(() => {
    if (identity === lastIdentity) return
    lastIdentity = identity
    generation += 1
    busy = false
    result = null
    executedSql = ''
    error = ''
    try { sql = createTableSelectSql(context) }
    catch (err) { sql = ''; error = err instanceof Error ? err.message : String(err) }
    void tick().then(() => { if (!disposed) editor?.focus() })
  })
  $effect(() => { document.title = `${fullName || '表查询'} · 表查询` })
  onDestroy(() => { disposed = true; generation += 1; clearTimeout(copyTimer) })

  async function execute() {
    if (!canExecute) return
    const bridge = getBridge()
    if (!bridge || !context.connectionId) return
    const request = { connectionId: context.connectionId, database: context.database, schema: context.schema,
      sql: sql.trim(), maxRows: TABLE_QUERY_MAX_ROWS }
    const current = ++generation
    busy = true
    error = ''
    result = null
    try {
      const response = await bridge.queryData(request)
      if (disposed || current !== generation) return
      result = response
      executedSql = request.sql
    } catch (err) {
      if (disposed || current !== generation) return
      error = isConnectionNotOpen(err) ? '数据库会话已关闭，请在 DBX 中打开当前数据库后重试。'
        : isDataAccessDenied(err) ? '数据访问未授权，请重新打开此查询页，并在 DBX 提示中允许访问。'
          : maskUuids(err instanceof Error ? err.message : String(err))
    } finally { if (!disposed && current === generation) busy = false }
  }
  function keydown(event: KeyboardEvent) {
    if (!event.isComposing && (event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault(); void execute()
    }
  }
  async function copySql() {
    const ok = await getBridge()?.copyText(sql)
    if (disposed) return
    copyState = ok ? 'ok' : 'fail'
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => copyState = 'idle', 1400)
  }
  function cellText(value: unknown): string {
    if (value == null) return 'NULL'
    if (typeof value === 'object') return JSON.stringify(value) ?? ''
    return String(value)
  }
</script>

<main class="query-workbench">
  <header class="query-head">
    <strong><Icon name="code" size={17} />表查询</strong>
    <span class="query-table" title={fullName}>{fullName || '未选择表'}</span>
    <span class="query-scope" title={`${connectionSubtitle(context)} / ${context.database || '默认数据库'}`}>{context.database || '默认数据库'}</span>
  </header>
  <section class="query-editor" aria-label="查询编辑器">
    <div class="query-toolbar"><label for="query-sql">SQL <span>只读查询 · 最多 {TABLE_QUERY_MAX_ROWS} 行</span></label>
      <button class="btn" disabled={!sql} onclick={copySql}><Icon name={copyState === 'ok' ? 'check' : 'copy'} size={15} />{copyState === 'ok' ? '已复制' : copyState === 'fail' ? '复制失败' : '复制 SQL'}</button>
      <button class="btn btn-primary" disabled={!canExecute} title={`执行查询（${shortcut}）`} onclick={() => void execute()}>{#if busy}<span class="spinner"></span>{:else}<Icon name="arrow" size={15} />{/if}{busy ? '查询中…' : '执行查询'}<kbd>{shortcut}</kbd></button>
    </div>
    <textarea id="query-sql" class="resize-none" bind:this={editor} bind:value={sql} onkeydown={keydown} spellcheck="false" aria-label="查询 SQL" placeholder="SELECT * FROM 表名;"></textarea>
    {#if !dataAvailable}<p class="query-error" role="alert">当前 DBX 版本未提供只读查询，请升级后重试；SQL 仍可复制。</p>{/if}
    {#if error}<p class="query-error" role="alert">{error}</p>{/if}
  </section>
  <section class="query-results" aria-label="查询结果" aria-busy={busy}>
    <div class="query-result-head" role="status" aria-live="polite"><strong>查询结果</strong><span>{busy ? '正在读取…' : result ? `${result.rows.length} 行 · ${result.columns.length} 列${result.elapsedMs == null ? '' : ` · ${result.elapsedMs} ms`}` : '尚未执行'}</span>
      {#if result && sql.trim() !== executedSql}<span class="query-changed">SQL 已修改，结果来自上次查询</span>{/if}
    </div>
    {#if result?.columns.length}
      <!-- 原生滚动区域需要焦点，键盘用户才能滚动宽结果；内部仍保留标准 table 语义。 -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="query-grid" tabindex="0" role="region" aria-label="查询数据，可滚动"><table>
        <thead><tr><th scope="col" class="row-number">#</th>{#each result.columns as column}<th scope="col" title={column.dataType}>{column.name}</th>{/each}</tr></thead>
        <tbody>{#each result.rows as row, index}<tr><td class="row-number">{index + 1}</td>{#each result.columns as _, columnIndex}{@const value = row[columnIndex]}<td class:null-cell={value == null} title={cellText(value)}>{cellText(value).slice(0, 2000)}</td>{/each}</tr>{/each}</tbody>
      </table>{#if !result.rows.length}<div class="query-empty">未查到记录</div>{/if}</div>
    {:else}
      <div class="query-empty">{#if busy}<span class="spinner"></span><strong>正在执行查询</strong>{:else if result}<Icon name="table" size={25} /><strong>未查到记录</strong>{:else}<Icon name="code" size={25} /><strong>{error ? '查询尚未完成' : 'SQL 已准备好'}</strong><span>{#if !context.connectionId || !sql.trim()}请从数据库文档的表目录中双击目标表{:else if !dataAvailable}可复制 SQL，在 DBX 查询编辑器中执行{:else}点击执行查询，或在编辑器中按 {shortcut}{/if}</span>{/if}</div>
    {/if}
    {#if result?.truncated}<p class="query-limit" role="status">结果已截断，当前显示 {result.rows.length} 行。可调整 SQL 的筛选条件查看所需记录。</p>{/if}
  </section>
</main>

<style>
  .query-workbench { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .query-head { display: flex; align-items: center; gap: 14px; min-height: 49px; padding: 10px 20px; background: var(--panel); border-bottom: 1px solid var(--border); }
  .query-head strong { display: flex; align-items: center; gap: 7px; font-size: 13px; white-space: nowrap; }
  .query-table { font: 12px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .query-scope { margin-left: auto; color: var(--muted); font-size: 11px; max-width: 35%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .query-editor { flex: none; padding: 12px 20px; border-bottom: 1px solid var(--border); background: var(--panel); }
  .query-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
  label { flex: 1; font-size: 12px; font-weight: 600; }
  label span { margin-left: 10px; font-weight: 400; color: var(--muted); font-size: 11px; }
  kbd { font: 10px var(--mono); opacity: .85; margin-left: 4px; }
  textarea { display: block; width: 100%; height: clamp(100px, 22vh, 200px); min-height: 80px; max-height: 40vh; resize: none; padding: 12px; border: 1px solid var(--border); border-radius: 6px; color: var(--text); background: var(--bg); font: 13px/1.7 var(--mono); tab-size: 2; }
  textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .query-error { margin: 9px 0 0; color: var(--danger); font-size: 12px; overflow-wrap: anywhere; }
  .query-results { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .query-result-head { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 11px 20px; font-size: 12px; border-bottom: 1px solid var(--border); }
  .query-result-head span { color: var(--muted); font-size: 11px; }
  .query-result-head .query-changed { margin-left: auto; color: var(--accent); }
  .query-grid { flex: 1; min-height: 0; overflow: auto; background: var(--panel); }
  table { border-collapse: separate; border-spacing: 0; width: max-content; min-width: 100%; font: 12px var(--mono); }
  th, td { text-align: left; padding: 9px 14px; border-right: 1px solid var(--border-weak); border-bottom: 1px solid var(--border-weak); max-width: 420px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  th { position: sticky; top: 0; background: var(--bg); z-index: 1; font-weight: 600; }
  tbody tr:hover { background: var(--row-hover); }
  .row-number { width: 48px; color: var(--muted); text-align: right; }
  .null-cell { color: var(--muted); font-style: italic; }
  .query-empty { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 9px; padding: 30px; color: var(--muted); font-size: 12px; text-align: center; }
  .query-empty strong { color: var(--text); font-size: 13px; }
  .query-limit { margin: 0; padding: 9px 20px; font-size: 11px; color: var(--muted); border-top: 1px solid var(--border); }
  @media(max-width:760px) { .query-head { padding: 10px 12px; gap: 10px; }.query-editor { padding: 10px 12px; }.query-toolbar { flex-wrap: wrap; }label { flex-basis: 100%; }label span { margin-left: 8px; }.query-result-head { padding: 10px 12px; }.query-result-head .query-changed { flex-basis: 100%; margin-left: 0; }.query-limit { padding: 9px 12px; } }
</style>
