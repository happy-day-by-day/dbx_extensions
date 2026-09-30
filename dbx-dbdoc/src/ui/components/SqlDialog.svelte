<!-- 建表 SQL 查看弹窗（Task 14）：模态遮罩 + 居中面板；createTableSql 生成的 DDL 以
     pre/code 展示；复制走 bridge.copyText（内部已含 clipboard 兜底），成功 1400ms 对勾；
     Esc / 遮罩点击关闭（遮罩点击为鼠标快捷路径，键盘等价物是 Esc，故忽略 a11y 告警）。 -->
<script lang="ts">
  import { onDestroy } from 'svelte'
  import { getBridge } from '../../lib/bridge'
  import { createTableSql } from '../../lib/createTableSql'
  import type { AppState } from '../state.svelte'
  import { modalFocus } from '../modalFocus'
  import Icon from './Icon.svelte'

  // 局部变量命名为 app 而非 state：同名会让 $state(...) 被解析成 store 订阅（App 同款约定）。
  let { state: app, onclose }: { state: AppState; onclose: () => void } = $props()

  const sql = $derived(app.detail ? createTableSql(app.detail, app.dbType) : '')

  const fullName = $derived.by(() => {
    const t = app.detail?.table
    if (!t) return ''
    return t.table_schema ? `${t.table_schema}.${t.table_name}` : t.table_name
  })

  // —— 复制反馈：成功「已复制 ✓」/ 失败「复制失败」，均 1400ms 后复位 ——
  let copyState = $state<'idle' | 'ok' | 'fail'>('idle')
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  onDestroy(() => clearTimeout(copyTimer))

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') onclose()
  }

  async function copySql() {
    // bridge 缺失时 copyText 结果为 undefined，按失败处理
    const ok = (await getBridge()?.copyText(sql)) ?? false
    copyState = ok ? 'ok' : 'fail'
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => (copyState = 'idle'), 1400)
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- detail 为空属理论不可达（仅 Detail 有数据时可打开），渲染空面板兜底 -->
{#if app.detail}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="modal-mask"
    role="presentation"
    onclick={(e) => {
      // 仅点击遮罩自身时关闭；面板内点击冒泡到遮罩但 target 不是遮罩，不关闭
      if (e.target === e.currentTarget) onclose()
    }}
  >
    <div class="modal-panel sql-panel" use:modalFocus role="dialog" aria-modal="true" aria-label="建表 SQL">
      <header class="sql-head">
        <h3 class="sql-title" title={fullName}><Icon name="code" size={19} /><span>建表 SQL · {fullName}</span></h3>
        <button class="icon-btn" aria-label="关闭 SQL" title="关闭" onclick={onclose}><Icon name="close" size={18} /></button>
      </header>
      <p class="sql-note">根据元数据重建的参考 SQL，执行前请核对数据库版本与完整约束。</p>
      <pre class="sql-pre"><code>{sql}</code></pre>
      <footer class="sql-foot">
        <button class="btn btn-primary" onclick={copySql} title="复制建表 SQL 到剪贴板"><Icon name={copyState === 'ok' ? 'check' : 'copy'} size={16} />{copyState === 'ok' ? '已复制' : copyState === 'fail' ? '复制失败' : '复制'}</button>
        <button class="btn" onclick={onclose}>关闭</button>
      </footer>
    </div>
  </div>
{:else}
  <div class="modal-mask" role="presentation">
    <div class="modal-panel sql-panel">暂无表详情</div>
  </div>
{/if}

<style>
  .sql-note { margin: 0; color: var(--muted); font-size: 12px; }
  .sql-panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .sql-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .sql-title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .sql-title span { overflow: hidden; text-overflow: ellipsis; }

  .sql-pre {
    margin: 0;
    padding: 16px 18px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--bg);
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.6;
    white-space: pre;
    overflow: auto;
    max-height: 60vh;
  }

  .sql-foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    border-top: 1px solid var(--border);
    padding-top: 16px;
  }
</style>
