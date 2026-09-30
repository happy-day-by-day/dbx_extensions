<script lang="ts">
  let { value, onchange, oncommit }: { value: number; onchange: (value: number) => void; oncommit: () => void } = $props()
  let startX = 0
  let startWidth = 0
  let dragging = false
  const clamp = (width: number) => Math.round(Math.max(224, Math.min(520, window.innerWidth * 0.55, width)))
  function pointerdown(event: PointerEvent) {
    if (event.button !== 0) return
    dragging = true
    startX = event.clientX
    startWidth = value
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  function finish() { if (dragging) { dragging = false; oncommit() } }
</script>
<!-- 可聚焦分隔器符合 WAI-ARIA Window Splitter 模式，Svelte 将 separator 视为静态角色。 -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div class="sidebar-resize" role="separator" aria-label="调整目录宽度" aria-orientation="vertical"
  aria-valuemin="224" aria-valuemax="520" aria-valuenow={value} tabindex="0"
  onpointerdown={pointerdown} onpointermove={(event) => { if (dragging) onchange(clamp(startWidth + event.clientX - startX)) }}
  onpointerup={finish} onpointercancel={finish}
  onkeydown={(event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); onchange(clamp(value + (event.key === 'ArrowLeft' ? -16 : 16))); oncommit()
    }
  }}></div>
