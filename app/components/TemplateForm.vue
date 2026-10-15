<script setup lang="ts">
import type { RegistrationSettings } from '../../server/modules/tournaments/settings';
import type { Template, TournamentOptions } from '../../server/modules/tournaments/service';
import { DETAILS_MAX_CHARS } from '#shared/schemas/tournaments';

/**
 * A tournament template (ADR-0010 decisions 2 and 10). Its choices (types for the date, formats, venues) are read live
 * from play-tools as the organizer; saving waits for them, except that an edited template keeps its saved choices.
 */
const props = defineProps<{
  template?: Template | null;
  timeZone: string;
  today: string;
  /** **Plan one…** with no matching template: the game, the series match and the date it is for. */
  prefill?: { product: 'tcg' | 'pgo' | 'vg'; seriesMatch: string; date: string } | null;
}>();
const emit = defineEmits<{ close: []; saved: [template: Template] }>();
const toast = useToast();

const open = ref(true);
const editing = computed(() => !!props.template);
const t = props.template;
const name = ref(t?.name ?? '');
const organizer = ref(t?.organizerPlayerId ?? '');
const product = ref<'tcg' | 'pgo' | 'vg'>(t?.product ?? props.prefill?.product ?? 'tcg');
const choicesDate = ref(props.prefill?.date ?? props.today);
const typeKey = ref(t?.type.kind === 'premier' ? `premier:${t.type.seriesMatch}` : props.prefill ? `premier:${props.prefill.seriesMatch}` : 'custom');
const category = ref(t?.category ?? '');
const venue = ref<Template['venue'] | null>(t?.venue ?? null);
const startTime = ref(t?.startTime ?? '18:00');
const registration = ref<RegistrationSettings | null>(t ? structuredClone(toRaw(t.registration)) : { kind: 'on_site', opensBeforeMin: 60, closesAfterMin: 15, admission: null });
const contactEmail = ref(t?.contactEmail ?? '');
const contactPhone = ref(t?.contactPhone ?? '');
const details = ref(t?.details ?? '');
const eventWebsite = ref(t?.eventWebsite ?? '');

const options = ref<TournamentOptions | null>(null);
const optionsError = ref<string | null>(null);
const loadingOptions = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);

const { data: connections } = await usePokemonConnection();
const organizers = computed(() =>
  (connections.value?.connections ?? [])
    .filter((c) => c.professorPlayerId)
    .map((c) => ({ value: c.professorPlayerId!, label: professorLabel(c), disabled: c.status !== 'connected', description: c.status !== 'connected' ? 'Reconnect in Settings' : undefined })),
);

watch(open, (o) => {
  if (!o) emit('close');
});

let optionsSeq = 0;
async function loadOptions() {
  if (!organizer.value) return;
  const seq = ++optionsSeq;
  loadingOptions.value = true;
  optionsError.value = null;
  options.value = null;
  try {
    const res = await $fetch<TournamentOptions>('/api/tournament-templates/options', { query: { professor: organizer.value, date: choicesDate.value } });
    // A slower answer for an earlier organizer or date never replaces the current one.
    if (seq === optionsSeq) options.value = res;
  } catch (err) {
    if (seq === optionsSeq) optionsError.value = apiErrorMessage(err, 'Could not read play-tools’ choices.');
  } finally {
    if (seq === optionsSeq) loadingOptions.value = false;
  }
}
watch([organizer, choicesDate], () => void loadOptions(), { immediate: true });

const typeChoices = computed(() => {
  const listed = options.value ? templateTypeChoices(options.value) : [{ label: 'Custom', value: { kind: 'custom' as const } }];
  const items = listed.map((c) => ({ key: c.value.kind === 'custom' ? 'custom' : `premier:${c.value.seriesMatch}`, label: c.label, product: c.product }));
  if (!items.some((i) => i.key === typeKey.value)) items.push({ key: typeKey.value, label: typeKey.value.replace(/^premier:/, ''), product: undefined });
  return items;
});
watch(typeKey, (key) => {
  const p = typeChoices.value.find((c) => c.key === key)?.product;
  if (p === 'tcg' || p === 'pgo' || p === 'vg') product.value = p;
});
const formats = computed(() => {
  const listed = options.value?.formats.find((f) => f.product === product.value)?.categories ?? [];
  return category.value && !listed.includes(category.value) ? [category.value, ...listed] : listed;
});
const venues = computed(() => venueChoices(options.value, editing.value ? (t?.venue ?? null) : null));
const venueId = computed({
  get: () => venue.value?.id,
  set: (id) => {
    const v = venues.value.find((x) => x.id === id);
    venue.value = v ? venueValue(v, props.timeZone) : null;
  },
});

const problem = computed(() =>
  templateFormProblem({
    name: name.value,
    organizerPlayerId: organizer.value,
    category: category.value,
    venue: venue.value,
    contactEmail: contactEmail.value,
    contactPhone: contactPhone.value,
    optionsLoaded: !!options.value,
    editing: editing.value,
  }),
);

function body() {
  return {
    name: name.value,
    organizerPlayerId: organizer.value,
    product: product.value,
    category: category.value,
    type: typeKey.value === 'custom' ? { kind: 'custom' } : { kind: 'premier', seriesMatch: typeKey.value.replace(/^premier:/, '') },
    venue: venue.value,
    startTime: startTime.value,
    registration: registration.value,
    contactEmail: blankToNull(contactEmail.value),
    contactPhone: blankToNull(contactPhone.value),
    details: blankToNull(details.value),
    eventWebsite: blankToNull(eventWebsite.value),
  };
}

async function save() {
  if (problem.value) return;
  saving.value = true;
  error.value = null;
  try {
    let saved: { template: Template };
    if (t) {
      const before: Record<string, unknown> = { ...t };
      const patch = Object.fromEntries(Object.entries(body()).filter(([k, v]) => JSON.stringify(v ?? '') !== JSON.stringify(before[k] ?? '')));
      saved = await $fetch<{ template: Template }>(`/api/tournament-templates/${t.id}`, { method: 'PATCH', body: patch });
    } else {
      saved = await $fetch<{ template: Template }>('/api/tournament-templates', { method: 'POST', body: body() });
    }
    toast.add({ color: 'success', title: `Saved ${saved.template.name}` });
    emit('saved', saved.template);
    open.value = false;
  } catch (err) {
    error.value = apiErrorMessage(err, 'Could not save the template.');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="editing ? 'Edit template' : 'New template'" :ui="{ content: 'sm:max-w-2xl' }">
    <template #body>
      <form class="space-y-3" @submit.prevent="save">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UFormField label="Name" help="{month}, {year} and {date} are filled in" class="sm:col-span-2">
            <UInput v-model="name" maxlength="80" class="w-full" />
          </UFormField>
          <UFormField label="Organizer">
            <USelect v-model="organizer" :items="organizers" placeholder="Choose a professor" aria-label="Organizer" class="w-full" />
          </UFormField>
          <UFormField label="Choices for date" help="Which series play-tools offers depends on the date">
            <UInput v-model="choicesDate" type="date" class="w-full" />
          </UFormField>
          <UFormField label="Game">
            <USelect
              v-model="product"
              :items="[
                { value: 'tcg', label: 'TCG' },
                { value: 'pgo', label: 'GO' },
                { value: 'vg', label: 'VGC' },
              ]"
              aria-label="Game"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Type">
            <USelect v-model="typeKey" :items="typeChoices.map((c) => ({ value: c.key, label: c.label }))" aria-label="Type" class="w-full" />
          </UFormField>
          <UFormField label="Format">
            <USelect v-model="category" :items="formats" placeholder="Choose a format" aria-label="Format" class="w-full" />
          </UFormField>
          <UFormField label="Venue">
            <USelect v-model="venueId" :items="venues.map((v) => ({ value: v.id, label: v.label }))" placeholder="Choose a venue" aria-label="Venue" class="w-full" />
          </UFormField>
          <UFormField label="Start time"><UInput v-model="startTime" type="time" class="w-full" /></UFormField>
          <RegistrationFields v-model="registration" class="sm:col-span-2" />
          <UFormField label="Contact email"><UInput v-model="contactEmail" type="email" class="w-full" /></UFormField>
          <UFormField label="Contact phone"><UInput v-model="contactPhone" type="tel" class="w-full" /></UFormField>
          <UFormField label="Event website" class="sm:col-span-2"><UInput v-model="eventWebsite" type="url" class="w-full" /></UFormField>
          <UFormField label="Details" class="sm:col-span-2"><UTextarea v-model="details" :rows="3" :maxlength="DETAILS_MAX_CHARS" class="w-full" /></UFormField>
        </div>
        <p v-if="loadingOptions" class="text-sm text-muted">Reading play-tools’ choices…</p>
        <UAlert v-if="optionsError" color="warning" variant="subtle" icon="i-lucide-circle-alert" :title="optionsError">
          <template #actions><UButton size="xs" variant="outline" @click="loadOptions">Try again</UButton></template>
        </UAlert>
        <p v-if="problem" class="text-sm text-muted">{{ problem }}</p>
        <p v-if="error" class="text-sm text-error">{{ error }}</p>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" @click="open = false">Cancel</UButton>
        <UButton :disabled="!!problem" :loading="saving" @click="save">Save template</UButton>
      </div>
    </template>
  </UModal>
</template>
