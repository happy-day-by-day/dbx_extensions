<script lang="ts">
  import { onMount } from 'svelte'
  import { getBridge } from '../../lib/bridge'
  import type { SnapshotDirectoryStatus } from '../../lib/types'
  import { modalFocus } from '../modalFocus'
  import Icon from './Icon.svelte'
  let { onclose, onchanged }: { onclose: () => void; onchanged: () => void } = $props()
  let location = $state<SnapshotDirectoryStatus>({ status: 'unconfigured', grant: null, error: '' })
  let path = $state(''), busy = $state(false), error = $state('')
  const labels = { ready: '已配置，重启后自动恢复', unconfigured: '尚未配置快照目录', unsupported: '本地快照后端不可用', unchecked: '待校验', unavailable: '目录暂不可用', identityChanged: '原目录已被替换，需要重新配置', revoked: '目录已停用，请重新配置' }
  onMount(() => {
    const bridge = getBridge()
    const off = bridge?.onSnapshotDirectoryChange?.((next) => { location = next })
    void bridge?.getSnapshotDirectoryStatus?.().then((next) => { location = next; path = next.grant?.displayPath ?? '' })
    const onEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close() } }
    document.addEventListener('keydown', onEscape, true)
    return () => { off?.(); document.removeEventListener('keydown', onEscape, true) }
  })
  async function configure() {
    busy = true; error = ''
    try {
      if (await getBridge()?.configureSnapshotDirectory?.(path.trim() || undefined)) {
        path = location.grant?.displayPath ?? ''; onchanged()
      }
    } catch (e) { error = e instanceof Error ? e.message : String(e) }
    finally { busy = false }
  }
  async function retry() {
    busy = true; error = ''
    try { const next = await getBridge()?.getSnapshotDirectoryStatus?.(); if (next) { location = next; if (next.status === 'ready') { onchanged() } } }
    catch (e) { error = String(e) } finally { busy = false }
  }
  async function revoke() {
    busy = true; error = ''
    try { await getBridge()?.revokeSnapshotDirectory?.() }
    catch (e) { error = String(e) } finally { busy = false }
  }
  function close() { if (!busy) { onclose() } }
</script>
<div class="snapshot-backdrop" role="presentation">
  <div class="snapshot-dialog" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="snapshot-title" use:modalFocus>
    <header><h2 id="snapshot-title">文档快照目录</h2><button class="icon-btn" aria-label="关闭快照设置" disabled={busy} onclick={close}><Icon name="close" size={17} /></button></header>
    <div class="snapshot-body">
      <p>文档自动保存到快照目录，重启 DBX 后直接恢复，无需连接数据库。可使用默认目录，也可填写自定义路径。</p>
      <div class="snapshot-status" class:problem={location.status !== 'ready'} role="status">{labels[location.status]}</div>
      {#if location.grant}<dl><dt>当前目录</dt><dd>{location.grant.displayPath}</dd></dl>{/if}
      {#if location.status === 'unsupported'}<p>请重新安装包含本地快照后端的完整插件包。现有缓存和快照文件会保留。</p>{:else}
        <label for="snapshot-path">快照目录路径</label><input id="snapshot-path" type="text" placeholder="输入绝对路径；留空使用默认目录" bind:value={path} disabled={busy} />
        <small>直接填写目录的绝对路径，新目录会自动创建。切换前复制现有快照，保留目标目录已有文件。</small>
      {/if}
      {#if error || location.error}<p class="snapshot-error" role="alert">{error || location.error}</p>{/if}
      <p class="snapshot-note">目录被移动、磁盘不可用或权限失效时，原文件和上次成功同步时间会保留。恢复目录或重新配置后可重试。</p>
    </div>
    <footer>
      {#if location.grant && location.status !== 'revoked'}<button class="text-btn" disabled={busy} onclick={() => void revoke()}>停用此目录</button>{/if}
      <span></span>
      {#if location.status !== 'unconfigured' && location.status !== 'unsupported'}<button class="btn" disabled={busy} onclick={() => void retry()}>重新检查</button>{/if}
      <button class="btn btn-primary" disabled={busy || location.status === 'unsupported'} onclick={() => void configure()}>{busy ? '处理中…' : '保存目录'}</button>
    </footer>
  </div>
</div>
<style>
.snapshot-backdrop { position: fixed; inset: 0; z-index: 120; display: grid; place-items: center; padding: 20px; background: #0006; }
.snapshot-dialog { width: min(560px, 100%); max-height: 90vh; overflow: auto; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 20px 70px #0003; }
header, footer { display: flex; align-items: center; gap: 10px; padding: 14px 18px; } header { border-bottom: 1px solid var(--border); } h2 { flex: 1; margin: 0; font-size: 15px; } footer { border-top: 1px solid var(--border); flex-wrap: wrap; } footer > span { flex: 1; }
.snapshot-body { padding: 4px 18px 16px; font-size: 13px; line-height: 1.7; } .snapshot-status { font-weight: 600; color: var(--accent); }.problem { color: var(--muted); }
label { display: block; margin: 12px 0 5px; font-weight: 600; } input { box-sizing: border-box; width: 100%; padding: 9px; font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 5px; } small, .snapshot-note { color: var(--muted); font-size: 12px; } small { display: block; margin-top: 5px; } dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; font-family: var(--mono); }.snapshot-error { color: var(--danger, #d64a4a); overflow-wrap: anywhere; }
</style>
