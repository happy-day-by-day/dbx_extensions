<script lang="ts">
  let { name, size = 18 }: { name: string; size?: number } = $props()
  const paths: Record<string, string> = {
    database: 'M20 6c0 2.2-16 2.2-16 0s16-2.2 16 0ZM4 6v12c0 2.7 16 2.7 16 0V6M4 12c0 2.7 16 2.7 16 0',
    server: 'M4 4h16v6H4zM4 14h16v6H4zM7 7h.01M7 17h.01M11 7h6M11 17h6',
    search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm5-1.5L21 21',
    table: 'M4 4h16v16H4zM4 9h16M9 9v11',
    arrow: 'M5 12h14M13 6l6 6-6 6',
    back: 'M19 12H5M11 6l-6 6 6 6',
    chevron: 'm9 5 7 7-7 7',
    down: 'm6 9 6 6 6-6',
    switch: 'M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4',
    refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 1M18 18A8 8 0 0 1 5 17',
    export: 'M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5',
    copy: 'M9 9h11v11H9zM15 9V4H4v11h5',
    code: 'm8 6-6 6 6 6m8-12 6 6-6 6m-2-14-4 16',
    filter: 'M4 6h16M7 12h10M10 18h4',
    edit: 'm16 3 5 5M3 21l5-1 13-13-5-5L3 15z',
    close: 'm6 6 12 12M6 18 18 6',
    check: 'm5 12 4 4L19 6',
    grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z'
  }
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="ui-icon"><path d={paths[name] ?? paths.database} /></svg>
<style>.ui-icon { display: inline-block; flex: none; vertical-align: middle; }</style>
