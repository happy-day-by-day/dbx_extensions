import type { PluginContext } from './types'

const placeholders = new Set(['未命名连接', '未命名', '数据库连接', '当前连接'])

// 明确的连接名称是用户文本，不能按大小写、长度和数字组合猜测为随机 ID。
export function cleanConnectionName(value: unknown, connectionId?: string): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name === connectionId || placeholders.has(name)) return ''
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(name)
    || /^[0-9a-f]{16,}$/i.test(name) || /^[0-9A-HJKMNP-TV-Z]{26}$/.test(name)) return ''
  return name
}

export function connectionLabel(context: PluginContext & { databases?: string[] }, ordinal?: number): string {
  // 资源选择与切换的主标题使用真实库名，表名不参与命名。
  const database = [context.database, ...(context.databases ?? [])].find((value) => typeof value === 'string' && value.trim())
  if (database) return database
  const name = cleanConnectionName(context.name, context.connectionId)
  return name && name !== context.table ? name : `数据库连接${ordinal ? ` ${ordinal}` : ''}`
}

export function connectionSubtitle(context: PluginContext & { databases?: string[] }): string {
  const name = cleanConnectionName(context.name, context.connectionId)
  return name && name !== context.table && name !== connectionLabel(context) ? name : ''
}
