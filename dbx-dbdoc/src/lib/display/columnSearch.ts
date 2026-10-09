export interface ColumnMatch { name: string; comment: string }
export const tableSearchKey = (schema: string, table: string) => JSON.stringify([schema, table])

export function groupColumnMatches(rows: Record<string, unknown>[]): Map<string, ColumnMatch[]> {
  const groups = new Map<string, ColumnMatch[]>()
  for (const row of rows) {
    const name = String(row.column_name ?? '')
    if (!name || !row.table_name) continue
    const key = tableSearchKey(String(row.table_schema ?? ''), String(row.table_name))
    const matches = groups.get(key) ?? []
    if (!matches.some((match) => match.name === name)) matches.push({ name, comment: String(row.column_comment ?? '') })
    groups.set(key, matches)
  }
  return groups
}

// 把命中附近的内容放到摘要开头，避免长注释中的关键词被省略号遮住。
export function matchingExcerpt(text: string, keyword: string, radius = 14): string {
  const index = text.toLocaleLowerCase().indexOf(keyword.trim().toLocaleLowerCase())
  if (!keyword.trim() || index < 0) return text
  const start = Math.max(0, index - radius)
  const end = Math.min(text.length, index + keyword.trim().length + radius)
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

export function columnMatchPreview(match: ColumnMatch, keyword: string): string {
  return match.comment.toLocaleLowerCase().includes(keyword.trim().toLocaleLowerCase())
    ? `${matchingExcerpt(match.comment, keyword)} · ${match.name}`
    : `${matchingExcerpt(match.name, keyword)}${match.comment ? ` · ${match.comment}` : ''}`
}
