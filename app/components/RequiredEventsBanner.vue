<script setup lang="ts">
import type { RequiredEventsCoverage } from '../../server/modules/tournaments/required-events';
import { REQUIRED_EVENTS_KEY } from '~/composables/useRequiredEvents';

/**
 * The required-events banner on This week and on Tournaments' other tabs (ADR-0010 decision 12, #162): a line per League Cup or League Challenge at risk or
 * worse, most urgent first, and one per professor whose tournaments couldn't be read. It can't be dismissed; a line
 * goes only when its cause does. It is named "Required events alerts" so the grid alone is the "Required events" region. It reads the layout's coverage fetch (the nav badge's key), never a second one.
 * With `progress` (Tournaments, #191) it also says while coverage is being read, and when the read failed, so a page
 * still loading or a failed read never looks like "nothing at risk".
 */
const props = defineProps<{ progress?: boolean; failed?: boolean }>();
const toast = useToast();
const { data: coverage } = useNuxtData<RequiredEventsCoverage>(REQUIRED_EVENTS_KEY);
const lines = computed(() => (coverage.value ? bannerLines(coverage.value, coverage.value.today) : []));
const loud = computed(() => lines.value.some((l) => l.tone === 'error'));
const retrying = ref(false);

async function retry() {
  retrying.value = true;
  try {
    await refreshRequiredEvents({ upstream: true });
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not read required events.') });
  } finally {
    retrying.value = false;
  }
}
</script>

<template>
  <p v-if="props.progress && !coverage && !props.failed" role="status" class="flex items-center gap-2 text-sm text-muted">
    <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" aria-hidden="true" />Checking required events…
  </p>
  <section
    v-else-if="props.progress && !coverage && props.failed"
    aria-label="Required events alerts"
    role="alert"
    class="flex flex-wrap items-center gap-2 rounded-md border border-error/50 bg-error/5 p-3 text-sm"
  >
    <UIcon name="i-lucide-circle-alert" class="shrink-0 text-error" />
    <span class="min-w-0 flex-1 break-words">Could not check required events.</span>
    <UButton size="xs" variant="outline" color="neutral" :loading="retrying" @click="retry">Try again</UButton>
  </section>
  <section
    v-else-if="lines.length"
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
