<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { getBridge } from '../../lib/bridge'
  import { discoverBatchTargets, createBatchItems, refreshBatch, type BatchItem, type BatchTarget, type BatchDiscoveryIssue } from '../../lib/batchRefresh'
  import type { DocumentResource } from '../../lib/resources'
  import { maskUuids } from '../../lib/display/masking'
  import { modalFocus } from '../modalFocus'
  import Icon from './Icon.svelte'

  let { documents, onclose, onupdated }: { documents: DocumentResource[]; onclose: () => void; onupdated: (target: BatchTarget) => void } = $props()
  let phase = $state<'discovering' | 'ready' | 'running' | 'done' | 'error'>('discovering')
  let items = $state<BatchItem[]>([])
  let error = $state('')
  let discoveryStatus = $state('正在检查 DBX 连接状态…')
  let discoveryIssues = $state<BatchDiscoveryIssue[]>([])
  let stopping = $state(false)
  let alive = true
  const busy = $derived(phase === 'running' || phase === 'discovering')
  const finished = $derived(items.filter((item) => !['pending', 'running'].includes(item.state)).length)
  const success = $derived(items.filter((item) => item.state === 'success').length)
  const failed = $derived(items.filter((item) => item.state === 'failed').length)
  const skipped = $derived(items.filter((item) => item.state === 'skipped').length)
  const cancelled = $derived(items.filter((item) => item.state === 'cancelled').length)
  const labels = { pending: '等待', running: '生成中', success: '已完成', failed: '失败', skipped: '已跳过', cancelled: '未生成' }

  onMount(() => { void discover() })
  onDestroy(() => { alive = false; stopping = true })

  async function discover() {
    phase = 'discovering'; error = ''; items = []; stopping = false; discoveryIssues = []; discoveryStatus = '正在检查 DBX 连接状态…'
    try {
      const bridge = getBridge()
      if (!bridge) throw new Error('请在 DBX 中打开数据库文档')
      const targets = await discoverBatchTargets(bridge, documents, {
        shouldContinue: () => alive,
        onConnection: (name, current, total) => { if (alive) discoveryStatus = `正在读取「${name}」的数据库 · ${current} / ${total}` },
        onIssue: (issue) => { if (alive) discoveryIssues = [...discoveryIssues, issue] }
      })
      if (alive) { items = createBatchItems(targets); phase = 'ready' }
    } catch (err) {
      if (alive) { error = maskUuids(err instanceof Error ? err.message : String(err)); phase = 'error' }
    }
  }
  async function start() {
    const bridge = getBridge()
    if (!bridge || phase !== 'ready' || !items.length) return
    phase = 'running'; stopping = false
    try {
      await refreshBatch(bridge, items.map((item) => item.target), {
        shouldContinue: () => alive && !stopping,
        onUpdate: (updated) => { if (alive) items = items.map((item) => item.key === updated.key ? updated : item) },
        onCommitted: (target) => { if (alive) onupdated(target) }
      })
      if (alive) phase = 'done'
    } catch (err) {
      if (alive) { error = maskUuids(err instanceof Error ? err.message : String(err)); phase = 'error' }
    }
  }
  function dismiss() { if (phase === 'running') stopping = true; else onclose() }
</script>

<div class="batch-backdrop">
  <div class="batch-dialog" role="dialog" aria-modal="true" aria-labelledby="batch-title" tabindex="-1" use:modalFocus
    onkeydown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss() } }}>
    <header>
      <div><h2 id="batch-title">批量生成离线文档</h2><p>读取当前连接的数据库列表；新库生成文档，已有文档更新缓存。</p></div>
      <button class="icon-btn" aria-label="关闭批量生成" disabled={phase === 'running'} onclick={onclose}><Icon name="close" size={17} /></button>
    </header>
    <div class="batch-content">
      {#if phase === 'discovering'}<div class="batch-empty" role="status"><span class="spinner"></span>{discoveryStatus}</div>{/if}
      {#if error}<p class="batch-error" role="alert">{error}</p>{/if}
      {#if phase === 'ready' && !items.length}<div class="batch-empty"><Icon name="database" size={25} /><strong>暂无可生成的数据库</strong><span>请先在 DBX 中打开目标数据库，再点击「重新检查」。</span></div>{/if}
      {#if discoveryIssues.length}<details class="discovery-issues"><summary>{discoveryIssues.length} 个连接的数据库目录未完整读取</summary><ul>{#each discoveryIssues as issue}<li><strong>{issue.name}</strong>：{issue.message}</li>{/each}</ul></details>{/if}
      {#if items.length}
        <div class="batch-summary" role="status" aria-live="polite">
          {#if phase === 'ready'}<span>{items.length} 个数据库待生成</span>
          {:else}<span>{phase === 'running' ? stopping ? '完成当前库后停止' : '正在生成' : '生成已结束'} · {finished} / {items.length}</span><small>成功 {success} · 失败 {failed} · 跳过 {skipped}{cancelled ? ` · 未生成 ${cancelled}` : ''}</small>{/if}
        </div>
        <div class="batch-items" aria-label="批量生成结果">
          {#each items as item (item.key)}
            <div class="batch-item" class:failed={item.state === 'failed'}>
              <div class="batch-identity"><strong>{item.target.database}</strong><small>{item.target.name}</small></div>
              <span class="batch-state" class:success={item.state === 'success'}>{#if item.state === 'running'}<span class="spinner"></span>{/if}{labels[item.state]}</span>
              <p>{item.message}</p>
              {#if item.state === 'running' && item.total > 0}<progress max={item.total} value={item.done} aria-label={`${item.target.database} 同步进度`}></progress>{/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
    <footer>
      <small>{phase === 'running' ? '每个库完整成功后才替换缓存，失败保留旧文档。' : '成功后更新同步时间；失败或跳过时保留旧缓存。'}</small>
      <div class="batch-actions">
        {#if phase === 'running'}<button class="btn" disabled={stopping} title="当前数据库完成后停止，其余数据库不再生成" onclick={() => stopping = true}>{stopping ? '正在停止…' : '停止后续生成'}</button>
        {:else if phase === 'discovering'}<button class="btn" onclick={onclose}>取消检查</button>
        {:else}<button class="btn" onclick={onclose}>{phase === 'done' ? '完成' : '取消'}</button>{#if phase === 'ready' && items.length}<button class="btn btn-primary" onclick={() => void start()}>开始生成（{items.length}）</button>{:else}<button class="btn" onclick={() => void discover()}>重新检查</button>{/if}{/if}
      </div>
    </footer>
  </div>
</div>

<style>
  .batch-backdrop { position: fixed; inset: 0; z-index: 110; display: grid; place-items: center; padding: 20px; background: #0006; }
  .batch-dialog { display: flex; flex-direction: column; width: min(640px, 100%); max-height: calc(100dvh - 40px); min-height: 0; border: 1px solid var(--border); border-radius: 10px; background: var(--panel); color: var(--text); box-shadow: 0 14px 50px #0003; }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 20px; border-bottom: 1px solid var(--border); }
  h2 { margin: 0; font-size: 17px; }header p { margin: 8px 0 0; color: var(--muted); font-size: 12px; line-height: 1.7; }
  .batch-content { min-height: 0; overflow: auto; padding: 0 20px; }
  .batch-summary { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; padding: 15px 0; font-size: 12px; }
  .batch-summary small, footer small { font-size: 11px; color: var(--muted); }
  .batch-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; padding: 13px 0; border-top: 1px solid var(--border); }
  .batch-identity { display: flex; flex-direction: column; gap: 5px; min-width: 0; overflow-wrap: anywhere; }.batch-identity strong { font: 500 12px var(--mono); }.batch-identity small { color: var(--muted); font-size: 11px; }
  .batch-state { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; align-self: start; }.batch-state.success { color: var(--accent); }
  .batch-item p { grid-column: 1 / -1; color: var(--muted); margin: 0; font-size: 11px; line-height: 1.7; overflow-wrap: anywhere; }.batch-item.failed p, .batch-item.failed .batch-state, .batch-error { color: var(--danger); }
  progress { grid-column: 1 / -1; width: 100%; height: 4px; accent-color: var(--accent); }
  .batch-empty { min-height: 150px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 13px; color: var(--muted); font-size: 12px; text-align: center; line-height: 1.8; }.batch-empty strong { color: var(--text); }
  .discovery-issues { margin: 14px 0; color: var(--muted); font-size: 11px; line-height: 1.8; overflow-wrap: anywhere; }.discovery-issues summary { cursor: pointer; }.discovery-issues ul { padding-left: 18px; }
  .batch-error { margin: 20px 0; font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }
  footer { flex: none; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; padding: 16px 20px; border-top: 1px solid var(--border); }footer small { line-height: 1.7; }
  .batch-actions { display: flex; gap: 8px; margin-left: auto; }.btn { font-size: 12px; }
  @media(max-width:600px) { .batch-backdrop { padding: 10px; }.batch-dialog { max-height: calc(100dvh - 20px); }header { padding: 16px; }.batch-content { padding: 0 16px; }footer { padding: 14px 16px; } }
</style>
