// 共享状态容器（Task 11）：文件名必须带 .svelte 后缀，
// $state rune 只在 .svelte.ts / .svelte.js 中由 Svelte 编译器处理。
import type { DbTable } from '../lib/dialects/entities'
import type { PluginContext } from '../lib/types'
import type { TableDetail } from '../lib/markdown'
import { emptyTableHistory, moveTableHistory, setHistoryTab, visitTable, type TableTab } from '../lib/navigation'

export type Phase =
  | 'booting'
  | 'guide'
  | 'unsupported'
  | 'loading-catalog'
  | 'ready'
  | 'denied'
  | 'error'

export function createAppState() {
  let phase = $state<Phase>('booting')
  let ctx = $state<PluginContext>({})
  let dbType = $state('')
  let degraded = $state(false)
  let offline = $state(false)
  let offlineSavedAt = $state(0)
  let offlineDetailAt = $state(0)
  let storageError = $state('')
  let catalog = $state<DbTable[]>([])
  let catalogSort = $state<'name' | 'columns'>('name')
  let multiTableMode = $state(false)
  let checkedTables = $state<Set<string>>(new Set())
  let truncated = $state(false)
  let schemas = $state<string[]>([])
  // schemaFilter：用户在目录中选择的 Schema 范围（null = 全部）。
  // selectedSchema 仅作详情歧义消解（跨 schema 同名表），不再驱动目录收窄。
  let schemaFilter = $state<string | null>(null)
  let selectedSchema = $state<string | null>(null)
  let selectedTable = $state<string | null>(null)
  // 上下文指定的目标表（表右键进入）：目录回退选表不得覆盖它（目标可能是视图/大小写差异，
  // 不在目录行里），详情按名字直查。用户点目录其他表后该保护自然失效。
  let ctxTargetTable = $state<string | null>(null)
  let detail = $state<TableDetail | null>(null)
  let detailLoading = $state(false)
  let errorMessage = $state('')
  // 联调诊断：宿主投递过但未被识别的上下文载荷（bridge 推送更新）
  let diagMessage = $state('')
  let columnHits = $state<Set<string>>(new Set())
  let catalogSearch = $state({ keyword: '', regexMode: false })
  let catalogRefreshing = $state(false)
  let catalogError = $state('')
  let revision = $state(0)
  let history = $state(emptyTableHistory())

  function navigateTable(schema: string | null, table: string, tab: TableTab = history.visits[history.index]?.tab ?? 'columns') {
    history = setHistoryTab(visitTable(history, { schema, table, tab }), tab)
    ctxTargetTable = null
    selectedSchema = schema
    selectedTable = table
  }
  function toggleCheckedTable(table: DbTable) {
    const key = JSON.stringify([table.table_schema, table.table_name])
    const next = new Set(checkedTables)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    checkedTables = next
  }
  function setMultiTableMode(enabled: boolean) {
    multiTableMode = enabled
    if (enabled && !checkedTables.size && selectedTable && catalog.some(table => table.table_name === selectedTable && table.table_schema === selectedSchema)) {
      checkedTables = new Set([JSON.stringify([selectedSchema, selectedTable])])
    }
  }
  function moveHistory(direction: -1 | 1) {
    const next = moveTableHistory(history, direction)
    if (next === history) return
    history = next
    ctxTargetTable = null
    selectedSchema = next.visits[next.index].schema
    selectedTable = next.visits[next.index].table
  }
  return {
    get phase() { return phase }, set phase(v: Phase) { phase = v },
    get ctx() { return ctx }, set ctx(v: PluginContext) { ctx = v },
    get dbType() { return dbType }, set dbType(v: string) { dbType = v },
    get offline() { return offline }, set offline(v: boolean) { offline = v },
    get offlineSavedAt() { return offlineSavedAt }, set offlineSavedAt(v: number) { offlineSavedAt = v },
    get offlineDetailAt() { return offlineDetailAt }, set offlineDetailAt(v: number) { offlineDetailAt = v },
    get storageError() { return storageError }, set storageError(v: string) { storageError = v },
    get degraded() { return degraded }, set degraded(v: boolean) { degraded = v },
    get catalog() { return catalog }, set catalog(v: DbTable[]) {
      catalog = v
      if (checkedTables.size) {
        const available = new Set(v.map(table => JSON.stringify([table.table_schema, table.table_name])))
        checkedTables = new Set([...checkedTables].filter(key => available.has(key)))
      }
    },
    get catalogSort() { return catalogSort }, set catalogSort(v: 'name' | 'columns') { catalogSort = v },
    get multiTableMode() { return multiTableMode },
    get checkedTables() { return checkedTables }, set checkedTables(v: Set<string>) { checkedTables = v },
    setMultiTableMode,
    toggleCheckedTable,
    get truncated() { return truncated }, set truncated(v: boolean) { truncated = v },
    get schemas() { return schemas }, set schemas(v: string[]) { schemas = v },
    get schemaFilter() { return schemaFilter }, set schemaFilter(v: string | null) { schemaFilter = v },
    get selectedSchema() { return selectedSchema }, set selectedSchema(v: string | null) { selectedSchema = v },
    get selectedTable() { return selectedTable }, set selectedTable(v: string | null) { selectedTable = v },
    get ctxTargetTable() { return ctxTargetTable }, set ctxTargetTable(v: string | null) { ctxTargetTable = v },
    get detail() { return detail }, set detail(v: typeof detail) { detail = v },
    get detailLoading() { return detailLoading }, set detailLoading(v: boolean) { detailLoading = v },
    get errorMessage() { return errorMessage }, set errorMessage(v: string) { errorMessage = v },
    get diagMessage() { return diagMessage }, set diagMessage(v: string) { diagMessage = v },
    get columnHits() { return columnHits }, set columnHits(v: Set<string>) { columnHits = v },
    get catalogSearch() { return catalogSearch }, set catalogSearch(v: typeof catalogSearch) { catalogSearch = v },
    get catalogRefreshing() { return catalogRefreshing }, set catalogRefreshing(v: boolean) { catalogRefreshing = v },
    get catalogError() { return catalogError }, set catalogError(v: string) { catalogError = v },
    get detailTab() { return history.visits[history.index]?.tab ?? 'columns' },
    set detailTab(v: TableTab) { history = setHistoryTab(history, v) },
    get canGoBack() { return history.index > 0 },
    get canGoForward() { return history.index >= 0 && history.index < history.visits.length - 1 },
    navigateTable,
    goBack: () => moveHistory(-1),
    goForward: () => moveHistory(1),
    resetHistory: () => { history = emptyTableHistory(); catalogSearch = { keyword: '', regexMode: false }; multiTableMode = false; checkedTables = new Set() },
    get revision() { return revision }, set revision(v: number) { revision = v }
  }
}
export type AppState = ReturnType<typeof createAppState>
