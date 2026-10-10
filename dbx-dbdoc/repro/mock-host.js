// 复现用 mock 宿主：由 preview server 在页面脚本加载前注入，
// 模拟 PostgreSQL 连接，按 SQL 形状应答 queryData。
// window.__emitContext({ table, schema, database }) 可模拟「表右键」上下文事件。
;(function () {
  const params = new URLSearchParams(location.search)
  const DELAY = Number(params.get('delay')) || 60
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // 两个 schema + 跨 schema 同名表 orders（真实 PG 常见，重点回归场景）
  const TABLES = [
    ['public', 'users', '用户表', 3],
    ['public', 'orders', '订单表', 5],
    ['sales', 'orders', '销售订单', 4],
    ['sales', 'customers', '客户', 2]
  ]

  // [schema, table, column, type, dataType, nullable, identity, default, comment]
  const COLUMNS = [
    ['public', 'users', 'id', 'bigint', 'bigint', 'NO', true, null, '主键'],
    ['public', 'users', 'name', 'character varying(64)', 'character varying', 'YES', false, null, '姓名'],
    ['public', 'users', 'created_at', 'timestamp with time zone', 'timestamp with time zone', 'NO', false, 'now()', '创建时间'],
    ['public', 'orders', 'id', 'bigint', 'bigint', 'NO', true, null, '主键'],
    ['public', 'orders', 'user_id', 'bigint', 'bigint', 'NO', false, null, '下单用户'],
    ['public', 'orders', 'amount', 'numeric(12,2)', 'numeric', 'NO', false, null, '金额'],
    ['public', 'orders', 'status', 'text', 'text', 'YES', false, "'new'", '状态'],
    ['public', 'orders', 'created_at', 'timestamp with time zone', 'timestamp with time zone', 'NO', false, 'now()', '创建时间'],
    ['sales', 'orders', 'id', 'bigint', 'bigint', 'NO', true, null, '主键'],
    ['sales', 'orders', 'region', 'text', 'text', 'NO', false, null, '区域'],
    ['sales', 'orders', 'amount', 'numeric(12,2)', 'numeric', 'NO', false, null, '金额'],
    ['sales', 'orders', 'created_at', 'timestamp with time zone', 'timestamp with time zone', 'NO', false, 'now()', ''],
    ['sales', 'customers', 'id', 'bigint', 'bigint', 'NO', true, null, ''],
    ['sales', 'customers', 'company', 'character varying(128)', 'character varying', 'YES', false, null, '']
  ]

  // [schema, table, column, seq, index_name, primary, unique, expression]
  const INDEXES = [
    ['public', 'users', 'id', 1, 'users_pkey', true, true, false],
    ['public', 'orders', 'id', 1, 'orders_pkey', true, true, false],
    ['public', 'orders', 'user_id', 1, 'idx_orders_user', false, false, false],
    ['public', 'orders', 'lower(status)', 1, 'idx_orders_status_lower', false, false, true],
    ['sales', 'orders', 'id', 1, 'orders_pkey', true, true, false],
    ['sales', 'customers', 'id', 1, 'customers_pkey', true, true, false]
  ]

  const FKS = [
    // [schema, table, constraint, column, seq, refSchema, refTable, refColumn]
    ['public', 'orders', 'orders_user_id_fkey', 'user_id', 1, 'public', 'users', 'id']
  ]

  const CHECKS = [['public', 'orders', 'orders_amount_check', 'amount > 0']]
  for (let i = 0, count = Math.min(200, Number(params.get('fields')) || 0); i < count; i++) {
    COLUMNS.push(['public', 'orders', 'attribute_' + String(i).padStart(3, '0'), 'character varying(32)', 'character varying', 'YES', false, null, '业务属性 ' + i])
    TABLES[1][3] += 1
  }

  for (let i = 0, count = Math.min(5000, Number(params.get('tables')) || 0); i < count; i++) {
    const name = 'business_record_' + String(i).padStart(4, '0')
    TABLES.push(['public', name, i % 3 ? '业务记录表 ' + i : '', 3])
    COLUMNS.push(['public', name, 'id', 'bigint', 'bigint', 'NO', true, null, '主键'],
      ['public', name, 'name', 'character varying(64)', 'character varying', 'YES', false, null, '业务名称'],
      ['public', name, 'created_at', 'timestamp with time zone', 'timestamp with time zone', 'NO', false, 'now()', '创建时间'])
    INDEXES.push(['public', name, 'id', 1, name + '_pkey', true, true, false])
  }

  // 紧凑文档页验收：长表名、长注释和完整属性，不改变发行代码。
  const displayTable = params.get('tableName') || 'orders'
  if (displayTable !== 'orders') for (const rows of [TABLES, COLUMNS, INDEXES, FKS, CHECKS]) {
    for (const row of rows) if (row[0] === 'public' && row[1] === 'orders') row[1] = displayTable
  }
  if (params.has('tableComment')) TABLES[1][2] = params.get('tableComment')
  const q = (cols, rows) => ({ dbType: 'postgres', columns: cols.map((name) => ({ name })), rows, truncated: false, elapsedMs: DELAY })

  function answer(sql) {
    const s = sql.replace(/\s+/g, ' ').toLowerCase()
    const selectTable = sql.trim().match(/^SELECT \* FROM "((?:[^"]|"")*)"\."((?:[^"]|"")*)"(?:\s+WHERE\s+(.+?))?;?$/i)
    if (selectTable) {
      const schema = selectTable[1].replace(/""/g, '"')
      const table = selectTable[2].replace(/""/g, '"')
      const fields = COLUMNS.filter((column) => column[0] === schema && column[1] === table)
      if (!fields.length) throw new Error('模拟表不存在')
      const result = q(fields.map((column) => column[2]), params.has('queryEmpty') || /1\s*=\s*0/.test(selectTable[3] || '') ? []
        : [fields.map((column, i) => i === 0 ? 1 : column[2] === 'amount' ? '128.50' : column[2] === 'created_at' ? '2026-10-10 10:00:00' : i === 1 ? '示例数据' : null)])
      result.truncated = params.has('queryTruncated')
      return result
    }
    if (/^SELECT 1$/i.test(s.trim())) return q([], [])
    if (s.includes(' as available')) return q(['available'], [[params.has('mysql57') ? 0 : 1]])
    if (/information_schema\.schemata/i.test(s)) {
      const dbs = window.__schemata || [['shop'], ['other']]
      return q(['database_name'], dbs)
    }
    if (s.includes('seq_in_index')) {
      // MySQL STATISTICS / legacy 索引（legacy 含 NULL AS expression，列少两列）
      const legacy = s.includes('null as expression')
      const cols = ['table_schema', 'table_name', 'column_name', 'seq', 'index_name', 'index_type', 'index_comment', 'non_unique', 'collation', 'sub_part']
      if (!legacy) cols.push('expression')
      return q(cols, [['public', 'users', 'id', 1, 'PRIMARY', 'BTREE', '', '0', 'A', null, ...(legacy ? [] : [null])]])
    }
    if (s.includes('key_column_usage')) {
      return q(['table_schema', 'table_name', 'constraint_name', 'column_name', 'seq', 'referenced_schema', 'referenced_table', 'referenced_column', 'update_rule', 'delete_rule'],
        [['public', 'orders', 'orders_user_id_fkey', 'user_id', 1, 'public', 'users', 'id', 'NO ACTION', 'NO ACTION']])
    }
    if (s.includes('check_constraints')) {
      if (params.has('mysql57')) throw new Error("ERROR 1109 (42S02): Unknown table 'check_constraints' in information_schema")
      return q(['table_schema', 'table_name', 'constraint_name', 'check_clause'], [['public', 'orders', 'orders_amount_check', 'amount > 0']])
    }
    if (/FROM information_schema\.tables/i.test(s)) {
      return q(
        ['table_schema', 'table_name', 'table_comment', 'engine', 'table_collation', 'column_count'],
        TABLES.map(([sc, t, cmt, n]) => [sc, t, cmt, sc === 'public' && t === displayTable ? params.get('engine') || '' : '', sc === 'public' && t === displayTable ? params.get('collation') || '' : '', n])
      )
    }
    if (s.includes("con.contype = 'f'")) {
      const table = (s.match(/relname = '([^']+)'/) || [])[1]
      const schema = (s.match(/nspname = '([^']+)'/) || [])[1]
      return q(
        ['table_schema', 'table_name', 'constraint_name', 'constraint_type', 'column_name', 'seq', 'referenced_schema', 'referenced_table', 'referenced_column', 'update_rule', 'delete_rule', 'check_clause'],
        FKS.filter((f) => (!table || f[1] === table) && (!schema || f[0] === schema)).map((f) => [f[0], f[1], f[2], 'FOREIGN KEY', f[3], f[4], f[5], f[6], f[7], 'NO ACTION', 'NO ACTION', ''])
      )
    }
    if (s.includes("con.contype = 'c'")) {
      const table = (s.match(/relname = '([^']+)'/) || [])[1]
      const schema = (s.match(/nspname = '([^']+)'/) || [])[1]
      return q(
        ['table_schema', 'table_name', 'constraint_name', 'constraint_type', 'column_name', 'seq', 'referenced_schema', 'referenced_table', 'referenced_column', 'update_rule', 'delete_rule', 'check_clause'],
        CHECKS.filter((c) => (!table || c[1] === table) && (!schema || c[0] === schema)).map((c) => [c[0], c[1], c[2], 'CHECK', '', 0, '', '', '', '', '', c[3]])
      )
    }
    if (s.includes('pg_index')) {
      const table = (s.match(/relname = '([^']+)'/) || [])[1]
      const schema = (s.match(/nspname = '([^']+)'/) || [])[1]
      return q(
        ['table_schema', 'table_name', 'column_name', 'seq', 'index_name', 'index_type', 'index_comment', 'non_unique', 'collation', 'is_primary', 'is_unique', 'is_included', 'is_expression', 'predicate', 'constraint_type', 'sub_part'],
        INDEXES.filter((i) => (!table || i[1] === table) && (!schema || i[0] === schema)).map((i) => [
          i[0], i[1], i[2], i[3], i[4], 'btree', '', i[5] ? '0' : '1', 'ASC', i[5], i[6], false, i[7], '', i[5] ? 'p' : '', null
        ])
      )
    }
    if (s.includes('ilike')) {
      const kw = ((s.match(/ilike '%([^']*)%'/) || [])[1] || '').replace(/\\([%_\\])/g, '$1')
      const schema = (s.match(/c\.table_schema = '([^']+)'/) || [])[1]
      const hits = []
      COLUMNS.forEach(([sc, t, col, _type, _dataType, _nullable, _identity, _default, comment]) => {
        if ((!schema || sc === schema) && (col.toLowerCase().includes(kw) || comment.toLowerCase().includes(kw) || kw === '')) hits.push([sc, t, col, comment])
      })
      return q(['table_schema', 'table_name', 'column_name', 'column_comment'], hits)
    }
    if (s.includes('from information_schema.columns')) {
      const table = (s.match(/(?:c\.)?table_name = '([^']+)'/) || [])[1]
      const schema = (s.match(/(?:c\.)?table_schema = '([^']+)'/) || [])[1]
      const rows = COLUMNS.filter((c) => (!table || c[1] === table) && (!schema || c[0] === schema)).map((c, i) => [
        c[0], c[1], c[2],
        c[6] ? 'IDENTITY' : null,       // extra
        c[7], c[8],                     // column_default, column_comment
        c[3], c[4],                     // column_type, data_type
        c[5], i + 1,                    // is_nullable, ordinal_position
        null, null, null,               // character_maximum_length, numeric_precision, scale
        null, null,                     // character_set_name, collation_name
        c[6] ? 'YES' : 'NO', null, null, null,  // is_identity, identity_generation/start/increment
        'NEVER', null                   // is_generated, generation_expression
      ])
      return q(
        ['table_schema', 'table_name', 'column_name', 'extra', 'column_default', 'column_comment', 'column_type', 'data_type', 'is_nullable', 'ordinal_position', 'character_maximum_length', 'numeric_precision', 'scale', 'character_set_name', 'collation_name', 'is_identity', 'identity_generation', 'identity_start', 'identity_increment', 'is_generated', 'generation_expression'],
        rows
      )
    }
    throw new Error('mock: unrecognized sql → ' + s.slice(0, 120))
  }

  let contextCb = null
  const storageMap = new Map()
  let currentContext = params.has('empty') || params.has('picker') ? {} : { connectionId: 'c1', dbType: 'postgres', name: '示例业务数据库', database: 'appdb' }
  if (params.has('picker') || params.has('connections')) storageMap.set('dbdoc.recent', JSON.stringify([
    { connectionId: 'dev', name: '业务开发环境', dbType: 'mysql', database: 'public', ts: 600 },
    { connectionId: 'dev', name: '业务开发环境', dbType: 'mysql', database: 'reporting', ts: 500 },
    { connectionId: 'c1', name: '数据分析环境', dbType: 'postgres', database: 'appdb', ts: 400 },
    { connectionId: 'c1', name: '数据分析环境', dbType: 'postgres', database: 'events', ts: 300 },
    { connectionId: 'slow', name: '集成测试环境', dbType: 'mysql', database: 'staging', ts: 200 }
  ]))
  if (params.has('connections') && !params.has('picker')) currentContext.name = '数据分析环境'
  if (params.has('connectionOnly')) currentContext = { connectionId: 'dev', dbType: 'mysql', name: '业务开发环境' }
  if (params.has('legacyNames') && storageMap.has('dbdoc.recent')) {
    storageMap.set('dbdoc.recent', JSON.stringify(JSON.parse(storageMap.get('dbdoc.recent')).map((entry) => ({ ...entry, name: '' }))))
  }
  if (params.has('nameless')) delete currentContext.name
  if (params.get('connectionName')) currentContext.name = params.get('connectionName')
  if (params.get('database')) currentContext.database = params.get('database')
  if (params.get('connectionId')) currentContext.connectionId = params.get('connectionId')
  if (params.has('mysql57')) currentContext = { ...currentContext, dbType: 'mysql', database: 'public' }
  if (params.get('table')) currentContext = { ...currentContext, schema: params.get('schema') || 'public', table: params.get('table') === 'orders' && params.get('schema') !== 'sales' ? displayTable : params.get('table') }
  if (params.has('tableAsName')) currentContext = { ...currentContext, schema: 'public', table: currentContext.table || 'orders', name: currentContext.table || 'orders' }
  let denied = params.has('denied')
  let slow = false
  let databaseFail = params.has('dbfail')
  let connectionClosed = params.has('closed')
  let closedDatabase = params.get('closedDb')
  let nameSaveFailed = params.has('nameSaveFail')
  let catalogFailed = params.has('catalogFail')
  let partialFailed = params.has('partial')
  let allDetailsFailed = params.has('allDetailsFail')
  let searchFailed = params.has('searchFail')
  const tableQueryCounts = new Map()
  let lastSaveName = ''
  let lastCopied = ''
  let savedBytes = 0
  window.__qcount = { tables: 0, detail: 0, search: 0, probe: 0, databases: 0, data: 0, all: 0 }
  window.dbxPlugin = {
    ready: Promise.resolve(),
    contributionId: params.has('queryPage') ? 'com.sazs.dbdoc.query' : 'com.sazs.dbdoc.main',
    capabilities: { dataApi: !params.has('dataUnavailable'), schemaMetadataApi: true, storage: true, clipboardWrite: true },
    theme: { appearance: params.get('theme') || 'light', tokens: {} },
    get context() { return currentContext },
    onContext: (cb) => {
      contextCb = cb
      return () => { contextCb = null }
    },
    queryData: async (req) => {
      const s = String(req.sql).replace(/\s+/g, ' ')
      const dataQuery = /^SELECT \* FROM\b/i.test(s.trim())
      if (dataQuery) window.__qcount.data += 1
      const fieldSearch = /\bilike\b/i.test(s)
      window.__qcount.all += 1
      if (/information_schema\.schemata/i.test(s)) window.__qcount.databases += 1
      if (/information_schema\.tables/i.test(s)) window.__qcount.tables += 1
      else if (fieldSearch) window.__qcount.search += 1
      else if (/pg_index|information_schema\.columns|con\.contype|statistics/i.test(s)) window.__qcount.detail += 1
      else if (/^SELECT 1$/.test(s.trim())) window.__qcount.probe += 1
      const queriedTable = (s.match(/(?:relname|table_name)\s*=\s*'([^']+)'/i) || [])[1]
      const queriedSchema = (s.match(/(?:nspname|table_schema)\s*=\s*'([^']+)'/i) || [])[1] || ''
      if (queriedTable) {
        const key = queriedSchema + '.' + queriedTable
        tableQueryCounts.set(key, (tableQueryCounts.get(key) || 0) + 1)
      }
      console.log('[mock] queryData:', s.slice(0, 90))
      updateStats()
      if (fieldSearch && params.has('slowSearch') && s.includes('user\\_id')) {
        await sleep(1800)
      }
      await sleep((params.has('slowOpen') && s.trim() === 'SELECT 1' && req.connectionId === 'dev') || (req.connectionId === 'slow' && /information_schema\.schemata/i.test(s)) ? 1300 : (slow || params.has('slowUsers')) && s.includes("'users'") ? 1800 : DELAY)
      if (denied) throw new Error('PLUGIN_DATA_ACCESS_NOT_GRANTED: 模拟授权拒绝')
      if (connectionClosed || (closedDatabase && req.database === closedDatabase)) throw new Error('Connection is not open')
      if (dataQuery && params.has('queryFail')) throw new Error('模拟查询执行失败')
      if (databaseFail && /information_schema\.schemata/i.test(s)) throw new Error('模拟数据库列表读取失败')
      if (catalogFailed && /information_schema\.tables/i.test(s)) throw new Error('模拟目录读取失败')
      if (fieldSearch && searchFailed) throw new Error('模拟字段搜索失败')
      if (allDetailsFailed && queriedTable) throw new Error('模拟全部表元数据读取失败')
      if (/information_schema\.schemata/i.test(s) && (req.connectionId === 'dev' || req.connectionId === 'slow')) {
        const names = req.connectionId === 'slow' ? ['staging', 'qa'] : ['public', 'reporting', 'support', 'archive']
        for (let i = 0, count = Math.min(1000, Number(params.get('databases')) || 0); i < count; i++) names.push('domain_' + String(i).padStart(3, '0'))
        return q(['database_name'], names.map((name) => [name]))
      }
      if (partialFailed && s.includes("'customers'")) throw new Error('模拟 customers 元数据读取失败')
      // 模拟「上下文带的库名与库内实际不符」：目录查询在 req.database 为错值时返回空集
      if (window.__wrongDb && req.database === window.__wrongDb && /information_schema\.tables|sys\.tables/i.test(s)) {
        return q(['table_schema', 'table_name', 'table_comment', 'engine', 'table_collation', 'column_count'], [])
      }
      const result = answer(req.sql)
      if (fieldSearch && params.has('slowSearch') && s.includes('user\\_id')) {
        const status = document.getElementById('repro-search-status')
        if (status) status.textContent = '旧字段查询已返回'
      }
      if (params.has('truncated') && /information_schema\.tables/i.test(s)) result.truncated = true
      if (params.has('searchTruncated') && fieldSearch) result.truncated = true
      return result
    },
    getTableMetadata: async () => ({ columns: [] }),
    storage: {
      get: async (key) => {
        if (params.has('lateConnectionName') && key === 'dbdoc.recent') await sleep(300)
        if (params.has('storagefail')) throw new Error('模拟存储不可用')
        return storageMap.get(key) ?? null
      },
      set: async (key, value) => {
        if (nameSaveFailed && key === 'dbdoc.recent') throw new Error('模拟显示名称存储失败')
        storageMap.set(key, value)
      }
    },
    copy: async (text) => { lastCopied = text; updateStats() }
  }
  if (!params.has('noWorkbench')) window.dbxPlugin.openWorkbench = async (id, context, options) => {
    if (params.has('openQueryFail')) throw new Error('模拟宿主打开查询失败')
    if (id !== 'com.sazs.dbdoc.query' || !options?.forceNew || options?.target !== 'tab') throw new Error('模拟查询导航参数无效')
    const next = new URL(location.href)
    next.searchParams.set('queryPage', '1')
    for (const [key, value] of Object.entries(context)) {
      if (typeof value === 'string') next.searchParams.set(key === 'name' ? 'connectionName' : key, value)
    }
    if (!window.open(next.href, '_blank')) throw new Error('浏览器阻止了新查询标签页')
  }
  window.__emitContext = (ctx) => {
    console.log('[mock] emit context:', JSON.stringify(ctx))
    currentContext = ctx
    if (contextCb) contextCb(ctx)
  }
  if (params.has('lateConnectionName')) setTimeout(() => window.__emitContext({ ...currentContext, name: '重命名的业务连接' }), 80)
  if (params.has('initdelay')) {
    window.dbxPlugin.capabilities = {}
    window.dbxPlugin.ready = sleep(300).then(() => {
      window.dbxPlugin.capabilities = { dataApi: true, schemaMetadataApi: true, storage: true, clipboardWrite: true }
    })
    setTimeout(() => window.__emitContext({ ...currentContext, schema: 'sales', table: 'orders' }), 80)
  }
  // 测试辅助：预置最近连接 / 读存储
  window.__seedRecent = (list) => storageMap.set('dbdoc.recent', JSON.stringify(list))
  if (params.has('save')) window.dbxPlugin.fileTransfer = {
    beginSave: async (request) => { lastSaveName = request.name; updateStats(); return params.get('save') === 'cancel' ? null : { handleId: 'mock-file', chunkBytes: 64 } },
    write: async (_handle, _offset, data) => {
      if (params.get('save') === 'fail') throw new Error('模拟保存失败')
      savedBytes += data.byteLength
      updateStats()
    }, finish: async () => {}, cancel: async () => {}
  }
  function updateStats() {
    const stats = document.getElementById('repro-stats')
    if (stats) stats.textContent = `目录查询 ${window.__qcount.tables} · 详情查询 ${window.__qcount.detail} · 字段搜索 ${window.__qcount.search} · 数据查询 ${window.__qcount.data} · 探测 ${window.__qcount.probe} · 数据库列表查询 ${window.__qcount.databases} · 已渲染表 ${document.querySelectorAll('.catalog-row').length} · 已复制 ${lastCopied.length} 字 · 已保存 ${savedBytes} 字节`
    const tableStats = document.getElementById('repro-table-queries')
    if (tableStats) tableStats.textContent = `按表查询：${[...tableQueryCounts].map(([name, count]) => `${name} ${count}`).join(' · ')}${lastSaveName ? `；保存文件名：${lastSaveName}` : ''}`
  }
  document.addEventListener('DOMContentLoaded', () => {
    const panel = document.createElement('details')
    panel.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:200;background:#eef2f7;color:#334155;border:1px solid #cbd5e1;border-radius:6px;padding:5px 8px;font:11px sans-serif;max-width:650px'
    const summary = document.createElement('summary')
    summary.textContent = '模拟宿主验收工具'
    panel.append(summary)
    const stats = document.createElement('p'); stats.id = 'repro-stats'; panel.append(stats)
    const tableStats = document.createElement('p'); tableStats.id = 'repro-table-queries'; panel.append(tableStats)
    const searchStatus = document.createElement('p'); searchStatus.id = 'repro-search-status'; panel.append(searchStatus)
    const button = (label, callback) => { const el = document.createElement('button'); el.textContent = label; el.onclick = callback; el.style.margin = '3px'; panel.append(el) }
    button('更新验收统计', updateStats)
    button('切换明暗主题', () => { window.dbxPlugin.theme.appearance = window.dbxPlugin.theme.appearance === 'dark' ? 'light' : 'dark'; window.dispatchEvent(new Event('dbx-plugin-env')) })
    button('模拟重复上下文', () => window.__emitContext({ ...currentContext }))
    button('模拟表右键 public.orders', () => window.__emitContext({ connectionId: 'c1', dbType: 'postgres', name: '示例业务数据库', database: 'appdb', schema: 'public', table: 'orders' }))
    button('模拟表右键 sales.orders', () => window.__emitContext({ connectionId: 'c1', dbType: 'postgres', name: '示例业务数据库', database: 'appdb', schema: 'sales', table: 'orders' }))
    button('模拟慢请求', () => { slow = true; window.__emitContext({ connectionId: 'c1', dbType: 'postgres', name: '示例业务数据库', database: 'appdb', schema: 'public', table: 'users' }) })
    const raceStatus = document.createElement('p'); panel.append(raceStatus)
    button('模拟旧详情响应晚于新表', () => {
      slow = true
      raceStatus.textContent = '慢请求回归进行中'
      window.__emitContext({ connectionId: 'race', dbType: 'postgres', name: '延迟响应回归', database: 'appdb', schema: 'public', table: 'users' })
      setTimeout(() => window.__emitContext({ connectionId: 'race', dbType: 'postgres', name: '延迟响应回归', database: 'appdb', schema: 'sales', table: 'orders' }), 350)
      setTimeout(() => { raceStatus.textContent = '慢请求回归完成'; updateStats() }, 2400)
    })
    button('恢复数据访问授权', () => { denied = false })
    button('恢复数据库列表读取', () => { databaseFail = false })
    button('模拟打开数据库会话', () => { connectionClosed = false; closedDatabase = null })
    button('模拟关闭数据库会话', () => { connectionClosed = true })
    button('模拟表入口不含名称', () => window.__emitContext({ connectionId: currentContext.connectionId || currentContext.id || 'dev', dbType: currentContext.dbType || 'mysql', database: currentContext.database || 'public', schema: 'public', table: 'orders' }))
    button('模拟连接名称更新', () => window.__emitContext({ ...currentContext, name: '重命名的业务连接' }))
    button('恢复显示名称保存', () => { nameSaveFailed = false })
    button('模拟目录读取失败', () => { catalogFailed = true })
    button('恢复目录读取', () => { catalogFailed = false })
    button('恢复字段搜索', () => { searchFailed = false })
    button('模拟全部表读取失败', () => { allDetailsFailed = true })
    button('恢复表元数据读取', () => { partialFailed = false; allDetailsFailed = false })
    button('模拟数据访问授权被拒绝', () => { denied = true })
    document.body.append(panel)
    updateStats()
  })
})()
