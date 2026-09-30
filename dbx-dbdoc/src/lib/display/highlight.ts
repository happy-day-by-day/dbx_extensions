// 高亮切分纯函数（新写）：按 regex 命中段把文本切为 { text, hit } 片段序列，
// 切分循环（含零宽匹配守卫与 flags 归一）沿用 data-watcher databaseSearchHighlight.mjs 的实现方式。

export interface HighlightPart {
  text: string
  hit: boolean
}

export const splitHighlight = (text: string, regex: RegExp | null): HighlightPart[] => {
  const value = String(text ?? '')
  if (!value || !(regex instanceof RegExp)) {
    return [{ text: value, hit: false }]
  }

  const flags = `${regex.flags.replace(/[gy]/g, '')}g`
  const matcher = new RegExp(regex.source, flags)
  const parts: HighlightPart[] = []
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = matcher.exec(value)) !== null) {
    const matchedText = match[0]
    if (!matchedText) {
      matcher.lastIndex = match.index + 1
      if (matcher.lastIndex > value.length) {
        break
      }
      continue
    }
    if (match.index > cursor) {
      parts.push({ text: value.slice(cursor, match.index), hit: false })
    }
    parts.push({ text: matchedText, hit: true })
    cursor = match.index + matchedText.length
  }

  if (cursor < value.length) {
    parts.push({ text: value.slice(cursor), hit: false })
  }
  return parts.length ? parts : [{ text: value, hit: false }]
}
