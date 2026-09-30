// 最近使用连接的记忆（宿主无连接枚举 API，用 host.storage 记住打开过的连接）。
// 键为 连接+库：同一连接打开不同库视为两个入口；最新在前，容量 8。
import type { DbxBridge, PluginContext } from './types'
import { cleanConnectionName } from './connectionLabels'

export interface RecentConnection {
  connectionId: string
  name: string
  dbType: string
  database: string | null
  ts: number
}

const STORAGE_KEY = 'dbdoc.recent'
const LIMIT = 8
const pendingWrites = new WeakMap<DbxBridge, Promise<RecentConnection[]>>()

export const recentKeyOf = (entry: Pick<RecentConnection, 'connectionId' | 'database'>): string =>
  `${entry.connectionId}::${entry.database ?? ''}`

// 名称属于连接，库入口只影响排序；缺少名称的表上下文不能抹掉已有名称。
export function mergeRecent(list: RecentConnection[], entry: RecentConnection): RecentConnection[] {
  const key = recentKeyOf(entry)
  const prior = [...list].filter((item) => item.connectionId === entry.connectionId).sort((a, b) => b.ts - a.ts)
  const name = cleanConnectionName(entry.name, entry.connectionId)
    || prior.map((item) => cleanConnectionName(item.name, item.connectionId)).find(Boolean) || ''
  const dbType = entry.dbType || prior.find((item) => item.dbType)?.dbType || ''
  const rest = list.filter((item) => recentKeyOf(item) !== key).map((item) =>
    item.connectionId === entry.connectionId ? { ...item, name, dbType } : item)
  return [{ ...entry, name, dbType }, ...rest].slice(0, LIMIT)
}

// 容错解析：损坏/异形数据按空列表处理。
export function parseRecent(raw: string | null): RecentConnection[] {
  if (!raw) return []
  try {
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) return []
    const parsed: RecentConnection[] = data
      .filter(
        (item): item is RecentConnection =>
          item != null &&
          typeof item === 'object' &&
          typeof item.connectionId === 'string' &&
          item.connectionId !== ''
      )
      .map((item) => {
        const name = cleanConnectionName(item.name, item.connectionId)
        const db = typeof item.database === 'string' && item.database !== '' ? item.database : ''
        return {
          connectionId: item.connectionId,
          name,
          dbType: typeof item.dbType === 'string' ? item.dbType : '',
          database: db || null,
          ts: typeof item.ts === 'number' ? item.ts : 0
        }
      })
    const names = new Map<string, string>()
    for (const entry of [...parsed].sort((a, b) => b.ts - a.ts)) {
      if (entry.name && !names.has(entry.connectionId)) names.set(entry.connectionId, entry.name)
    }
    return parsed.map((entry) => ({ ...entry, name: names.get(entry.connectionId) || '' }))
  } catch {
    return []
  }
}

export function contextWithRecent(context: PluginContext, list: RecentConnection[]): PluginContext {
  if (!context.connectionId) return context
  const prior = [...list].filter((entry) => entry.connectionId === context.connectionId).sort((a, b) => b.ts - a.ts)
  return { ...context,
    name: cleanConnectionName(context.name, context.connectionId) || prior.find((entry) => entry.name)?.name || undefined,
    dbType: context.dbType || prior.find((entry) => entry.dbType)?.dbType || undefined }
}

export async function loadRecent(bridge: DbxBridge | null): Promise<RecentConnection[]> {
  const raw = bridge ? await bridge.storageGet(STORAGE_KEY) : null
  return parseRecent(raw)
}

export async function saveRecent(bridge: DbxBridge | null, list: RecentConnection[]): Promise<void> {
  if (!bridge) return
  await bridge.storageSet(STORAGE_KEY, JSON.stringify(list))
}

// 记住一次打开（fire-and-forget 场景下失败由调用方吞掉；列表同时返回供 UI 复用）。
export async function rememberConnection(
  bridge: DbxBridge | null,
  ctx: { connectionId?: string; name?: string; dbType?: string; database?: string }
): Promise<RecentConnection[]> {
  if (!bridge || !ctx.connectionId) return loadRecent(bridge)
  const connectionId = ctx.connectionId
  const snapshot = { ...ctx }
  const previous = pendingWrites.get(bridge)
  const pending = (previous ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const list = mergeRecent(await loadRecent(bridge), {
      connectionId,
      name: cleanConnectionName(snapshot.name, connectionId),
      dbType: snapshot.dbType ?? '',
      database: snapshot.database || null,
      ts: Date.now()
    })
    await saveRecent(bridge, list)
    return list
  })
  pendingWrites.set(bridge, pending)
  try { return await pending }
  finally { if (pendingWrites.get(bridge) === pending) pendingWrites.delete(bridge) }
}
