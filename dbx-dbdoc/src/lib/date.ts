// 本地时区日期戳：toISOString() 取的是 UTC 日期，东八区 0-8 点会早一天，
// 这里按本地年月日拼装；compact=true 时输出 yyyyMMdd（导出文件名用）。
export function dateStamp(compact = false): string {
  const now = new Date()
  const y = String(now.getFullYear())
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return compact ? `${y}${m}${d}` : `${y}-${m}-${d}`
}
