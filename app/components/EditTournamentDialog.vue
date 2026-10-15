<script setup lang="ts">
import type { SubmissionView } from '../../server/modules/submission/service';
import type { CarriedField, EditValues } from '../../server/modules/tournaments/edit';
import type { EditForm, EditPreview, PreviewEntry } from '../../server/modules/tournaments/editing';
import type { TournamentOptions } from '../../server/modules/tournaments/service';

/**
 * **Edit…** (ADR-0010 decision 11): any field, rescheduling included, optionally across the schedule. Only the
 * changed fields are sent; a preview lists every tournament with before → after, and nothing changes until **Save**.
 */
const props = defineProps<{ id: string; timeZone: string }>();
const emit = defineEmits<{ close: [] }>();
const toast = useToast();

type Scope = 'this' | 'later' | 'all';
const open = ref(true);
const form = ref<EditForm | null>(null);
const values = ref<EditValues | null>(null);
const options = ref<TournamentOptions | null>(null);
const optionsError = ref<string | null>(null);
const loadError = ref<string | null>(null);
const scope = ref<Scope>('this');
const manualTicks = ref<Partial<Record<CarriedField, boolean>>>({});
const withSiblings = ref(false);
const updateTemplate = ref(false);
const clearShadowing = ref(false);
const preview = ref<EditPreview | null>(null);
const kept = ref<Set<string>>(new Set());
const busy = ref(false);
const error = ref<string | null>(null);
const submissionId = ref<number | null>(null);
const finished = ref(false);

watch(open, (o) => {
  if (!o) emit('close');
});

onMounted(async () => {
  try {
    form.value = await $fetch<EditForm>(`/api/tournaments/${props.id}/edit`);
    values.value = structuredClone(toRaw(form.value.values));
  } catch (err) {
    loadError.value = apiErrorMessage(err, 'Could not read the tournament.');
    return;
  }
  try {
    options.value = await $fetch<TournamentOptions>('/api/tournament-templates/options', {
      query: { professor: form.value.readOnly.organizer.playerId, date: form.value.values.localDate },
    });
  } catch (err) {
    optionsError.value = apiErrorMessage(err, 'Could not read play-tools’ choices; the current format and venue stay.');
  }
});

const changes = computed(() => (form.value && values.value ? changedValues(form.value.values, values.value) : {}));
const changedFields = computed(() => Object.keys(changes.value) as (keyof EditValues)[]);
const carriable = computed(() => changedFields.value.filter((f): f is CarriedField => f !== 'localDate'));
const ticked = (f: CarriedField) => manualTicks.value[f] ?? defaultTicks([f]).includes(f);
const formats = computed(() => {
  const product = form.value?.readOnly.product;
  const listed = options.value?.formats.find((f) => f.product === product)?.categories ?? [];
  const current = form.value?.values.category;
  return current && !listed.includes(current) ? [current, ...listed] : listed;
});
const venues = computed(() => venueChoices(options.value, form.value ? { ...form.value.values.venue, id: form.value.values.venue.id ?? '', label: form.value.values.venue.label ?? '' } : null));
const venueId = computed({
  get: () => values.value?.venue.id ?? undefined,
  set: (id) => {
    const v = venues.value.find((x) => x.id === id);
    if (v && values.value) values.value.venue = venueValue(v, props.timeZone);
  },
});
const rescheduleNote = computed(() => {
  const r = form.value?.reschedule;
  if (!r || !changedFields.value.includes('localDate') || r.open) return null;
  return today() < r.opensOn
    ? `This tournament can be moved from ${dayLabel(r.opensOn)} (3 days before its start). To move it sooner, cancel it and make a new tournament.`
    : 'play-tools no longer lets this tournament be moved (90 days after its start).';
});
const allEntries = computed<PreviewEntry[]>(() => (preview.value ? [...preview.value.inPlayTools, ...preview.value.planned] : []));
const WARNING: Record<string, string> = {
  another_planned_at_time: 'Another tournament is planned at that time.',
  may_need_approval: 'play-tools may send it back for approval.',
  series_window_unknown: 'The series window couldn’t be read.',
};

function today() {
  return todayIn(props.timeZone, new Date());
}

function body() {
  return {
    changes: changes.value,
    scope: scope.value,
    ...(scope.value === 'this' ? {} : { fields: carriable.value.filter(ticked) }),
    withSiblings: scope.value !== 'this' && withSiblings.value,
    updateTemplate: updateTemplate.value,
  };
}

async function showPreview() {
  busy.value = true;
  error.value = null;
  try {
    preview.value = await $fetch<EditPreview>(`/api/tournaments/${props.id}/edit/preview`, { method: 'POST', body: body() });
    kept.value = new Set(allEntries.value.map((e) => e.key));
  } catch (err) {
    error.value = editError(err);
  } finally {
    busy.value = false;
  }
}

function editError(err: unknown): string {
  if (apiErrorCode(err) === 'reschedule_window_not_open') {
    const opensOn = (err as { data?: { data?: { opensOn?: string } } }).data?.data?.opensOn;
    return `This tournament can be moved from ${opensOn ? dayLabel(opensOn) : '3 days before its start'}. To move it sooner, cancel it and make a new tournament.`;
  }
  return apiErrorMessage(err, 'Could not edit the tournament.');
}

function keep(key: string, on: boolean | 'indeterminate') {
  const next = new Set(kept.value);
  if (on === true) next.add(key);
  else next.delete(key);
  kept.value = next;
}

async function save() {
  if (!preview.value) return;
  busy.value = true;
  error.value = null;
  try {
    const res = await $fetch<{ submissionId: number | null; updatedLocally: number }>(`/api/tournaments/${props.id}/edit`, {
      method: 'POST',
      body: {
        ...body(),
        excluded: excludedKeys(allEntries.value, kept.value),
        acknowledgeShortNotice: preview.value.shortNotice,
        clearShadowingOverrides: clearShadowing.value,
      },
    });
    if (res.submissionId !== null) {
      submissionId.value = res.submissionId;
    } else {
      toast.add({ color: 'success', title: `Updated ${res.updatedLocally} planned tournament${res.updatedLocally === 1 ? '' : 's'}` });
      await Promise.all([refreshUpcoming(), refreshRequiredEvents()]);
      open.value = false;
    }
  } catch (err) {
    error.value = editError(err);
  } finally {
    busy.value = false;
  }
}

async function done(view: SubmissionView) {
  finished.value = true;
  const { label, color } = submissionStatus(view.status, view.kind);
  toast.add({ color: color === 'info' ? 'neutral' : color, title: `${view.playSessionLabel}: ${label}` });
  await Promise.all([refreshUpcoming(), refreshRequiredEvents()]);
}
</script>

<template>
  <UModal v-model:open="open" title="Edit tournament" :dismissible="!submissionId || finished" :ui="{ content: 'sm:max-w-2xl' }">
    <template #body>
      <TournamentJobProgress v-if="submissionId" :submission-id="submissionId" @finished="done" />
      <UAlert v-else-if="loadError" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="loadError" />
      <p v-else-if="!form || !values" class="text-sm text-muted">Reading the tournament…</p>
      <UAlert
        v-else-if="!form.editable"
        color="warning"
        variant="subtle"
        icon="i-lucide-lock"
        :title="form.lockedReason === 'tournament_locked' ? 'play-tools no longer lets this tournament be changed.' : 'This tournament can’t be edited.'"
      />

      <!-- The preview: every tournament with before → after; untick any to leave it out. -->
      <div v-else-if="preview" class="space-y-4 text-sm">
        <UAlert v-for="w in preview.warnings" :key="w" color="warning" variant="subtle" icon="i-lucide-triangle-alert" :title="WARNING[w] ?? w" />
        <UAlert
          v-if="preview.shortNotice"
          color="warning"
          variant="subtle"
          icon="i-lucide-clock"
          title="Short notice"
          description="less than 7 days before it is held; the league is expected to sanction 7 days ahead."
        />
        <template v-for="group in [{ title: 'In play-tools (will be edited)', entries: preview.inPlayTools }, { title: 'Planned (updated here)', entries: preview.planned }]" :key="group.title">
          <div v-if="group.entries.length" class="space-y-1">
            <h3 :id="`group-${group.title}`" class="font-medium">{{ group.title }}</h3>
            <ul :aria-label="group.title" class="space-y-2">
              <li v-for="e in group.entries" :key="e.key" class="flex items-start gap-2 rounded border border-default p-2">
                <UCheckbox :model-value="kept.has(e.key)" :aria-label="`Include ${e.name} · ${dayLabel(e.localDate)}`" @update:model-value="keep(e.key, $event)" />
                <div class="min-w-0 space-y-0.5">
                  <p class="font-medium break-words">{{ e.name }} · {{ dayLabel(e.localDate) }}<template v-if="e.displayId"> · {{ e.displayId }}</template></p>
                  <p v-for="c in e.changes" :key="c.field" class="text-muted break-words">
                    {{ FIELD_LABEL[c.field] }}: {{ valueText(c.field, c.before) }} → {{ valueText(c.field, c.after) }}
                  </p>
                </div>
              </li>
            </ul>
          </div>
        </template>
        <div v-if="preview.leftOut.length" class="space-y-1">
          <h3 class="font-medium">Left out</h3>
          <ul aria-label="Left out" class="list-disc pl-5 text-muted">
            <li v-for="l in preview.leftOut" :key="l.entry.key">{{ l.entry.name }} · {{ dayLabel(l.entry.localDate) }}: {{ l.reason.replaceAll('_', ' ') }}</li>
          </ul>
        </div>
        <div v-if="preview.template?.shadowedBy.length" class="space-y-1">
          <p>These keep their own settings for the changed fields, which win over the template:</p>
          <ul class="list-disc pl-5 text-muted">
            <li v-for="(s, i) in preview.template.shadowedBy" :key="i">
              {{ s.source === 'schedule' ? 'Schedule' : 'Planned tournaments' }} from {{ dayLabel(s.from) }}{{ s.to ? ` to ${dayLabel(s.to)}` : ' on' }}: {{ s.fields.map((f) => FIELD_LABEL[f]).join(', ') }}
            </li>
          </ul>
          <UCheckbox v-model="clearShadowing" label="Also clear these overrides" />
        </div>
        <p v-if="error" class="text-error">{{ error }}</p>
      </div>

      <!-- The form -->
      <form v-else class="space-y-3" @submit.prevent="showPreview">
        <dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
          <dt class="text-muted">League</dt>
          <dd>{{ form.readOnly.league.displayId ?? '—' }}</dd>
          <dt class="text-muted">Organizer</dt>
          <dd>{{ professorName(form.readOnly.organizer) }}</dd>
          <dt class="text-muted">Game</dt>
          <dd>{{ GAME[form.readOnly.product as 'tcg'] ?? form.readOnly.product ?? '—' }}</dd>
          <dt class="text-muted">Type</dt>
          <dd>{{ form.readOnly.type.kind === 'custom' ? 'Custom' : (form.readOnly.type.name ?? 'Premier') }}</dd>
        </dl>
        <p v-if="optionsError" class="text-sm text-warning">{{ optionsError }}</p>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UFormField label="Name" class="sm:col-span-2"><UInput v-model="values.name" maxlength="80" class="w-full" /></UFormField>
          <UFormField label="Format"><USelect :model-value="values.category ?? undefined" :items="formats" aria-label="Format" class="w-full" @update:model-value="values.category = $event" /></UFormField>
          <UFormField label="Venue"><USelect v-model="venueId" :items="venues.map((v) => ({ value: v.id, label: v.label }))" aria-label="Venue" class="w-full" /></UFormField>
          <UFormField label="Date"><UInput v-model="values.localDate" type="date" class="w-full" /></UFormField>
          <UFormField label="Start time"><UInput v-model="values.startTime" type="time" class="w-full" /></UFormField>
          <RegistrationFields v-model="values.registration" class="sm:col-span-2" />
          <UFormField label="Contact email">
            <UInput :model-value="values.contactEmail ?? ''" type="email" class="w-full" @update:model-value="values.contactEmail = String($event)" />
          </UFormField>
          <UFormField label="Contact phone">
            <UInput :model-value="values.contactPhone ?? ''" type="tel" class="w-full" @update:model-value="values.contactPhone = String($event)" />
          </UFormField>
          <UFormField label="Event website" class="sm:col-span-2">
            <UInput :model-value="values.eventWebsite ?? ''" type="url" class="w-full" @update:model-value="values.eventWebsite = String($event)" />
          </UFormField>
          <UFormField label="Details" class="sm:col-span-2">
            <UTextarea :model-value="values.details ?? ''" :rows="3" maxlength="2000" class="w-full" @update:model-value="values.details = String($event)" />
          </UFormField>
        </div>
        <p v-if="rescheduleNote" class="text-sm text-warning">{{ rescheduleNote }}</p>

        <fieldset v-if="form.schedule" class="space-y-2 text-sm">
          <legend class="font-medium">Apply to</legend>
          <URadioGroup
            v-model="scope"
            :items="[
              { value: 'this', label: 'This tournament only' },
              { value: 'later', label: 'This and later tournaments in the schedule' },
              { value: 'all', label: 'All tournaments in the schedule' },
            ]"
          />
          <template v-if="scope !== 'this'">
            <div v-if="carriable.length" class="space-y-1">
              <p class="text-muted">Carry over to the others (the date never does):</p>
              <UCheckbox
                v-for="f in carriable"
                :key="f"
                :model-value="ticked(f)"
                :label="FIELD_LABEL[f]"
                :aria-label="`Carry over ${FIELD_LABEL[f]}`"
                @update:model-value="manualTicks = { ...manualTicks, [f]: $event === true }"
              />
            </div>
            <UCheckbox v-if="form.schedule.siblings > 0" v-model="withSiblings" label="Also the tournaments held with it" />
          </template>
          <UCheckbox v-if="form.templateId !== null" v-model="updateTemplate" label="Update the template" />
        </fieldset>
        <p v-if="error" class="text-sm text-error">{{ error }}</p>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton v-if="preview && !submissionId" variant="ghost" color="neutral" @click="preview = null">Back</UButton>
        <UButton variant="ghost" color="neutral" @click="open = false">{{ submissionId ? 'Close' : 'Cancel' }}</UButton>
        <template v-if="!submissionId && form?.editable">
          <UButton v-if="!preview" :disabled="changedFields.length === 0" :loading="busy" :title="changedFields.length === 0 ? 'Nothing changed' : undefined" @click="showPreview">
            Preview
          </UButton>
          <UButton v-else :color="preview.shortNotice ? 'warning' : 'primary'" :disabled="kept.size === 0" :loading="busy" @click="save">
            {{ preview.shortNotice ? 'Save anyway' : 'Save' }}
          </UButton>
        </template>
      </div>
    </template>
  </UModal>
</template>
