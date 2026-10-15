<script setup lang="ts">
import type { Requirement } from '../../server/modules/tournaments/requirements';

/**
 * **Requirements…** (ADR-0010 decision 12): what the league must hold each period. Seeded with six; rows are turned
 * off, never deleted. Each row is saved on its own, sending only what changed.
 */
const open = defineModel<boolean>('open', { required: true });
const toast = useToast();

type Draft = Omit<Requirement, 'id'>;
const requirements = ref<Requirement[]>([]);
const drafts = ref<Record<number, Draft>>({});
const adding = ref<Draft>(blank());
const loading = ref(false);
const error = ref<string | null>(null);
const savingId = ref<number | 'new' | null>(null);

const GAMES = [
  { value: 'tcg', label: 'TCG' },
  { value: 'pgo', label: 'GO' },
  { value: 'vg', label: 'VGC' },
];
const CADENCES = [
  { value: 'month', label: 'Each month' },
  { value: 'quarter', label: 'Each quarter' },
];

function blank(): Draft {
  return { seriesMatch: '', product: 'tcg', cadence: 'month', minCount: 1, warnDays: 21, active: true };
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const res = await $fetch<{ requirements: Requirement[] }>('/api/tournament-requirements');
    requirements.value = res.requirements;
    drafts.value = Object.fromEntries(res.requirements.map((r) => [r.id, { ...r }]));
  } catch (err) {
    error.value = apiErrorMessage(err, 'Could not read the requirements.');
  } finally {
    loading.value = false;
  }
}

watch(open, (o) => {
  if (o) {
    adding.value = blank();
    void load();
  }
});

async function save(r: Requirement) {
  const patch = requirementPatch(r, drafts.value[r.id]!);
  if (Object.keys(patch).length === 0) return;
  savingId.value = r.id;
  error.value = null;
  try {
    await $fetch(`/api/tournament-requirements/${r.id}`, { method: 'PATCH', body: patch });
    await Promise.all([load(), refreshRequiredEvents()]);
    toast.add({ color: 'success', title: `Saved ${requirementLabel(drafts.value[r.id]!)}` });
  } catch (err) {
    error.value = apiErrorMessage(err, 'Could not save the requirement.');
  } finally {
    savingId.value = null;
  }
}

async function add() {
  if (!adding.value.seriesMatch.trim()) return;
  savingId.value = 'new';
  error.value = null;
  try {
    await $fetch('/api/tournament-requirements', { method: 'POST', body: adding.value });
    adding.value = blank();
    await Promise.all([load(), refreshRequiredEvents()]);
  } catch (err) {
    error.value = apiErrorMessage(err, 'Could not add the requirement.');
  } finally {
    savingId.value = null;
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Requirements" description="What the league must hold each period. Turn off a game the league doesn't run." :ui="{ content: 'sm:max-w-2xl' }">
    <template #body>
      <div class="space-y-4">
        <p v-if="loading && !requirements.length" class="text-sm text-muted">Reading requirements…</p>
        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="error" />
        <ul class="space-y-3" aria-label="Requirements">
          <li v-for="r in requirements" :key="r.id" :aria-label="requirementLabel(r)" class="rounded border border-default p-2 space-y-2">
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <UFormField label="Series match"><UInput v-model="drafts[r.id]!.seriesMatch" class="w-full" /></UFormField>
              <UFormField label="Game"><USelect v-model="drafts[r.id]!.product" :items="GAMES" class="w-full" /></UFormField>
              <UFormField label="Cadence"><USelect v-model="drafts[r.id]!.cadence" :items="CADENCES" class="w-full" /></UFormField>
              <UFormField label="Minimum"><UInputNumber v-model="drafts[r.id]!.minCount" :min="1" :max="10" class="w-full" /></UFormField>
              <UFormField label="Warn days ahead"><UInputNumber v-model="drafts[r.id]!.warnDays" :min="1" :max="180" class="w-full" /></UFormField>
              <UFormField label="On"><USwitch v-model="drafts[r.id]!.active" :aria-label="`On ${requirementLabel(r)}`" /></UFormField>
            </div>
            <UButton size="xs" :loading="savingId === r.id" :disabled="Object.keys(requirementPatch(r, drafts[r.id]!)).length === 0" @click="save(r)">
              Save
            </UButton>
          </li>
        </ul>
        <form class="rounded border border-dashed border-default p-2 space-y-2" @submit.prevent="add">
          <h3 class="text-sm font-medium">Add requirement</h3>
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <UFormField label="Series match"><UInput v-model="adding.seriesMatch" placeholder="League Cup" class="w-full" /></UFormField>
            <UFormField label="Game"><USelect v-model="adding.product" :items="GAMES" class="w-full" /></UFormField>
            <UFormField label="Cadence"><USelect v-model="adding.cadence" :items="CADENCES" class="w-full" /></UFormField>
          </div>
          <UButton type="submit" size="xs" :loading="savingId === 'new'" :disabled="!adding.seriesMatch.trim()">Add requirement</UButton>
        </form>
      </div>
    </template>
  </UModal>
</template>
