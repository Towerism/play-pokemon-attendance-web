<script setup lang="ts">
import type { RequiredEventsCoverage } from '../../server/modules/tournaments/required-events';
import { REQUIRED_EVENTS_KEY } from '~/composables/useRequiredEvents';

/**
 * The required-events banner on This week and on Tournaments' other tabs (ADR-0010 decision 12, #162): a line per League Cup or League Challenge at risk or
 * worse, most urgent first, and one per professor whose tournaments couldn't be read. It can't be dismissed; a line
 * goes only when its cause does. It is named "Required events alerts" so the grid alone is the "Required events" region. It reads the layout's coverage fetch (the nav badge's key), never a second one.
 */
const { data: coverage } = useNuxtData<RequiredEventsCoverage>(REQUIRED_EVENTS_KEY);
const lines = computed(() => (coverage.value ? bannerLines(coverage.value, coverage.value.today) : []));
const loud = computed(() => lines.value.some((l) => l.tone === 'error'));
const retrying = ref(false);

async function retry() {
  retrying.value = true;
  try {
    await refreshRequiredEvents({ upstream: true });
  } finally {
    retrying.value = false;
  }
}
</script>

<template>
  <section
    v-if="lines.length"
    aria-label="Required events alerts"
    :role="loud ? 'alert' : undefined"
    class="space-y-2 rounded-md border p-3 text-sm"
    :class="loud ? 'border-error/50 bg-error/5' : 'border-warning/50 bg-warning/5'"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="font-medium">Required events</h2>
      <NuxtLink :to="{ path: '/tournaments', query: { tab: 'required' } }" class="underline">Open Required events</NuxtLink>
    </div>
    <ul class="space-y-1">
      <li v-for="line in lines" :key="line.text" class="flex flex-wrap items-start gap-2">
        <UIcon :name="line.tone === 'error' ? 'i-lucide-circle-alert' : 'i-lucide-triangle-alert'" class="mt-0.5 shrink-0" :class="line.tone === 'error' ? 'text-error' : 'text-warning'" />
        <span class="min-w-0 flex-1 break-words">{{ line.text }}</span>
        <NuxtLink v-if="line.action === 'reconnect'" to="/settings" class="underline">Reconnect</NuxtLink>
        <UButton v-else-if="line.action === 'retry'" size="xs" variant="outline" color="neutral" :loading="retrying" @click="retry">Retry</UButton>
      </li>
    </ul>
  </section>
</template>
