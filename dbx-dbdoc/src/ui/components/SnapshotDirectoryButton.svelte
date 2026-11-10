<script lang="ts">
  import { onMount } from 'svelte'
  import { getBridge } from '../../lib/bridge'
  let { onclick, disabled = false }: { onclick: () => void; disabled?: boolean } = $props()
  let problem = $state('')
  onMount(() => getBridge()?.onSnapshotDirectoryChange?.((next) => {
    problem = next.error || (next.status !== 'ready' ? next.status === 'unconfigured' ? '配置快照目录后可保存文档并在重启后自动恢复' : '快照目录不可用，点击检查或重新配置' : '')
  }))
</script>
<button class="btn snapshot-trigger" class:has-problem={Boolean(problem)} title={problem || '配置文档快照目录'} {disabled} {onclick}>快照目录{#if problem}<span aria-label="快照存储需要处理">·</span>{/if}</button>
<style>.snapshot-trigger { white-space: nowrap; }.has-problem > span { color: var(--danger, #c27826); font-weight: 700; }</style>
