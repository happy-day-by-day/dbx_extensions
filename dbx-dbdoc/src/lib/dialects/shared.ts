// 各方言适配器共用的小工具（Task 4-8 使用）。
// 注：用全局正则 replace 而非 replaceAll——tsconfig lib 为 ES2020（无 replaceAll 类型），行为等价。
export const sqlLiteral = (value: string): string => `'${String(value ?? '').replace(/'/g, "''")}'`
export const likePattern = (keyword: string): string => {
  const escaped = String(keyword ?? '').replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
  return sqlLiteral(`%${escaped}%`)
}
export const rowsToObjects = (result: { columns: { name: string }[]; rows: unknown[][] }): Record<string, unknown>[] =>
  result.rows.map((row) => {
    const obj: Record<string, unknown> = {}
    result.columns.forEach((col, i) => { obj[col.name] = row[i] })
    return obj
  })
export const str = (v: unknown, fallback = ''): string => (v == null ? fallback : String(v))
export const nullableStr = (v: unknown): string | null => (v == null ? null : String(v))
export const num = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isFinite(n) && v != null && v !== '' ? n : null
}
