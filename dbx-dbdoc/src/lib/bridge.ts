// 接口定义已迁至 ./types（Task 3），此处转发导出，调用方 import 路径不变。
import type { DbxBridge, PluginContext, QueryResult } from './types'
import { cleanConnectionName } from './connectionLabels'

export type { DbxBridge, PluginContext, QueryResult }

type AnyRecord = Record<string, any>

const asQueryResult = (raw: any): QueryResult => ({
  dbType: String(raw?.dbType ?? ''),
  columns: Array.isArray(raw?.columns) ? raw.columns : [],
  rows: Array.isArray(raw?.rows) ? raw.rows : [],
  truncated: Boolean(raw?.truncated),
  elapsedMs: typeof raw?.elapsedMs === 'number' ? raw.elapsedMs : undefined
})

// —— 联调诊断：记录最近一次「收到了但没认出来」的上下文原始载荷（引导页展示，便于真实宿主定位）——
let lastUnrecognized: string | null = null
const diagListeners = new Set<(message: string | null) => void>()
export const getLastUnrecognizedContext = (): string | null => lastUnrecognized
// 订阅未识别载荷变化（Guide 的诊断区是响应式的，事件晚于页面渲染也要能刷出来）
export function onUnrecognizedContext(cb: (message: string | null) => void): () => void {
  diagListeners.add(cb)
  return () => diagListeners.delete(cb)
}
const recordUnrecognized = (source: string, raw: unknown): void => {
  if (raw == null || typeof raw !== 'object' || Object.keys(raw as object).length === 0) return
  let message: string
  try {
    // 诊断仅记录字段名和非敏感连接摘要，不能把任意宿主载荷写入产品界面。
    message = `${source}: ${Object.keys(raw as object).join(', ').slice(0, 200)}`
    const label = pickStr(raw as AnyRecord, NAME_KEYS)
    if (label) message += ` (${label.slice(0, 100)})`
  } catch {
    message = `${source}: ${String(raw).slice(0, 200)}`
  }
  lastUnrecognized = message
  diagListeners.forEach((cb) => cb(message))
}

// 各宿主上下文形态差异大：连接 summary 顶层是 id、表上下文是 connectionId、
// 事件可能包在 context/payload/detail/data 容器或以 JSON 字符串投递——深扫归一。
const CONNECTION_ID_KEYS = ['connectionId', 'connection_id', 'connId', 'conn_id', 'id']
const DB_TYPE_KEYS = ['dbType', 'db_type', 'databaseType', 'engine']
const NAME_KEYS = ['connectionName', 'connection_name', 'name', 'title', 'label']
const DATABASE_KEYS = ['database', 'db', 'databaseName', 'catalog']
const SCHEMA_KEYS = ['schema', 'schemaName']
const TABLE_KEYS = ['table', 'tableName', 'table_name']

const pickStr = (obj: AnyRecord, keys: string[]): string | undefined => {
  for (const key of keys) {
    const v = obj[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return undefined
}

const contextFrom = (obj: AnyRecord): PluginContext => {
  const conn: AnyRecord | null = obj.connection && typeof obj.connection === 'object' ? (obj.connection as AnyRecord) : null
  const connIdStr = typeof obj.connection === 'string' && obj.connection !== '' ? obj.connection : undefined
  // 连接摘要提供连接身份；资源路径以本体上下文为准，不能被摘要里的默认库覆盖。
  const pickBoth = (keys: string[]): string | undefined => (conn ? pickStr(conn, keys) : undefined) ?? pickStr(obj, keys)
  const pickResource = (keys: string[]): string | undefined => pickStr(obj, keys) ?? (conn ? pickStr(conn, keys) : undefined)
  const connectionId = pickBoth(CONNECTION_ID_KEYS) ?? connIdStr
  const table = pickResource(TABLE_KEYS)
  let name: string | undefined
  for (const source of conn ? [conn, obj] : [obj]) {
    for (const key of NAME_KEYS) {
      const candidate = cleanConnectionName(source[key], connectionId)
      // 表对象的通用 name/title/label 不能冒充连接名称；明确的 connectionName 仍可使用。
      if (source === obj && key !== 'connectionName' && key !== 'connection_name' && table && candidate === table.trim()) continue
      name = candidate || undefined
      if (name) break
    }
    if (name) break
  }
  return {
    connectionId,
    dbType: pickBoth(DB_TYPE_KEYS),
    name,
    database: pickResource(DATABASE_KEYS),
    schema: pickResource(SCHEMA_KEYS),
    table
  }
}

const normalizeContext = (raw: any): PluginContext | null => {
  // JSON 字符串形态直接解析
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!raw || typeof raw !== 'object') return null
  // 依次扫描：载荷本体 → 常见容器字段
  const candidates: AnyRecord[] = [raw]
  for (const key of ['context', 'payload', 'detail', 'data']) {
    const v = (raw as AnyRecord)[key]
    if (v && typeof v === 'object') candidates.push(v)
  }
  let fallback: PluginContext | null = null
  for (const candidate of candidates) {
    const ctx = contextFrom(candidate)
    if (ctx.connectionId) return ctx
    if (!fallback && ctx.table) fallback = ctx
  }
  return fallback
}

// 单例缓存：宿主监听器（onContext / message）只在首次创建时挂一次，
// 避免每次 getBridge 都向宿主注册新监听器导致无界累积；无宿主时返回 null 且不缓存 null
// （window 为后注入场景，宿主出现后下次调用应重新创建）。
// 记录建桥时的 window.dbxPlugin 引用：宿主对象引用变化（宿主重注入）则重建桥，不返回旧桥。
let cachedBridge: DbxBridge | null = null
let cachedHost: AnyRecord | null = null
let disposeHostListeners: (() => void) | null = null

export function getBridge(): DbxBridge | null {
  const host: AnyRecord | undefined = (globalThis as any)?.window?.dbxPlugin
  if (!host) return null
  if (cachedBridge && host === cachedHost) return cachedBridge
  disposeHostListeners?.()
  const subscriptions: Array<() => void> = []
  const subscribe = (off: unknown) => { if (typeof off === 'function') subscriptions.push(off as () => void) }
  const callContext = async (): Promise<any> => {
    if (typeof host.context === 'function') return host.context()
    if (host.context != null) return host.context
    if (typeof host.getContext === 'function') return host.getContext()
    if (typeof host.request === 'function') return host.request('host.getContext')
    return null
  }
  const listeners = new Set<(ctx: PluginContext) => void>()
  const dispatchIfContext = (source: string, raw: any): void => {
    const normalized = normalizeContext(raw)
    if (normalized && (normalized.connectionId || normalized.table)) {
      listeners.forEach((cb) => cb(normalized))
    } else {
      // 既无连接也无表（含完全没认出来）：一律进诊断——上一版曾把「认出但为空」的载荷
      // 静默吞掉，真实宿主的 summary 形态恰好落在这类分支里
      recordUnrecognized(source, raw)
    }
  }
  if (typeof host.onContext === 'function') {
    subscribe(host.onContext((ctx: any) => dispatchIfContext('onContext', ctx)))
  } else if (typeof globalThis.addEventListener === 'function') {
    const win: AnyRecord = (globalThis as any)?.window ?? globalThis
    const onMessage = (event: MessageEvent) => {
      // 来源校验：iframe 内 parent 即宿主，另放行自身窗口与无来源（部分宿主经中转投递）
      if (event.source != null && event.source !== win.parent && event.source !== win) return
      const data: any = event.data
      if (!data || typeof data !== 'object') return
      // 类型包含 context 即候选（各宿主命名不一：context / dbx-plugin-context / context-update…）
      if (!/context/i.test(String(data.type ?? ''))) return
      dispatchIfContext('message', data.context ?? data.payload ?? data.detail ?? data)
    }
    globalThis.addEventListener('message', onMessage)
    subscriptions.push(() => globalThis.removeEventListener('message', onMessage))
  }
  // host.events 通道（宿主通用事件）：部分宿主经 onEvent 投递工作台上下文，
  // 载荷形状不定，深扫归一后分发；内容守卫在 App 侧去重。onInit 同理接线。
  const wireEventChannel = (name: 'onEvent' | 'onInit'): void => {
    const hook = (host as AnyRecord)[name]
    if (typeof hook !== 'function') return
    try {
      subscribe(hook((ev: any) => {
        if (name === 'onEvent' && !/context/i.test(String(ev?.type ?? '')) && !ev?.context) return
        dispatchIfContext(name, ev)
      }))
    } catch {
      // 宿主不接受订阅：忽略
    }
  }
  wireEventChannel('onEvent')
  wireEventChannel('onInit')
  const capabilities = {
    get dataApi() { return host.capabilities?.dataApi === true },
    get schemaMetadataApi() { return host.capabilities?.schemaMetadataApi === true },
    get storage() { return host.capabilities?.storage === true },
    get clipboardWrite() { return host.capabilities?.clipboardWrite === true }
  }
  const bridge: DbxBridge = {
    capabilities,
    ready: async () => {
      if (typeof host.ready === 'function') await host.ready()
      else await host.ready
    },
    getContext: async () => {
      const raw = await callContext()
      const normalized = normalizeContext(raw)
      if (!normalized || (!normalized.connectionId && !normalized.table)) recordUnrecognized('getContext', raw)
      return normalized
    },
    onContextChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getTheme: async () => {
      // 宿主 theme 可能是字符串字段或函数；异常/缺失按未知处理（调用方回退 OS 媒体查询）
      try {
        const t = (host as AnyRecord).theme
        if (typeof t === 'function') {
          const v = await t()
          return typeof v === 'string' ? v : v?.appearance ?? null
        }
        return typeof t === 'string' ? t : t?.appearance ?? null
      } catch {
        return null
      }
    },
    queryData: async (req) => {
      if (!capabilities.dataApi || typeof host.queryData !== 'function') throw new Error('当前 DBX 版本未提供只读数据查询，请升级 DBX 后重试')
      // 插件侧兜底超时：宿主 queryData 卡死（无响应也无 reject）时 65 秒后以错误收场
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const raw = await Promise.race([
          host.queryData(req),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('查询超时（65 秒），请重试')), 65000)
          })
        ])
        return asQueryResult(raw)
      } finally {
        clearTimeout(timer)
      }
    },
    getTableMetadata: async (req) => {
      if (!capabilities.schemaMetadataApi || typeof host.getTableMetadata !== 'function') throw new Error('当前 DBX 版本未提供表结构读取，请升级 DBX 后重试')
      const raw = await host.getTableMetadata(req)
      return { columns: Array.isArray(raw?.columns) ? raw.columns : [] }
    },
    storageGet: async (key) => {
      const storageApi: AnyRecord | undefined = host.storage
      if (!capabilities.storage || !storageApi || typeof storageApi.get !== 'function') return null
      const value = await storageApi.get(key)
      return value == null ? null : typeof value === 'string' ? value : JSON.stringify(value)
    },
    storageSet: async (key, value) => {
      const storageApi: AnyRecord | undefined = host.storage
      if (!capabilities.storage || !storageApi || typeof storageApi.set !== 'function') return
      await storageApi.set(key, value)
    },
    saveFile: async (defaultName, content) => {
      const ft: AnyRecord | undefined = host.fileTransfer
      let handleId: string | undefined
      try {
        if (!ft || typeof ft.beginSave !== 'function' || typeof ft.write !== 'function' || typeof ft.finish !== 'function') {
          return 'unsupported'
        }
        const bytes = new TextEncoder().encode(content)
        const handle = await ft.beginSave({ name: defaultName, contentType: 'text/markdown;charset=utf-8', size: bytes.length })
        if (!handle) return 'cancelled'
        handleId = handle.handleId
        if (!handleId) throw new Error('保存文件句柄无效')
        const chunkBytes = Math.max(1, Math.min(Number(handle.chunkBytes) || SAVE_FILE_CHUNK_SIZE, SAVE_FILE_CHUNK_SIZE))
        for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
          await ft.write(handleId, offset, bytes.slice(offset, offset + chunkBytes))
        }
        await ft.finish(handleId)
        return 'saved'
      } catch {
        if (handleId && typeof ft?.cancel === 'function') await ft.cancel(handleId).catch(() => undefined)
        return 'failed'
      }
    },
    copyText: async (text) => {
      try {
        if (!capabilities.clipboardWrite) return false
        if (typeof host.copy === 'function') await host.copy(text)
        else if (typeof host.clipboard?.writeText === 'function') await host.clipboard.writeText(text)
        else return false
        return true
      } catch {
        return false
      }
    }
  }
  cachedBridge = bridge
  cachedHost = host
  disposeHostListeners = () => subscriptions.forEach((off) => off())
  return bridge
}

// saveFile 分块大小（512KiB）：与宿主 fileTransfer 分块写盘约定一致
const SAVE_FILE_CHUNK_SIZE = 512 * 1024

// 分块写盘的切块逻辑（导出以便单测）：块尾若落在高代理项（0xD800-0xDBFF）上，
// 该块长度减 1，把代理对（如 emoji）完整留给下一块，避免 UTF-16 代理对被从中间切开。
export function chunkText(content: string, chunkSize: number): string[] {
  const chunks: string[] = []
  let offset = 0
  while (offset < content.length) {
    let size = Math.min(chunkSize, content.length - offset)
    const tail = content.charCodeAt(offset + size - 1)
    if (size > 1 && tail >= 0xd800 && tail <= 0xdbff) size -= 1
    chunks.push(content.slice(offset, offset + size))
    offset += size
  }
  return chunks
}

export function isDataAccessDenied(err: unknown): boolean {
  // 归一化错误消息：Error 取 message、string 取自身、普通对象取 message ?? code，其他无消息
  let message: string | undefined
  if (err instanceof Error) message = err.message
  else if (typeof err === 'string') message = err
  else if (err && typeof err === 'object') {
    const rec = err as { message?: unknown; code?: unknown }
    message = rec.message != null ? String(rec.message) : rec.code != null ? String(rec.code) : undefined
  }
  // 判定放宽为包含匹配：宿主可能把拒绝码包在前缀/后缀说明里
  return typeof message === 'string' && message.includes('PLUGIN_DATA_ACCESS_NOT_GRANTED')
}

export function isConnectionNotOpen(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err
    : err && typeof err === 'object' ? String((err as { message?: unknown }).message ?? '') : ''
  return /\b(?:connection|database session)\s+is\s+not\s+open\b/i.test(message)
}
