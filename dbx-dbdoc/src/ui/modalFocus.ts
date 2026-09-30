// 模态框约束键盘焦点，卸载时恢复到触发按钮。
export function modalFocus(node: HTMLElement) {
  const previous = document.activeElement as HTMLElement | null
  const focusable = () => [...node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select, textarea, [tabindex="0"]')]
    .filter((element) => element.getClientRects().length > 0)
  node.tabIndex = -1
  queueMicrotask(() => (node.querySelector<HTMLElement>('input:checked') ?? focusable()[0] ?? node).focus())
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return
    const items = focusable()
    const index = items.indexOf(document.activeElement as HTMLElement)
    if (!items.length) { event.preventDefault(); node.focus(); return }
    if (event.shiftKey && index <= 0) { event.preventDefault(); items[items.length - 1].focus() }
    else if (!event.shiftKey && (index < 0 || index === items.length - 1)) { event.preventDefault(); items[0].focus() }
  }
  node.addEventListener('keydown', onKeydown)
  return { destroy() { node.removeEventListener('keydown', onKeydown); queueMicrotask(() => { if (previous?.isConnected) previous.focus() }) } }
}
