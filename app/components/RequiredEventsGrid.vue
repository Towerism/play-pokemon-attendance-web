<script setup lang="ts">
import type { PeriodCoverage } from '../../shared/requirements/coverage';
import type { Requirement } from '../../server/modules/tournaments/requirements';

/**
 * Required events on top of Tournaments (ADR-0010 decision 12): each active requirement × its periods, with status,
 * urgency, what covers it and what fixes it. It shares its read with the nav badge.
 */
const emit = defineEmits<{ plan: [requirement: Requirement, period: PeriodCoverage]; create: [plannedId: number] }>();
const toast = useToast();

const { data: coverage, error, status } = await useRequiredEvents();
const refreshing = ref(false);
const covering = ref<{ requirement: Requirement; period: PeriodCoverage } | null>(null);
const requirementsOpen = ref(false);

const unread = computed(() => coverage.value?.unread ?? []);
const notice = computed(() =>
  coverage.value?.upstream === 'not_connected'
    ? 'Connect a Pokémon account in Settings to check required events.'
    : coverage.value?.upstream === 'league_not_selected'
      ? 'Choose a league in Settings to check required events.'
      : null,
);
const cell = (r: Requirement, p: PeriodCoverage) => `${requirementLabel(r)} · ${periodLabel(p, r.cadence)}`;

async function refresh() {
  refreshing.value = true;
  try {
    await refreshRequiredEvents({ upstream: true });
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not read required events.') });
  } finally {
    refreshing.value = false;
  }
}

async function uncover(r: Requirement, p: PeriodCoverage) {
  if (!window.confirm(`Remove the manual cover for ${cell(r, p)}?`)) return;
  try {
    await $fetch(`/api/tournament-requirements/${r.id}/covers/${p.periodStart}`, { method: 'DELETE' });
    await refreshRequiredEvents();
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not remove the cover.') });
  }
}
</script>

<template>
  <section aria-labelledby="required-events" class="space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 id="required-events" class="text-lg font-semibold">Required events</h2>
      <div class="flex gap-2">
        <UButton size="sm" variant="outline" icon="i-lucide-list-checks" @click="requirementsOpen = true">Requirements…</UButton>
        <UButton size="sm" variant="outline" icon="i-lucide-refresh-cw" :loading="refreshing" aria-label="Refresh required events" @click="refresh">Refresh</UButton>
      </div>
    </div>

    <UAlert v-if="error && !coverage" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="apiErrorMessage(error, 'Could not read required events.')">
      <template #actions><UButton size="xs" variant="outline" @click="refresh">Try again</UButton></template>
    </UAlert>
    <p v-else-if="status === 'pending' && !coverage" class="text-sm text-muted">Reading required events…</p>

    <template v-if="coverage">
      <UAlert v-if="notice" color="warning" variant="subtle" icon="i-lucide-plug-zap" :title="notice">
        <template #actions><UButton size="xs" variant="outline" to="/settings">Open Settings</UButton></template>
      </UAlert>
      <UAlert v-for="u in unread" :key="u.professor.playerId ?? u.message" color="warning" variant="subtle" icon="i-lucide-circle-alert" :title="`${professorName(u.professor)}: ${u.message}`">
        <template #actions>
          <UButton v-if="u.code === 'needs_reconnect'" size="xs" variant="outline" to="/settings">Open Settings</UButton>
          <UButton v-else size="xs" variant="outline" @click="refresh">Try again</UButton>
        </template>
      </UAlert>

      <p v-if="coverage.requirements.length === 0" class="text-sm text-muted">
        No required events are tracked. <button type="button" class="underline" @click="requirementsOpen = true">Requirements…</button>
      </p>

      <div v-for="{ requirement, periods } in coverage.requirements" :key="requirement.id" class="space-y-2">
        <h3 :id="`requirement-${requirement.id}`" class="text-sm font-medium">{{ requirementLabel(requirement) }}</h3>
        <ul :aria-labelledby="`requirement-${requirement.id}`" class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <RequiredEventCell
            v-for="p in periods"
            :key="p.periodStart"
            :requirement="requirement"
            :period="p"
            :today="coverage.today"
            :unread="unread"
            @plan="emit('plan', requirement, p)"
            @create="(id) => emit('create', id)"
            @cover="covering = { requirement, period: p }"
            @uncover="uncover(requirement, p)"
          />
        </ul>
      </div>
    </template>

    <CoverDialog v-if="covering" :requirement="covering.requirement" :period="covering.period" @close="covering = null" />
    <RequirementsDialog v-model:open="requirementsOpen" />
  </section>
</template>
