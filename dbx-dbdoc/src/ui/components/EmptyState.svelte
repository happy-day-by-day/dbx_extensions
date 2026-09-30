<script lang="ts">
  import Icon from './Icon.svelte'
  let { icon, title, description, actionLabel, onaction, secondaryLabel, onsecondary }: {
    icon: string
    title: string
    description: string
    actionLabel?: string
    onaction?: () => void
    secondaryLabel?: string
    onsecondary?: () => void
  } = $props()
</script>

<div class="empty">
  <div class="empty-icon"><Icon name={icon} size={30} /></div>
  <h2 class="empty-title">{title}</h2>
  <p class="empty-desc">{description}</p>
  <div class="empty-actions">{#if actionLabel && onaction}<button class="btn btn-primary" onclick={onaction}>{actionLabel}</button>{/if}
    {#if secondaryLabel && onsecondary}<button class="btn" onclick={onsecondary}>{secondaryLabel}</button>{/if}</div>
</div>
<style>.empty-actions { display: flex; justify-content: center; gap: 10px; margin-top: 22px; }</style>
