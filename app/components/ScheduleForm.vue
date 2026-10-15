<script setup lang="ts">
import type { Scaffold, Schedule, SchedulePreview } from '../../server/modules/tournaments/service';
import { type RuleParts, WEEKDAY_NAMES, partsFromRule, ruleFromParts, ruleText } from '~/utils/schedule-rule';

/**
 * A schedule (ADR-0010 decision 3): a scaffold and its recurrence, with the next dates previewed before saving.
 * Saving plans dates locally; nothing reaches play-tools until **Create in play-tools** or **Create through date…**.
 */
const props = defineProps<{ schedule?: Schedule | null; scaffolds: Scaffold[]; today: string }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const toast = useToast();

const open = ref(true);
const scaffoldId = ref<number | undefined>(props.schedule?.scaffoldId);
const parts = ref<RuleParts>(props.schedule ? partsFromRule(props.schedule.rule) : { kind: 'weekly', weekday: 5, every: 1, nth: 1, day: 1, month: 1 });
const startsOn = ref(props.schedule?.startsOn ?? props.today);
const endsOn = ref(props.schedule?.endsOn ?? '');
const horizonWeeks = ref<number | null>(props.schedule?.horizonWeeks ?? null);
const paused = ref(props.schedule?.paused ?? false);
const preview = ref<SchedulePreview | null>(null);
const previewError = ref<string | null>(null);
const saving = ref(false);
const error = ref<string | null>(null);

const rule = computed(() => ruleFromParts(parts.value));
const weekdays = Object.entries(WEEKDAY_NAMES).map(([value, label]) => ({ value: Number(value), label }));
const nths = [
  { value: 1, label: '1st' },
  { value: 2, label: '2nd' },
  { value: 3, label: '3rd' },
  { value: 4, label: '4th' },
  { value: 'last', label: 'Last' },
];

watch(open, (o) => {
  if (!o) emit('close');
});

let previewSeq = 0;
watch(
  [rule, startsOn, endsOn, scaffoldId],
  async () => {
    const seq = ++previewSeq;
    previewError.value = null;
    try {
      const res = await $fetch<SchedulePreview>('/api/tournament-schedules/preview', {
        method: 'POST',
        body: { rule: rule.value, startsOn: startsOn.value, endsOn: endsOn.value || null, ...(scaffoldId.value ? { scaffoldId: scaffoldId.value } : {}), count: 10 },
      });
      if (seq === previewSeq) preview.value = res;
    } catch (err) {
      if (seq === previewSeq) previewError.value = apiErrorMessage(err, 'Could not preview the dates.');
    }
  },
  { immediate: true, deep: true },
);

async function save() {
  saving.value = true;
  error.value = null;
  const common = { rule: rule.value, startsOn: startsOn.value, endsOn: endsOn.value || null, paused: paused.value, ...(horizonWeeks.value ? { horizonWeeks: horizonWeeks.value } : {}) };
  try {
    if (props.schedule) await $fetch(`/api/tournament-schedules/${props.schedule.id}`, { method: 'PATCH', body: common });
    else await $fetch('/api/tournament-schedules', { method: 'POST', body: { ...common, scaffoldId: scaffoldId.value } });
    toast.add({ color: 'success', title: `Saved: ${ruleText(rule.value)}` });
    await Promise.all([refreshUpcoming().catch(() => undefined), refreshRequiredEvents()]);
    emit('saved');
    open.value = false;
  } catch (err) {
    error.value = apiErrorMessage(err, 'Could not save the schedule.');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="schedule ? 'Edit schedule' : 'New schedule'" :ui="{ content: 'sm:max-w-2xl' }">
    <template #body>
      <form class="space-y-3" @submit.prevent="save">
        <UFormField v-if="!schedule" label="Scaffold">
          <USelect v-model="scaffoldId" :items="scaffolds.filter((s) => !s.archived).map((s) => ({ value: s.id, label: s.name }))" placeholder="Choose a scaffold" class="w-full" />
        </UFormField>
        <p v-else class="text-sm">Scaffold: {{ schedule.scaffoldName }}</p>
        <fieldset class="space-y-2">
          <legend class="text-sm font-medium">Repeats</legend>
          <USelect
            v-model="parts.kind"
            :items="[
              { value: 'weekly', label: 'Weekly' },
              { value: 'monthly_nth', label: 'Monthly, on a weekday' },
              { value: 'monthly_day', label: 'Monthly, on a day' },
              { value: 'quarterly', label: 'Quarterly' },
            ]"
            aria-label="Repeats"
            class="w-full"
          />
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <UFormField v-if="parts.kind === 'quarterly'" label="Month of the quarter">
              <USelect
                v-model="parts.month"
                :items="[
                  { value: 1, label: '1st' },
                  { value: 2, label: '2nd' },
                  { value: 3, label: '3rd' },
                ]"
                class="w-full"
              />
            </UFormField>
            <UFormField v-if="parts.kind === 'monthly_nth' || parts.kind === 'quarterly'" label="Which"><USelect v-model="parts.nth" :items="nths" class="w-full" /></UFormField>
            <UFormField v-if="parts.kind !== 'monthly_day'" label="Weekday"><USelect v-model="parts.weekday" :items="weekdays" class="w-full" /></UFormField>
            <UFormField v-if="parts.kind === 'weekly'" label="Every (weeks)"><UInputNumber v-model="parts.every" :min="1" :max="4" class="w-full" /></UFormField>
            <UFormField v-if="parts.kind === 'monthly_day'" label="Day of the month" help="A shorter month uses its last day">
              <UInputNumber v-model="parts.day" :min="1" :max="31" class="w-full" />
            </UFormField>
          </div>
          <p class="text-sm text-muted">{{ ruleText(rule) }}</p>
        </fieldset>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <UFormField label="Starts on"><UInput v-model="startsOn" type="date" class="w-full" /></UFormField>
          <UFormField label="Ends on" help="Optional"><UInput v-model="endsOn" type="date" class="w-full" /></UFormField>
          <UFormField label="Plan ahead (weeks)" help="Empty: 8 weekly, 13 monthly, 26 quarterly">
            <UInputNumber v-model="horizonWeeks" :min="1" :max="26" class="w-full" />
          </UFormField>
        </div>
        <USwitch v-model="paused" label="Paused" />

        <div class="space-y-1 text-sm">
          <h3 class="font-medium">Next dates</h3>
          <p v-if="previewError" class="text-error">{{ previewError }}</p>
          <ul v-else-if="preview" aria-label="Next dates" class="list-disc pl-5">
            <li v-for="d in preview.dates" :key="d.occurrenceDate">
              {{ dayLabel(d.occurrenceDate) }}
              <template v-if="d.slots.length"> — {{ d.slots.map((s) => `${dayLabel(s.localDate)} ${s.startTime}${s.timeProblem ? ' (clock change)' : ''}`).join(', ') }}</template>
            </li>
          </ul>
        </div>
        <p v-if="error" class="text-sm text-error">{{ error }}</p>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" @click="open = false">Cancel</UButton>
        <UButton :disabled="!schedule && !scaffoldId" :loading="saving" @click="save">Save schedule</UButton>
      </div>
    </template>
  </UModal>
</template>
