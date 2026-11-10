/** Uses the existing DBX sidecar API; no host directory extension is needed. */
export function nativeSnapshotDirectory(host: { invoke?: (method: string, params?: unknown) => Promise<any> }) {
  if (typeof host.invoke !== 'function') return undefined
  const call = (operation: string, params: unknown = {}) => host.invoke!(`snapshotDirectory/${operation}`, params)
  return {
    request: (options: { initialPath?: string }) => call('request', options),
    listGrants: () => call('listGrants'),
    setPreferred: (grantId: string) => call('setPreferred', { grantId }),
    restore: (grantId: string) => call('restore', { grantId }),
    revoke: (grantId: string) => call('revoke', { grantId }),
    list: (grantId: string, path = '', cursor?: string) => call('list', { grantId, path, cursor }),
    stat: (grantId: string, path: string) => call('stat', { grantId, path }),
    openRead: (grantId: string, path: string) => call('openRead', { grantId, path }),
    read: (handleId: string, offset: number, length: number) => call('read', { handleId, offset, length }),
    close: (handleId: string) => call('close', { handleId }),
    beginWrite: (grantId: string, path: string, options: { expectedEtag: string | null }) => call('beginWrite', { grantId, path, ...options }),
    write: (handleId: string, offset: number, dataBase64: string) => call('write', { handleId, offset, dataBase64 }),
    commit: (handleId: string, sha256: string) => call('commit', { handleId, sha256 }),
    abort: (handleId: string) => call('abort', { handleId })
  }
}
