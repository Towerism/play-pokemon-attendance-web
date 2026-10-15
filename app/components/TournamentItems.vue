<script setup lang="ts">
import type { TournamentItemView } from '../../server/modules/submission/service';

/** A tournament job's items (#92–#94): each tournament's outcome, play-tools' message and support details. */
defineProps<{ items: readonly TournamentItemView[] }>();
</script>

<template>
  <ul aria-label="Tournaments in this job" class="space-y-2">
    <li v-for="item in items" :key="item.position" class="rounded border border-default p-2 text-sm space-y-1">
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-medium break-words">{{ item.label }}</span>
        <UBadge variant="subtle" :color="['refused', 'failed', 'not_accepted', 'processing_failed'].includes(item.outcome) ? 'error' : item.outcome === 'unknown' ? 'warning' : 'neutral'">
          {{ outcomeLabel(item.outcome) }}
        </UBadge>
        <UBadge v-if="item.shortNotice" variant="outline" color="warning">Short notice</UBadge>
      </div>
      <p v-if="item.error" class="text-muted break-words">{{ item.error }}</p>
      <SupportDetails v-if="item.support" :support="item.support" />
    </li>
  </ul>
</template>
