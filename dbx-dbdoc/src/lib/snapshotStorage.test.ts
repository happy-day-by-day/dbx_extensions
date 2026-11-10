import { describe, it, expect, vi } from 'vitest'
import { createSnapshotStorage, snapshotFileName } from './snapshotStorage'
import { encodeBytes, decodeBytes, sha256 } from './storageBytes'
import type { DirectoryGrant } from './types'
const key = 'dbdoc.offline.v1.["connection","health","mysql"]'
const encoder = new TextEncoder()
function fixture() {
  const grants: DirectoryGrant[] = [], files = new Map<string, Map<string, string>>(), legacy = new Map<string, unknown>()
  const handles = new Map<string, { grant: string; path: string; bytes: Uint8Array; expected?: string | null }>()
  let seq = 0
  const directory = {
    request: vi.fn(async (): Promise<DirectoryGrant | null> => {
      const g: DirectoryGrant = { id: `grant-${grants.length}`, displayName: 'snapshots', displayPath: `/tmp/snapshots-${grants.length}`, mode: 'readwrite', status: 'ready', persistent: true, preferred: false, createdAt: 1, chunkBytes: 524288, maxFileBytes: 536870912 }
      grants.push(g); files.set(g.id, new Map()); return g
    }),
    listGrants: vi.fn(async () => grants),
    setPreferred: vi.fn(async (id: string) => { for (const grant of grants) grant.preferred = grant.id === id }),
    restore: vi.fn(async (id: string) => { const g = grants.find((g) => g.id === id); if (!g) throw new Error('[NEEDS_AUTHORIZATION] unknown'); return g }),
    revoke: vi.fn(async (id: string) => { grants.find((g) => g.id === id)!.status = 'revoked' }),
    list: vi.fn(async (id: string) => ({ entries: [...files.get(id)!.keys()].map((name) => ({ name, kind: 'file' })), cursor: null })),
    stat: vi.fn(async (id: string, path: string) => ({ etag: files.get(id)!.has(path) ? await sha256(encoder.encode(files.get(id)!.get(path)!)) : null })),
    openRead: vi.fn(async (grant: string, path: string) => {
      const v = files.get(grant)!.get(path); if (v === undefined) throw new Error('[NOT_FOUND] missing')
      const bytes = encoder.encode(v), id = String(++seq); handles.set(id, { grant, path, bytes })
      return { handleId: id, size: bytes.length, etag: await sha256(bytes), chunkBytes: 524288 }
    }),
    read: vi.fn(async (id: string, offset: number, length: number) => {
      const bytes = handles.get(id)!.bytes, part = bytes.slice(offset, offset + length)
      return { dataBase64: encodeBytes(part), length: part.length, eof: offset + part.length === bytes.length }
    }),
    close: vi.fn(async (id: string) => { handles.delete(id) }),
    beginWrite: vi.fn(async (grant: string, path: string, options: { expectedEtag: string | null }) => {
      if ((await directory.stat(grant, path)).etag !== options.expectedEtag) throw new Error('[CONFLICT] changed')
      const id = String(++seq); handles.set(id, { grant, path, bytes: new Uint8Array(), expected: options.expectedEtag }); return { handleId: id, chunkBytes: 524288 }
    }),
    write: vi.fn(async (id: string, offset: number, data: string) => {
      const h = handles.get(id)!, bytes = decodeBytes(data); expect(offset).toBe(h.bytes.length)
      const next = new Uint8Array(offset + bytes.length); next.set(h.bytes); next.set(bytes, offset); h.bytes = next
    }),
    commit: vi.fn(async (id: string, digest: string) => {
      const h = handles.get(id)!
      if (grants.find((g) => g.id === h.grant)!.status !== 'ready') throw new Error('[REVOKED] revoked')
      if (await sha256(h.bytes) !== digest) throw new Error('[CHECKSUM_MISMATCH] bad')
      if ((await directory.stat(h.grant, h.path)).etag !== h.expected) throw new Error('[CONFLICT] changed')
      files.get(h.grant)!.set(h.path, new TextDecoder().decode(h.bytes)); handles.delete(id); return { committed: true, etag: digest }
    }),
    abort: vi.fn(async (id: string) => { handles.delete(id) })
  }
  const host = { directory, capabilities: { directoryAccess: true }, storage: {
    get: vi.fn(async (key: string) => legacy.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => { legacy.set(key, value) }),
    delete: vi.fn(async (key: string) => { legacy.delete(key) })
  } }
  return { host, grants, files, legacy, handles, directory }
}
describe('authorized snapshot directories', () => {
  it('asks only on configuration and never writes snapshots into UI storage', async () => {
    const f = fixture(), s = createSnapshotStorage(f.host)
    await expect(s.set(key, 'doc')).rejects.toThrow('配置快照目录'); expect(f.directory.request).not.toHaveBeenCalled()
    await s.configure('/hint'); expect(f.directory.request).toHaveBeenCalledWith({ mode: 'readwrite', persistence: 'required', initialPath: '/hint' })
    await s.set(key, 'doc'); expect(f.host.storage.set.mock.calls.every(([k]) => k === 'dbdoc.snapshotDirectory.v1')).toBe(true)
  })
  it('streams large UTF-8 snapshots and restores on restart without another picker', async () => {
    const f = fixture(), s = createSnapshotStorage(f.host); await s.configure()
    const doc = '字段注释😀'.repeat(200000); await s.set(key, doc)
    expect(await createSnapshotStorage(f.host).get(key)).toBe(doc); expect(f.directory.request).toHaveBeenCalledTimes(1)
    for (const [, , data] of f.directory.write.mock.calls) expect(decodeBytes(data).length).toBeLessThanOrEqual(524288)
    expect(f.handles.size).toBe(0)
  })
  it('rebuilds the entrance list when both UI preferences and recent index are missing', async () => {
    const f = fixture(), s = createSnapshotStorage(f.host); await s.configure(); await s.set(key, 'complete'); f.legacy.clear()
    const restarted = createSnapshotStorage(f.host)
    expect(JSON.parse((await restarted.get('dbdoc.recent'))!)).toMatchObject([{ connectionId: 'connection', database: 'health', dbType: 'mysql' }])
    expect(await restarted.get(key)).toBe('complete'); expect(f.directory.request).toHaveBeenCalledTimes(1)
  })
  it.each(['write', 'commit'] as const)('retains the previous full snapshot when %s fails', async (method) => {
    const f = fixture(), s = createSnapshotStorage(f.host); await s.configure(); await s.set(key, 'old full document and time')
    f.directory[method].mockRejectedValueOnce(new Error('[DISK_FULL] full'))
    await expect(s.set(key, 'partial')).rejects.toThrow('DISK_FULL'); expect(await s.get(key)).toBe('old full document and time'); expect(f.handles.size).toBe(0)
  })
  it('aborts when another workbench changes the destination during commit', async () => {
    const f = fixture(), s = createSnapshotStorage(f.host); await s.configure(); await s.set(key, 'old')
    const original = f.directory.commit.getMockImplementation()!
    f.directory.commit.mockImplementationOnce(async (...args) => { f.files.get('grant-0')!.set(await snapshotFileName(key), 'other complete file'); return original(...args) })
    await expect(s.set(key, 'staged')).rejects.toThrow('CONFLICT'); expect(f.files.get('grant-0')!.get(await snapshotFileName(key))).toBe('other complete file')
  })
  it('verifies read hashes and closes handles when chunks are corrupted', async () => {
    const f = fixture(), s = createSnapshotStorage(f.host); await s.configure(); await s.set(key, 'snapshot')
    const original = f.directory.read.getMockImplementation()!
    f.directory.read.mockImplementationOnce(async (...args) => { const part = await original(...args); return { ...part, dataBase64: encodeBytes(encoder.encode('x'.repeat(part.length))) } })
    await expect(s.get(key)).rejects.toThrow('校验失败'); expect(f.handles.size).toBe(0)
  })
  it('retains legacy UI cache on migration failure and reads old native cache files', async () => {
    const f = fixture(), s = createSnapshotStorage(f.host); f.legacy.set(key, 'legacy UI'); await s.configure()
    f.directory.commit.mockRejectedValueOnce(new Error('disk full')); expect(await s.get(key)).toBe('legacy UI'); expect(f.legacy.get(key)).toBe('legacy UI')
    f.files.get('grant-0')!.set(`${await sha256(encoder.encode(key))}.cache`, 'legacy native')
    expect(await s.get(key)).toBe('legacy native'); expect(f.legacy.get(key)).toBe('legacy UI')
  })
  it('copies complete files before switching directory and keeps original files', async () => {
    const f = fixture(), s = createSnapshotStorage(f.host); await s.configure(); await s.set(key, 'complete'); await s.configure('/new')
    expect(f.files.get('grant-1')!.get(await snapshotFileName(key))).toBe(f.files.get('grant-0')!.get(await snapshotFileName(key)))
    expect((await createSnapshotStorage(f.host).status()).grant?.id).toBe('grant-1')
  })
  it('also copies legacy native caches that have not been opened or migrated yet', async () => {
    const f = fixture(), s = createSnapshotStorage(f.host); await s.configure()
    const legacyName = `${await sha256(encoder.encode(key))}.cache`
    f.files.get('grant-0')!.set(legacyName, 'unopened legacy document')
    await s.configure('/new')
    expect(f.files.get('grant-1')!.get(legacyName)).toBe('unopened legacy document')
    expect(await s.get(key)).toBe('unopened legacy document')
    expect(f.files.get('grant-0')!.get(legacyName)).toBe('unopened legacy document')
  })
  it('keeps the old selection on copy failure or picker cancellation', async () => {
    const f = fixture(), s = createSnapshotStorage(f.host); await s.configure(); await s.set(key, 'complete')
    f.directory.commit.mockRejectedValueOnce(new Error('[DISK_FULL] full')); await expect(s.configure()).rejects.toThrow('DISK_FULL')
    expect((await createSnapshotStorage(f.host).status()).grant?.id).toBe('grant-0'); expect(f.grants[1].status).toBe('revoked')
    f.directory.request.mockResolvedValueOnce(null); expect(await s.configure()).toBe(false); expect((await s.status()).grant?.id).toBe('grant-0')
  })
  it.each(['revoked', 'unavailable', 'identityChanged'] as const)('does not silently use another directory on %s', async (status) => {
    const f = fixture(), s = createSnapshotStorage(f.host); await s.configure(); await s.configure(); f.grants[1].status = status
    const restarted = createSnapshotStorage(f.host); expect((await restarted.status()).status).toBe(status)
    await expect(restarted.set(key, 'doc')).rejects.toThrow('原快照已保留'); expect(f.directory.request).toHaveBeenCalledTimes(2)
  })
  it('recovers from the host registry when the UI preference cannot fit in its quota', async () => {
    const f = fixture(); f.host.storage.set.mockRejectedValue(new Error('plugin UI storage exceeds 1048576 bytes'))
    const s = createSnapshotStorage(f.host); await s.configure(); await s.set(key, 'snapshot')
    expect(await createSnapshotStorage(f.host).get(key)).toBe('snapshot')
  })
  it('keeps revocation authoritative even after losing the UI preference', async () => {
    const f = fixture(), s = createSnapshotStorage(f.host)
    await s.configure(); await s.configure(); await s.revoke(); f.legacy.clear()
    const restarted = createSnapshotStorage(f.host)
    expect((await restarted.status()).status).toBe('revoked')
    await expect(restarted.set(key, 'new')).rejects.toThrow('原快照已保留')
  })
  it('retains the host-selected directory if a directory switch is interrupted and UI preferences disappear', async () => {
    const f = fixture(), s = createSnapshotStorage(f.host)
    await s.configure(); await s.set(key, 'old complete cache')
    // A native picker created a grant, but the plugin crashed before activating it.
    await f.directory.request(); f.legacy.clear()
    const restarted = createSnapshotStorage(f.host)
    expect((await restarted.status()).grant?.id).toBe('grant-0')
    expect(await restarted.get(key)).toBe('old complete cache')
  })
  it('retains the previous directory if persisting the host preference fails', async () => {
    const f = fixture(), s = createSnapshotStorage(f.host)
    await s.configure(); await s.set(key, 'complete')
    f.directory.setPreferred.mockRejectedValueOnce(new Error('[IO_ERROR] grant disk full'))
    await expect(s.configure()).rejects.toThrow('IO_ERROR'); f.legacy.clear()
    expect((await createSnapshotStorage(f.host).status()).grant?.id).toBe('grant-0')
  })
  it('reads legacy data without the backend and reports how to restore snapshot support', async () => {
    const f = fixture(); f.host.capabilities.directoryAccess = false; f.legacy.set(key, 'legacy')
    const s = createSnapshotStorage(f.host); expect(await s.get(key)).toBe('legacy')
    await expect(s.set(key, 'new')).rejects.toThrow('本地快照后端'); expect(f.directory.request).not.toHaveBeenCalled()
  })
  it('clears the previous storage error after explicitly rechecking a recovered directory', async () => {
    const f = fixture(), s = createSnapshotStorage(f.host); await s.configure()
    let currentError = ''; s.subscribe((next) => { currentError = next.error })
    f.directory.stat.mockRejectedValueOnce(new Error('[UNAVAILABLE] disk offline'))
    await expect(s.set(key, 'new')).rejects.toThrow('disk offline'); expect(currentError).toContain('disk offline')
    expect((await s.status()).status).toBe('ready'); expect(currentError).toBe('')
  })
})
