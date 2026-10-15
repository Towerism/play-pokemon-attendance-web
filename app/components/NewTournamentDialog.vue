<script setup lang="ts">
import type { Requirement } from '../../server/modules/tournaments/requirements';
import type { Template } from '../../server/modules/tournaments/service';

/**
 * **New tournament** (ADR-0010 decision 10): a one-off from a template and a date, up to 2 days back and 12 months
 * ahead. **Plan one…** opens it with the template and date chosen, or, with no matching template, offers to make one.
 */
const props = defineProps<{ today: string; templateId?: number | null; date?: string; missingFor?: Requirement | null }>();
const emit = defineEmits<{ close: []; newTemplate: [requirement: Requirement, date: string] }>();
const toast = useToast();

const open = ref(true);
const templates = ref<Template[]>([]);
const templateId = ref<number | undefined>(props.templateId ?? undefined);
const date = ref(props.date ?? props.today);
const startTime = ref('');
const saving = ref(false);
const error = ref<string | null>(null);
const min = computed(() => addDays(props.today, -2));
const max = computed(() => addDays(props.today, 365));

watch(open, (o) => {
  if (!o) emit('close');
});

onMounted(async () => {
  try {
    templates.value = (await $fetch<{ templates: Template[] }>('/api/tournament-templates')).templates.filter((t) => !t.archived);
  } catch (err) {
    error.value = apiErrorMessage(err, 'Could not read the templates.');
  }
});

async function save() {
  if (!templateId.value) return;
  saving.value = true;
  error.value = null;
  try {
    await $fetch('/api/planned-tournaments', {
      method: 'POST',
      body: { templateId: templateId.value, localDate: date.value, ...(startTime.value ? { startTime: startTime.value } : {}) },
    });
    await Promise.all([refreshUpcoming(), refreshRequiredEvents()]);
    toast.add({ color: 'success', title: `Planned for ${dayLabel(date.value)}` });
    open.value = false;
  } catch (err) {
    error.value =
      apiErrorCode(err) === 'already_planned' ? 'That tournament is already planned for this date and time.' : apiErrorMessage(err, 'Could not plan the tournament.');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" title="New tournament" description="A one-off from a template. Nothing goes to play-tools until you create it.">
    <template #body>
      <form class="space-y-3" @submit.prevent="save">
        <UAlert
          v-if="missingFor && !templateId"
          color="warning"
          variant="subtle"
          icon="i-lucide-file-plus"
          :title="`No template for ${missingFor.seriesMatch} · ${GAME[missingFor.product]} yet`"
        >
          <template #actions><UButton size="xs" variant="outline" @click="emit('newTemplate', missingFor!, date)">New template…</UButton></template>
        </UAlert>
        <UFormField label="Template" required>
          <USelect v-model="templateId" :items="templates.map((t) => ({ value: t.id, label: t.name }))" placeholder="Choose a template" aria-label="Template" class="w-full" />
        </UFormField>
        <UFormField label="Date" required :help="`From ${dayLabel(min)} (2 days back) to 12 months ahead`">
          <UInput v-model="date" type="date" :min="min" :max="max" class="w-full" />
        </UFormField>
        <UFormField label="Start time" help="Leave empty for the template's">
          <UInput v-model="startTime" type="time" class="w-full" />
        </UFormField>
        <p v-if="isShortNotice(date, today)" class="text-sm text-warning">Short notice: less than 7 days before it is held. You'll be asked to confirm when you create it.</p>
        <p v-if="error" class="text-sm text-error">{{ error }}</p>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" @click="open = false">Cancel</UButton>
        <UButton :disabled="!templateId || !date" :loading="saving" @click="save">Plan tournament</UButton>
      </div>
    </template>
  </UModal>
</template>
