import { describe, expect, it } from 'vitest'
import { emptyTableHistory, moveTableHistory, setHistoryTab, visitTable } from './navigation'

describe('当前库的表浏览历史', () => {
  it('区分跨 Schema 同名表，返回和前进保留原来的页签', () => {
    let history = visitTable(emptyTableHistory(), { schema: 'public', table: 'orders', tab: 'columns' })
    history = setHistoryTab(history, 'constraints')
    history = visitTable(history, { schema: 'sales', table: 'orders', tab: 'columns' })
    const back = moveTableHistory(history, -1)
    expect(back.visits[back.index]).toEqual({ schema: 'public', table: 'orders', tab: 'constraints' })
    const forward = moveTableHistory(back, 1)
    expect(forward.visits[forward.index]).toEqual({ schema: 'sales', table: 'orders', tab: 'columns' })
  })
  it('重复选择当前表或刷新不会产生重复历史，边界操作不移动', () => {
    const empty = emptyTableHistory()
    expect(moveTableHistory(empty, -1)).toBe(empty)
    const history = visitTable(empty, { schema: null, table: 'orders', tab: 'indexes' })
    expect(visitTable(history, { schema: null, table: 'orders', tab: 'columns' })).toBe(history)
    expect(moveTableHistory(history, -1)).toBe(history)
    expect(moveTableHistory(history, 1)).toBe(history)
  })
  it('返回后打开其他表会移除旧的前进分支，不修改旧快照', () => {
    let history = visitTable(emptyTableHistory(), { schema: 'public', table: 'orders', tab: 'constraints' })
    history = visitTable(history, { schema: 'public', table: 'users', tab: 'columns' })
    const branch = visitTable(moveTableHistory(history, -1), { schema: 'sales', table: 'customers', tab: 'columns' })
    expect(branch.visits.map((visit) => visit.table)).toEqual(['orders', 'customers'])
    expect(history.visits[1].table).toBe('users')
    expect(moveTableHistory(branch, 1)).toBe(branch)
  })
  it('只保留最近 50 个浏览位置，清空后无法跨库返回', () => {
    let history = emptyTableHistory()
    for (let i = 0; i < 80; i++) history = visitTable(history, { schema: 'public', table: `table_${i}`, tab: 'columns' })
    expect(history.visits).toHaveLength(50)
    expect(history.visits[0].table).toBe('table_30')
    expect(history.index).toBe(49)
    expect(moveTableHistory(emptyTableHistory(), -1).visits).toEqual([])
  })
})
