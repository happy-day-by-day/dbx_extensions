<script lang="ts">
  import { onMount } from 'svelte'
  import { getBridge } from '../../lib/bridge'
  import { clearOffline } from '../../lib/offline'
  import { maskUuids } from '../../lib/display/masking'
  import type { PluginContext } from '../../lib/types'
  import { modalFocus } from '../modalFocus'

  let { context, connectionName, onclose, oncleared }: {
    context: PluginContext; connectionName: string; onclose: () => void; oncleared: () => void
  } = $props()
  let busy = $state(false), error = $state('')
  function close() { if (!busy) onclose() }
  onMount(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close() }
    }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  })
  async function clear() {
    if (busy) return
    busy = true; error = ''
    try {
      const bridge = getBridge()
      if (!bridge) throw new Error('本地缓存服务暂不可用')
      await clearOffline(bridge, context)
    } catch (err) {
      error = maskUuids(err instanceof Error ? err.message : String(err))
      busy = false
      return
    }
    oncleared()
    onclose()
  }
</script>

<div class="modal-mask">
  <div class="modal-panel clear-dialog" role="dialog" aria-modal="true" aria-labelledby="clear-cache-title" aria-describedby="clear-cache-description" tabindex="-1" use:modalFocus>
    <h2 id="clear-cache-title">清除本地缓存？</h2>
    <dl><dt>数据库</dt><dd>{context.database}</dd><dt>连接</dt><dd>{connectionName}</dd></dl>
    <p id="clear-cache-description">清除此库的本地文档和最后成功同步时间，保留列表记录。需要时可打开文档，点击「刷新」重新生成缓存。数据库中的数据不受影响。</p>
    {#if error}<p class="clear-error" role="alert">清除失败，原缓存已保留：{error}</p>{/if}
    <footer><button class="btn" disabled={busy} onclick={close}>取消</button><button class="btn clear-confirm" disabled={busy} onclick={() => void clear()}>{busy ? '正在清除…' : '清除缓存'}</button></footer>
  </div>
</div>

<style>
  .clear-dialog { width: 420px; padding: 20px; }
  h2 { margin: 0 0 16px; font-size: 15px; }
  dl { display: grid; grid-template-columns: auto minmax(0,1fr); gap: 6px 12px; font-size: 12px; }
  dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
  p { color: var(--muted); font-size: 12px; line-height: 1.8; }
  .clear-error { color: var(--danger); overflow-wrap: anywhere; }
  footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
  .clear-confirm { color: var(--danger); border-color: var(--danger); }
</style>
