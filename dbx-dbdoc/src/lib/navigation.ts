export type TableTab = 'columns' | 'indexes' | 'constraints'
export interface TableVisit { schema: string | null; table: string; tab: TableTab }
export interface TableHistory { visits: TableVisit[]; index: number }

const LIMIT = 50
export const emptyTableHistory = (): TableHistory => ({ visits: [], index: -1 })

// 历史只属于当前连接与库，Schema 是表身份的一部分。
export function visitTable(history: TableHistory, visit: TableVisit): TableHistory {
  const current = history.visits[history.index]
  if (current?.schema === visit.schema && current.table === visit.table) return history
  const visits = [...history.visits.slice(0, history.index + 1), { ...visit }].slice(-LIMIT)
  return { visits, index: visits.length - 1 }
}

export function moveTableHistory(history: TableHistory, direction: -1 | 1): TableHistory {
  const index = history.index + direction
  return index >= 0 && index < history.visits.length ? { ...history, index } : history
}

export function setHistoryTab(history: TableHistory, tab: TableTab): TableHistory {
  if (!history.visits[history.index] || history.visits[history.index].tab === tab) return history
  return { ...history, visits: history.visits.map((visit, index) => index === history.index ? { ...visit, tab } : visit) }
}
