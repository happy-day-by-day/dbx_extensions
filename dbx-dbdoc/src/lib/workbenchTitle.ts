import type { PluginContext } from './types'
import { cleanConnectionName } from './connectionLabels'

export function databaseDocumentTitle(context: PluginContext): string {
  if (context.database?.trim()) return `${context.database}-数据库文档`
  const name = cleanConnectionName(context.name, context.connectionId)
  return name && name !== context.table ? `${name}-数据库文档` : '数据库文档'
}
