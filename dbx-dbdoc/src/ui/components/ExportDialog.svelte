<!-- 导出范围固定为生成时的快照；补全仅查询未成功的表，已生成内容始终保留。 -->
<script lang="ts">
  import Icon from './Icon.svelte'
  import { onDestroy } from 'svelte'
  import { getBridge } from '../../lib/bridge'
  import { getAdapter } from '../../lib/dialects/registry'
  import { maskUuids } from '../../lib/display/masking'
  import { connectionLabel } from '../../lib/connectionLabels'
  import { renderTableMarkdown } from '../../lib/markdown'
  import { mergeExportResult, remainingExportTables, renderExportResult } from '../../lib/exportResult'
  import { dateStamp } from '../../lib/date'
  import { exportSchema, type ExportSchemaResult } from '../../lib/store'
  import type { DbTable } from '../../lib/dialects/entities'
  import type { TableRef } from '../../lib/dialects/types'
  import type { AppState } from '../state.svelte'
  import { modalFocus } from '../modalFocus'

  // 局部变量命名为 app 而非 state：同名会让 $state(...) 被解析成 store 订阅（App/SqlDialog 同款约定）。
  let { state: app, initialMode = 'table', onclose }: { state: AppState; initialMode?: 'table' | 'schema'; onclose: () => void } = $props()

  type Phase = 'select' | 'exporting' | 'result' | 'error'
  interface ExportSnapshot { connectionId: string; dbType: string; title: string; ref: TableRef; tables: DbTable[]; truncated: boolean }

  // 入口决定默认范围；selectedTable 为空时「当前表」单选禁用。
  // svelte-ignore state_referenced_locally —— 初始值仅在弹窗打开时读取一次，刻意不追踪后续变化
  let mode = $state<'table' | 'schema'>(initialMode)
  let phase = $state<Phase>('select')
  let progress = $state({ done: 0, total: 0 })
  let errorMessage = $state('')
  let snapshot = $state<ExportSnapshot | null>(null)
  let result = $state<ExportSchemaResult>({ details: [], failed: [] })
  let stopped = $state(false)
  let completedBefore = $state(0)
  let saving = $state(false)
  let saveMessage = $state('')
  let alive = true
  let saved = $state(false)
  let saveAttempted = $state(false)
  let md = $state('')
  let fileName = $state('')
  // 停止后不再派发新任务，并等待在途读取结束。
  let cancelled = $state(false)

  // 整库可用性：降级模式无目录、dbType 未适配（getAdapter 为 null）不可整库导出
  const schemaExportable = $derived(!app.degraded && getAdapter(app.dbType) !== null)
  const scope = $derived(app.schemaFilter ? app.catalog.filter((table) => table.table_schema === app.schemaFilter) : app.catalog)
  const canExport = $derived(mode === 'table' ? Boolean(app.detail) && !app.detailLoading : schemaExportable && scope.length > 0)
  const remaining = $derived(snapshot ? remainingExportTables(snapshot.tables, result.details) : [])
  const total = $derived(snapshot?.tables.length ?? result.details.length)
  const unstarted = $derived(Math.max(0, remaining.length - result.failed.length))
  const retryLabel = $derived(unstarted ? `继续生成剩余 ${remaining.length} 张表` : `重试失败的 ${remaining.length} 张表`)

  // yyyyMMdd 本地日期文件名戳（ES2020 目标：不用 replaceAll）
  const stamp = (): string => dateStamp(true)

  function resetToSelect() {
    phase = 'select'
    progress = { done: 0, total: 0 }
    errorMessage = ''
    snapshot = null
    result = { details: [], failed: [] }
    stopped = false
    md = ''
    fileName = ''
    saveMessage = ''
    saved = false
    saveAttempted = false
  }

  // 生成中禁用关闭：遮罩点击与 Esc 均在 exporting 时忽略
  function requestClose() {
    if (phase === 'exporting') return
    onclose()
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') requestClose()
  }

  // md 就绪后落盘：'saved' → 已保存；'unsupported'（或 bridge 缺失）→ 全文回退
  async function persist() {
    const bridge = getBridge()
    if (!alive || saving || !md) return
    saving = true
    saveAttempted = true
    phase = 'exporting'
    try {
      const outcome = bridge ? await bridge.saveFile(fileName, md) : 'unsupported'
      if (!alive) return
      saved = outcome === 'saved'
      saveMessage = outcome === 'cancelled' ? '已取消保存；文档仍可复制或再次保存' : outcome === 'failed' ? '保存失败；文档仍可复制或再次保存' : ''
    } catch {
      if (alive) { saved = false; saveMessage = '保存失败；文档仍可复制或再次保存' }
    } finally { if (alive) { saving = false; phase = 'result' } }
  }

  async function generateRemaining(autoSave = false) {
    if (!snapshot || phase === 'exporting' || !remaining.length) return
    const target = snapshot
    const tables = [...remaining]
    phase = 'exporting'
    completedBefore = result.details.length
    cancelled = false
    stopped = false
    saved = false
    saveAttempted = false
    saveMessage = ''
    errorMessage = ''
    copyState = 'idle'
    try {
      const bridge = getBridge()
      const adapter = getAdapter(target.dbType)
      if (!bridge || !adapter) throw new Error('当前宿主无法读取元数据，请重新打开数据库文档')
      const batch = await exportSchema(bridge, adapter, target.connectionId, target.ref, tables, {
        concurrency: 2,
        onProgress: (done, total) => { if (alive) progress = { done, total } },
        shouldContinue: () => alive && !cancelled
      })
      if (!alive) return
      result = mergeExportResult(target.tables, result, batch)
      stopped = cancelled
      md = renderExportResult(target.title, result, target.dbType, target.tables.length, target.truncated, stopped)
      if (!result.details.length && !stopped) {
        errorMessage = '未能读取表结构。请恢复 DBX 中的数据库会话或数据访问授权后重试。'
        phase = 'error'
        return
      }
      phase = 'result'
      // 不完整或停止的文档先显示结果，用户可补全或明确保存已有部分。
      if (autoSave && !remainingExportTables(target.tables, result.details).length && !stopped) await persist()
      else if (!remainingExportTables(target.tables, result.details).length) saveMessage = '文档已补全，请保存更新后的文件。'
    } catch (err) {
      if (!alive) return
      errorMessage = err instanceof Error ? err.message : String(err)
      if (result.details.length) { saveMessage = `补全未完成：${maskUuids(errorMessage)}`; phase = 'result' }
      else phase = 'error'
    }
  }

  async function runExport() {
    // 在途闸门：导出中（含保存对话框期间）忽略重复点击
    if (phase === 'exporting') return
    if (!canExport) return
    errorMessage = ''
    result = { details: [], failed: [] }
    snapshot = null
    stopped = false
    saveMessage = ''
    saved = false
    saveAttempted = false
    try {
      if (mode === 'table') {
        const detail = app.detail
        if (!detail) return
        const base = [detail.table.table_schema, detail.table.table_name].filter(Boolean).join('_')
        result = { details: [detail], failed: [] }
        md = renderTableMarkdown(detail, app.dbType)
        fileName = safeFileName(`${base}_数据字典_${stamp()}.md`)
        await persist()
        return
      }
      const connectionId = app.ctx.connectionId
      if (!connectionId) throw new Error('请先选择连接和数据库')
      snapshot = { connectionId, dbType: app.dbType, title: connectionLabel(app.ctx),
        ref: { db: app.ctx.database ?? null, schema: null, table: null },
        tables: scope.map((table) => ({ ...table })), truncated: app.truncated }
      fileName = safeFileName(`${snapshot.title}_数据字典_${stamp()}.md`)
      await generateRemaining(true)
    } catch (err) {
      if (!alive) return
      errorMessage = err instanceof Error ? err.message : String(err)
      phase = 'error'
    }
  }

  // —— 复制反馈：成功「已复制 ✓」/ 失败「复制失败」，均 1400ms 后复位（SqlDialog 同款） ——
  let copyState = $state<'idle' | 'ok' | 'fail'>('idle')
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  onDestroy(() => { alive = false; cancelled = true; clearTimeout(copyTimer) })
  function safeFileName(value: string) { return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') }

  async function copyAll() {
    const ok = (await getBridge()?.copyText(md)) ?? false
    if (!alive) return
    copyState = ok ? 'ok' : 'fail'
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => (copyState = 'idle'), 1400)
  }

  const percent = $derived(progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0)
</script>

<svelte:window onkeydown={onKeydown} />

{#snippet failureList()}
  {#if result.failed.length}<details class="export-failures"><summary>查看读取失败的表（{result.failed.length}）</summary><ul>{#each result.failed as failure}<li>{[failure.schema, failure.table].filter(Boolean).join('.')}：{maskUuids(failure.message)}</li>{/each}</ul></details>{/if}
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div
  class="modal-mask"
  role="presentation"
  onclick={(e) => {
    // 仅点击遮罩自身时关闭；生成中忽略
    if (e.target === e.currentTarget) requestClose()
  }}
>
  <div class="modal-panel export-panel" use:modalFocus role="dialog" aria-modal="true" aria-label="导出数据字典">
    <header class="export-head"><h3 class="export-title"><Icon name="export" size={19} />导出数据字典</h3><button class="icon-btn" aria-label="关闭导出" title="关闭" disabled={phase === 'exporting'} onclick={requestClose}><Icon name="close" size={18} /></button></header>

    {#if phase === 'exporting'}
      <div class="export-progress" role="status" aria-live="polite">
        <div class="export-progress-label">{saving ? '正在保存文档…' : cancelled ? '正在停止，等待当前读取完成…' : `已完成 ${progress.done}/${progress.total} 张表 · ${percent}%`}</div>
        {#if !saving && completedBefore}<span class="export-note">已保留 {completedBefore} 张表，只读取剩余部分。</span>{/if}
        {#if !saving}<progress max={progress.total || 1} value={progress.done} aria-label="导出进度"></progress>{/if}
      </div>
      <footer class="export-foot">
        <button class="btn" disabled={saving || cancelled} onclick={() => (cancelled = true)}>{cancelled ? '正在停止…' : '停止生成并保留已完成部分'}</button>
      </footer>
    {:else if phase === 'result'}
      <div class="export-result">
        <div class="export-summary" role="status"><strong>已生成 {result.details.length} / {total} 张表</strong><span>{remaining.length ? [result.failed.length ? `${result.failed.length} 张读取失败` : '', unstarted ? `${unstarted} 张尚未读取` : ''].filter(Boolean).join(' · ') : '当前导出范围已完成'}</span></div>
        {#if stopped}<div class="export-note">已停止生成，已完成内容保留，可继续读取剩余表。</div>{/if}
        {#if snapshot?.truncated}<div class="notice">表清单被宿主截断，当前文档只包含已加载的表。</div>{/if}
        {#if saveMessage}<div class="export-note" role="status">{saveMessage}</div>{/if}
        {@render failureList()}
        <div class="export-note export-filename" title={fileName}>{fileName}</div>
        {#if saved}
          <div class="export-saved">已保存 ✓</div>
        {:else if md}
          <!-- 宿主不支持保存：全文 readonly textarea（max-height 滚动）+ 复制全文 -->
          <textarea class="export-md" aria-label="生成的 Markdown 文档" readonly rows="14" value={md}></textarea>
        {/if}
      </div>
      <footer class="export-foot">
        {#if md && !saved}<button class="btn" onclick={copyAll} title="复制 Markdown 全文到剪贴板"><Icon name={copyState === 'ok' ? 'check' : 'copy'} size={16} />{copyState === 'ok' ? '已复制' : copyState === 'fail' ? '复制失败' : '复制全文'}</button>{/if}
        {#if remaining.length}<button class="btn btn-primary" onclick={() => void generateRemaining()}><Icon name="refresh" size={16} />{retryLabel}</button>{/if}
        {#if md && !saved}<button class="btn" class:btn-primary={!remaining.length} onclick={() => void persist()}>{saveAttempted ? '再次保存' : remaining.length ? '保存已完成部分' : '保存文档'}</button>{/if}
        <button class="btn" onclick={onclose}>关闭</button>
      </footer>
    {:else if phase === 'error'}
      <div class="export-error" role="alert">导出失败：{maskUuids(errorMessage)}</div>
      {@render failureList()}
      <footer class="export-foot">
        {#if remaining.length}<button class="btn btn-primary" onclick={() => void generateRemaining()}>{retryLabel}</button>{/if}
        <button class="btn" onclick={resetToSelect}>重新选择范围</button>
        <button class="btn" onclick={onclose}>关闭</button>
      </footer>
    {:else}
      <div class="export-options">
        <label class="export-option" class:selected={mode === 'table'}>
          <input type="radio" name="export-mode" checked={mode === 'table'} disabled={!app.selectedTable} onchange={() => (mode = 'table')} />
          <Icon name="table" size={22} /><span class="export-option-label"><strong>当前表</strong><small title={app.selectedTable ?? ''}>{app.selectedTable ?? '（未选中）'} · 字段、索引和约束</small></span>
        </label>
        <label class="export-option" class:selected={mode === 'schema'}>
          <input type="radio" name="export-mode" checked={mode === 'schema'} disabled={!schemaExportable} onchange={() => (mode = 'schema')} />
          <Icon name="database" size={22} /><span class="export-option-label"><strong>{app.schemaFilter ? `当前 Schema「${app.schemaFilter}」` : '整个数据库'}</strong><small>{scope.length} 张表 · 按当前目录范围生成数据字典</small></span>
        </label>
      </div>
      {#if app.schemaFilter}
        <div class="export-note">导出范围按目录中的 Schema 筛选确定。</div>
      {/if}
      {#if app.truncated}<div class="notice">表清单已截断，导出仅包含已加载的表。</div>{/if}
      <footer class="export-foot">
        <button class="btn btn-primary" onclick={runExport} disabled={!canExport}><Icon name="export" size={16} />导出</button>
        <button class="btn" onclick={onclose}>取消</button>
      </footer>
    {/if}
  </div>
</div>

<style>
  .export-panel {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .export-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .export-title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .export-options {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .export-option {
    display: flex;
    align-items: center;
    gap: 14px;
    cursor: pointer;
    padding: 18px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg);
  }
  .export-option.selected { background: var(--accent-weak); border-color: var(--accent); }.export-option :global(svg) { color: var(--muted); }.export-option.selected :global(svg) { color: var(--accent); }

  .export-option:has(input:disabled) {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .export-option-label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .export-option-label strong { font-weight: 600; }.export-option-label small { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; }

  .export-progress {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .export-progress-label {
    font-size: 12px;
    color: var(--muted);
  }

  progress { width: 100%; height: 8px; accent-color: var(--accent); }

  .export-result {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .export-summary { display: flex; flex-direction: column; gap: 4px; padding: 13px 15px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); }
  .export-summary strong { font-size: 15px; font-weight: 600; }
  .export-summary span { color: var(--muted); font-size: 12px; }
  .export-failures { font-size: 12px; overflow-wrap: anywhere; }
  .export-failures summary { cursor: pointer; color: var(--danger); }
  .export-failures ul { padding-left: 20px; max-height: 150px; overflow: auto; }

  .export-note {
    color: var(--muted);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: normal;
  }

  .export-filename {
    font-family: var(--mono);
  }

  .export-saved {
    padding: 8px 0;
  }

  .export-md {
    margin: 0;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.6;
    white-space: pre;
    overflow: auto;
    max-height: 48vh;
    resize: vertical;
    color: var(--text);
  }

  .export-error {
    color: var(--danger);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .export-foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
    border-top: 1px solid var(--border);
    padding-top: 16px;
  }
</style>
