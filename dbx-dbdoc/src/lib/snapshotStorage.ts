import { sha256 } from './storageBytes'
import { encodeBytes, decodeBytes } from './storageBytes'
import type { SnapshotDirectoryStatus, DirectoryGrant } from './types'

type DirectoryApi = {
  request(options: { mode: 'readwrite'; persistence: 'required'; initialPath?: string }): Promise<DirectoryGrant | null>
  listGrants(): Promise<DirectoryGrant[]>
  setPreferred(id: string): Promise<void>
  restore(id: string): Promise<DirectoryGrant>
  revoke(id: string): Promise<void>
  list(id: string, path?: string, cursor?: string): Promise<{ entries: { name: string; kind: string }[]; cursor?: string | null }>
  stat(id: string, path: string): Promise<{ etag: string | null }>
  openRead(id: string, path: string): Promise<{ handleId: string; size: number; etag: string; chunkBytes: number }>
  read(id: string, offset: number, length: number): Promise<{ dataBase64: string; length: number; eof: boolean }>
  close(id: string): Promise<void>
  beginWrite(id: string, path: string, options: { expectedEtag: string | null }): Promise<{ handleId: string; chunkBytes: number }>
  write(id: string, offset: number, dataBase64: string): Promise<unknown>
  commit(id: string, sha256: string): Promise<{ committed: boolean; etag: string }>
  abort(id: string): Promise<void>
}
type Host = { capabilities?: { directoryAccess?: boolean }; directory?: DirectoryApi; storage?: { get?(key: string): Promise<unknown>; set?(key: string, value: unknown): Promise<unknown>; delete?(key: string): Promise<unknown> } }
const CONFIG_KEY = 'dbdoc.snapshotDirectory.v1'
const PREFIX = 'dbdoc.offline.v1.'
const MAX_SIZE = 512 * 1024 * 1024
const CHUNK = 512 * 1024
const rawString = (value: unknown) => value == null ? null : typeof value === 'string' ? value : JSON.stringify(value)
export const isSnapshotKey = (key: string) => key === 'dbdoc.recent' || key.startsWith(PREFIX)
export const snapshotFileName = async (key: string) => `dbdoc-${await sha256(new TextEncoder().encode(key))}.json`
interface Envelope { format: 'dbx-dbdoc-snapshot'; version: 1; key: string; value: string; deleted?: true }

export function createSnapshotStorage(host: Host) {
  let state: SnapshotDirectoryStatus = { status: 'unconfigured', grant: null, error: '' }
  let selected: string | null = null
  let restored = false
  const listeners = new Set<(state: SnapshotDirectoryStatus) => void>()
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const task = queue.catch(() => undefined).then(action); queue = task; return task
  }
  function publish(next: SnapshotDirectoryStatus) { state = next; listeners.forEach((cb) => cb({ ...state })) }
  function reportError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const status = message.includes('[REVOKED]') ? 'revoked' : message.includes('[IDENTITY_CHANGED]') ? 'identityChanged'
      : message.includes('[UNAVAILABLE]') || message.includes('[NEEDS_AUTHORIZATION]') ? 'unavailable' : state.status
    publish({ ...state, status, error: message })
  }
  function available(): DirectoryApi {
    if (host.capabilities?.directoryAccess !== true || !host.directory) throw new Error('当前插件未提供本地快照后端，请重新安装完整插件包')
    return host.directory
  }
  async function restore(force = false) {
    if (restored && !force) return state
    if (host.capabilities?.directoryAccess !== true || !host.directory) {
      publish({ status: 'unsupported', grant: null, error: '当前插件未提供本地快照后端，请重新安装完整插件包' }); restored = true; return state
    }
    try {
      if (!selected || force) {
        const grants = await available().listGrants()
        const preferred = grants.find((g) => g.preferred)
        const saved = await host.storage?.get?.(CONFIG_KEY).catch(() => null)
        // The backend preference is committed only after a completed directory
        // switch. An interrupted copy cannot become the default on restart.
        selected = preferred?.id ?? (typeof saved === 'string' && grants.some((g) => g.id === saved) ? saved : null)
      }
      if (!selected) publish({ status: 'unconfigured', grant: null, error: '' })
      else {
        const grant = await available().restore(selected)
        publish({ status: grant.status === 'ready' ? 'ready' : grant.status, grant, error: force && grant.status === 'ready' ? '' : state.error })
      }
    } catch (error) { publish({ status: 'unavailable', grant: state.grant, error: String(error) }) }
    restored = true
    return state
  }
  async function requireGrant() {
    await restore()
    if (state.status !== 'ready' || !state.grant) throw new Error(state.status === 'unconfigured' ? '请先配置快照目录，完整文档才能保存和自动恢复' : state.error || '快照目录暂不可用，请检查目录或重新配置；原快照已保留')
    return state.grant.id
  }
  async function readFile(grantId: string, path: string): Promise<string | null> {
    const api = available()
    let handle: Awaited<ReturnType<DirectoryApi['openRead']>>
    try { handle = await api.openRead(grantId, path) } catch (error) { if (String(error).includes('[NOT_FOUND]')) return null; throw error }
    try {
      if (!Number.isSafeInteger(handle.size) || handle.size < 0 || handle.size > MAX_SIZE) throw new Error('快照大小无效')
      const bytes = new Uint8Array(handle.size)
      let offset = 0
      do {
        const chunk = await api.read(handle.handleId, offset, Math.min(CHUNK, handle.chunkBytes || CHUNK))
        const data = decodeBytes(chunk.dataBase64)
        if (data.length !== chunk.length || offset + data.length > bytes.length || (!data.length && !chunk.eof)) throw new Error('快照分块无效')
        bytes.set(data, offset); offset += data.length
        if (chunk.eof) { if (offset !== bytes.length) throw new Error('快照内容不完整'); break }
      } while (offset < bytes.length)
      if (await sha256(bytes) !== handle.etag) throw new Error('快照校验失败，原文件已保留')
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } finally { await api.close(handle.handleId).catch(() => undefined) }
  }
  async function writeFile(grantId: string, path: string, raw: string, expectedEtag: string | null) {
    const api = available(), bytes = new TextEncoder().encode(raw)
    if (bytes.length > MAX_SIZE) throw new Error('快照超过单文件上限')
    const handle = await api.beginWrite(grantId, path, { expectedEtag })
    try {
      const size = Math.min(CHUNK, handle.chunkBytes || CHUNK)
      for (let offset = 0; offset < bytes.length; offset += size) await api.write(handle.handleId, offset, encodeBytes(bytes.subarray(offset, offset + size)))
      const result = await api.commit(handle.handleId, await sha256(bytes))
      if (!result.committed) throw new Error('本地后端未确认快照提交')
    } catch (error) { await api.abort(handle.handleId).catch(() => undefined); throw error }
  }
  function unpack(raw: string, key?: string): Envelope {
    const envelope = JSON.parse(raw)
    if (envelope?.format !== 'dbx-dbdoc-snapshot' || envelope.version !== 1 || typeof envelope.key !== 'string'
      || !isSnapshotKey(envelope.key) || typeof envelope.value !== 'string' || (key && envelope.key !== key)
      || (envelope.deleted !== undefined && (envelope.deleted !== true || !envelope.key.startsWith(PREFIX) || envelope.value !== ''))) throw new Error('快照格式或身份不匹配，原文件已保留')
    return envelope
  }
  const wrap = (key: string, value: string) => JSON.stringify({ format: 'dbx-dbdoc-snapshot', version: 1, key, value } satisfies Envelope)
  const valueOf = (envelope: Envelope) => envelope.deleted ? null : envelope.value
  async function names(grant: string, includeLegacy = false) {
    const names: string[] = [], seen = new Set<string>(); let cursor: string | undefined
    do {
      const page = await available().list(grant, '', cursor)
      for (const entry of page.entries) if (entry.kind === 'file' && (/^dbdoc-[a-f0-9]{64}\.json$/.test(entry.name) || includeLegacy && /^[a-f0-9]{64}\.cache$/.test(entry.name))) names.push(entry.name)
      cursor = page.cursor || undefined
      if (cursor && seen.has(cursor)) throw new Error('快照目录分页无效')
      if (cursor) seen.add(cursor)
    } while (cursor)
    return names
  }
  async function recoverRecent(grant: string, recentRaw: string | null) {
    let recent: any[] = []
    try { const value = JSON.parse(recentRaw ?? '[]'); if (Array.isArray(value)) recent = value } catch { /* recover from document files */ }
    // Self-contained snapshots rebuild the entrance list after an interrupted
    // index save. A corrupt file never removes another database's entry.
    const known = new Set(recent.map((item) => JSON.stringify([item?.connectionId, item?.database ?? ''])))
    const indexedNames = new Set(await Promise.all(recent.filter((item) => typeof item?.connectionId === 'string' && typeof item?.dbType === 'string').map((item) => snapshotFileName(PREFIX + JSON.stringify([item.connectionId, item.database ?? '', item.dbType])))))
    for (const name of await names(grant)) {
      if (indexedNames.has(name)) continue
      if (name === await snapshotFileName('dbdoc.recent')) continue
      try {
        const raw = await readFile(grant, name); if (!raw) continue
        const env = unpack(raw); if (!env.key.startsWith(PREFIX) || name !== await snapshotFileName(env.key)) continue
        const [connectionId, database, dbType] = JSON.parse(env.key.slice(PREFIX.length))
        const key = JSON.stringify([connectionId, database ?? ''])
        if (typeof connectionId !== 'string' || typeof database !== 'string' || typeof dbType !== 'string' || known.has(key)) continue
        recent.push({ connectionId, database: database || null, dbType, name: '', ts: 0 }); known.add(key)
      } catch { /* invalid individual file is retained and ignored */ }
    }
    return JSON.stringify(recent)
  }
  async function get(key: string): Promise<string | null> {
    await restore()
    const legacy = () => host.storage?.get?.(key).then(rawString) ?? Promise.resolve(null)
    // A configured directory is authoritative, including deletion markers.
    // If it is unavailable, a legacy UI copy may predate a successful clear.
    if (state.status !== 'ready' || !state.grant) return selected && key.startsWith(PREFIX) ? null : legacy()
    const grant = state.grant.id, path = await snapshotFileName(key)
    try {
      let raw = await readFile(grant, path)
      const envelope = raw ? unpack(raw, key) : null
      // A durable deletion marker prevents old UI/native caches from being
      // imported again after restart, even if legacy cleanup was interrupted.
      if (envelope?.deleted) return null
      let value = envelope ? envelope.value : null
      if (value === null) {
        // Compatibility with the previous native cache: selecting its
        // documents-v2 directory recovers .cache files without a Go backend.
        value = await readFile(grant, `${await sha256(new TextEncoder().encode(key))}.cache`) ?? await legacy()
        if (value !== null) {
          try { await writeFile(grant, path, wrap(key, value), null) }
          catch (error) {
            if (String(error).includes('[CONFLICT]')) { raw = await readFile(grant, path); if (raw) value = valueOf(unpack(raw, key)) }
            // Retain the legacy value when a migration cannot be committed.
          }
        }
      }
      return key === 'dbdoc.recent' ? recoverRecent(grant, value) : value
    } catch (error) { reportError(error); throw error }
  }
  return {
    get: (key: string) => serial(() => get(key)),
    set: (key: string, value: string) => serial(async () => {
      const grant = await requireGrant(), path = await snapshotFileName(key)
      try {
        const { etag } = await available().stat(grant, path)
        await writeFile(grant, path, wrap(key, value), etag)
        publish({ ...state, error: '' })
      } catch (error) { reportError(error); throw error }
    }),
    delete: (key: string) => serial(async () => {
      if (!key.startsWith(PREFIX)) throw new Error('只能清除指定数据库的文档缓存')
      const grant = await requireGrant(), path = await snapshotFileName(key)
      try {
        const { etag } = await available().stat(grant, path)
        // Atomic replacement releases the document payload and keeps a tiny
        // marker. Failed writes and concurrent changes retain the prior file.
        await writeFile(grant, path, JSON.stringify({ format: 'dbx-dbdoc-snapshot', version: 1, key, value: '', deleted: true } satisfies Envelope), etag)
        try { await host.storage?.delete?.(key) } catch { /* durable deletion is already committed */ }
        publish({ ...state, error: '' })
      } catch (error) { reportError(error); throw error }
    }),
    status: () => serial(() => restore(true)),
    subscribe(cb: (state: SnapshotDirectoryStatus) => void) { listeners.add(cb); cb({ ...state }); return () => { listeners.delete(cb) } },
    configure: (initialPath?: string) => serial(async () => {
      await restore()
      const previous = state.grant
      const grant = await available().request({ mode: 'readwrite', persistence: 'required', initialPath })
      if (!grant) return false
      if (!grant.persistent || grant.status !== 'ready') throw new Error('本地后端未能持久保存快照目录配置')
      try {
        // Copy complete envelopes before switching. Existing destination files
        // are preserved; selecting another directory never overwrites them.
        if (previous && previous.id !== grant.id && state.status === 'ready') {
          for (const name of await names(previous.id, true)) {
            if ((await available().stat(grant.id, name)).etag !== null) continue
            const raw = await readFile(previous.id, name); if (raw) { if (name.endsWith('.json')) unpack(raw); await writeFile(grant.id, name, raw, null) }
          }
        }
        await available().setPreferred(grant.id)
      } catch (error) { await available().revoke(grant.id).catch(() => undefined); throw error }
      selected = grant.id; restored = true
      // The selected directory is durable in the backend even if UI storage is full.
      // The small UI preference is only a compatibility hint.
      try { await host.storage?.set?.(CONFIG_KEY, selected) }
      catch { try { await host.storage?.delete?.(CONFIG_KEY) } catch { /* native registry is the recovery source */ } }
      publish({ status: 'ready', grant: { ...grant, preferred: true }, error: '' })
      return true
    }),
    revoke: () => serial(async () => {
      await restore(); if (state.grant) await available().revoke(state.grant.id)
      // Keep the selected id to avoid silently switching to an older directory.
      publish({ ...state, status: 'revoked', error: '' })
    })
  }
}
