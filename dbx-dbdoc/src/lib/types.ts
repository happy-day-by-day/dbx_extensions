// Task 2 定义的桥接接口自 Task 3 起迁至本文件，
// bridge.ts 通过 `export type { ... }` 转发，调用方 import 路径不变。
export interface QueryResult {
  dbType: string
  columns: { name: string; dataType: string }[]
  rows: unknown[][]
  truncated: boolean
  elapsedMs?: number
}
export interface PluginContext {
  connectionId?: string
  dbType?: string
  name?: string
  database?: string
  schema?: string
  table?: string
}
export interface DbxBridge {
  capabilities?: { dataApi: boolean; schemaMetadataApi: boolean; storage: boolean; clipboardWrite: boolean }
  ready(): Promise<void>
  getContext(): Promise<PluginContext | null>
  onContextChange(cb: (ctx: PluginContext) => void): () => void
  /** 宿主当前主题（'light' | 'dark'，未知返回 null）：底色跟随宿主而非 OS 媒体查询 */
  getTheme(): Promise<string | null>
  getContributionId?(): string | null
  /** Open this plugin's query workbench; never execute SQL as part of navigation. */
  openTableQuery?(context: PluginContext): Promise<void>
  queryData(req: { connectionId: string; database?: string; schema?: string; sql: string; maxRows?: number }): Promise<QueryResult>
  getTableMetadata(req: { connectionId: string; database?: string; schema?: string; table: string }): Promise<{ columns: { name: string; dataType: string; nullable: boolean; length?: number; precision?: number; scale?: number; default?: string }[] }>
  storageGet(key: string): Promise<string | null>
  storageSet(key: string, value: string): Promise<void>
  saveFile(defaultName: string, content: string): Promise<'saved' | 'cancelled' | 'unsupported' | 'failed'>
  copyText(text: string): Promise<boolean>
}
