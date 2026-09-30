export function groupRows<T extends { seq: number }>(rows: T[], keyOf: (row: T) => string) {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const key = keyOf(row)
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  return [...groups].map(([name, group]) => ({ name, rows: group.sort((a, b) => a.seq - b.seq), first: group[0] }))
}
