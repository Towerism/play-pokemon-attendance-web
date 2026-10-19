<script setup lang="ts">
import { Thresholds } from '#shared/schemas/settings';

const toast = useToast();
const { data } = await useSettings();

const state = reactive({ promoteMinSightings: 4, staleAfterSessions: 6 });
watch(
  () => data.value?.thresholds,
  (t) => t && Object.assign(state, t),
  { immediate: true },
);

const saving = ref(false);
async function save() {
  saving.value = true;
  try {
    const result = await $fetch('/api/settings', { method: 'PUT', body: { thresholds: Thresholds.parse(state) } });
    if (result.thresholds) Object.assign(state, result.thresholds);
    toast.add({ color: 'success', title: 'Thresholds saved' });
    await refreshNuxtData('players');
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not save the thresholds.') });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="font-semibold">Curation</h2>
      <p class="text-sm text-muted">
        When the Players page suggests promoting someone to regular, or flags a regular as stale. Counts are "seen in events": a tournament, a
        hand-added player, or a "present" tick.
      </p>
    </template>
    <UForm :schema="Thresholds" :state="state" class="space-y-4" @submit="save">
      <UFormField name="promoteMinSightings" label="Promotion candidate" description="Not a regular, and seen in at least this many events in the last 8 weeks.">
        <UInputNumber v-model="state.promoteMinSightings" :min="1" :max="52" class="w-32" />
      </UFormField>
      <UFormField name="staleAfterSessions" label="Stale regular" description="A regular with no tournament or &quot;present&quot; tick in this many sessions.">
        <UInputNumber v-model="state.staleAfterSessions" :min="1" :max="52" class="w-32" />
      </UFormField>
      <UButton type="submit" :loading="saving">Save</UButton>
    </UForm>
  </UCard>
</template>
