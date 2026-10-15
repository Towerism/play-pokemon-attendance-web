<script setup lang="ts">
import type { PeriodCoverage } from '../../shared/requirements/coverage';
import type { Requirement } from '../../server/modules/tournaments/requirements';

/** **Mark as covered…** (ADR-0010 decision 12): an event the app can't see, recorded with a note, who and when. */
const props = defineProps<{ requirement: Requirement; period: PeriodCoverage }>();
const emit = defineEmits<{ close: [] }>();
const toast = useToast();

const open = ref(true);
const note = ref('');
const saving = ref(false);
const error = ref<string | null>(null);
watch(open, (o) => {
  if (!o) emit('close');
});

async function save() {
  if (!note.value.trim()) return;
  saving.value = true;
  error.value = null;
  try {
    await $fetch(`/api/tournament-requirements/${props.requirement.id}/covers/${props.period.periodStart}`, { method: 'PUT', body: { note: note.value } });
    await refreshRequiredEvents();
    toast.add({ color: 'success', title: 'Marked as covered' });
    open.value = false;
  } catch (err) {
    error.value = apiErrorMessage(err, 'Could not save the cover.');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Mark as covered" :description="`${requirementLabel(requirement)} · ${periodLabel(period, requirement.cadence)}`">
    <template #body>
      <div class="space-y-3">
        <p class="text-sm text-muted">For an event the app can't see, such as one run by a professor who hasn't connected. It shows as covered (manual), never sanctioned.</p>
        <UFormField label="Note" required>
          <UTextarea v-model="note" :rows="3" maxlength="500" placeholder="Run by Professor X, 0123-…" class="w-full" />
        </UFormField>
        <p v-if="error" class="text-sm text-error">{{ error }}</p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" @click="open = false">Cancel</UButton>
        <UButton :disabled="!note.trim()" :loading="saving" @click="save">Save cover</UButton>
      </div>
    </template>
  </UModal>
</template>
