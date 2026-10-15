<script setup lang="ts">
import type { Requirement } from '../../server/modules/tournaments/requirements';
import type { Template, TournamentOptions } from '../../server/modules/tournaments/service';
import { DETAILS_MAX_CHARS } from '#shared/schemas/tournaments';

/**
 * **New tournament** (ADR-0010 decision 10): a one-off from a template and a date, up to 2 days back and 12 months
 * ahead. **Plan one…** opens it with the template and date chosen, or, with no matching template, offers to make one.
 * **Change from the template** (#162) changes any detail but the organizer and the game for this tournament only;
 * only what differs from the template is sent, so a later template edit still reaches the rest.
 */
const props = defineProps<{ today: string; timeZone: string; templateId?: number | null; date?: string; missingFor?: Requirement | null }>();
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

const template = computed(() => templates.value.find((t) => t.id === templateId.value) ?? null);
const base = computed(() => (template.value ? detailsFromTemplate(template.value) : null));
const form = ref<NewTournamentDetails | null>(null);
const changes = computed(() => (base.value && form.value ? newTournamentChanges(base.value, form.value) : { overrides: {}, count: 0 }));

/** An editable copy: the venue and registration are flat, so one level deep is a full copy. */
const detailsCopy = (d: NewTournamentDetails): NewTournamentDetails => ({ ...d, venue: { ...d.venue }, registration: { ...d.registration } });

const showDetails = ref(false);
const options = ref<TournamentOptions | null>(null);
const optionsError = ref<string | null>(null);
const loadingOptions = ref(false);
const typeNote = ref<string | null>(null);
/** A template chosen while details were changed waits here for **Discard changes**. */
const pendingTemplateId = ref<number | null>(null);

const { data: connections } = await usePokemonConnection();
const organizer = computed(() => {
  const id = template.value?.organizerPlayerId;
  const c = (connections.value?.connections ?? []).find((x) => x.professorPlayerId === id);
  return c ? professorLabel(c) : id ? `Professor ${id}` : '';
});

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

// A new template replaces every detail with its own.
watch(base, (b) => {
  form.value = b ? detailsCopy(b) : null;
  typeNote.value = null;
});

const templateChoice = computed({
  get: () => templateId.value,
  set: (id: number | undefined) => {
    if (id !== undefined && id !== templateId.value && changes.value.count > 0) pendingTemplateId.value = id;
    else templateId.value = id;
  },
});
function discardChanges() {
  templateId.value = pendingTemplateId.value ?? templateId.value;
  pendingTemplateId.value = null;
}

let optionsSeq = 0;
/** The template and date the current options (or their error) were read for: other choices never judge by them. */
let optionsKey = '';
async function loadOptions(again = false) {
  const t = template.value;
  const key = t ? `${t.id}|${date.value}` : '';
  if (key !== optionsKey) {
    // Another template or date: drop what was read for the last one, even while collapsed.
    ++optionsSeq;
    optionsKey = '';
    options.value = null;
    optionsError.value = null;
    loadingOptions.value = false;
  }
  if (!t || !showDetails.value) return;
  // Re-opening the details reads nothing new; only Try again does.
  if (key === optionsKey && !again) return;
  optionsKey = key;
  const seq = ++optionsSeq;
  loadingOptions.value = true;
  optionsError.value = null;
  options.value = null;
  try {
    const res = await $fetch<TournamentOptions>('/api/tournament-templates/options', { query: { professor: t.organizerPlayerId, date: date.value, country: t.venue.country } });
    // A slower answer for an earlier template or date never replaces the current one.
    if (seq === optionsSeq) options.value = res;
  } catch (err) {
    if (seq === optionsSeq) optionsError.value = apiErrorMessage(err, 'Could not read play-tools’ choices.');
  } finally {
    if (seq === optionsSeq) loadingOptions.value = false;
  }
}
// Read only once the details are opened, then again only for another template or date.
watch([templateId, date, showDetails], () => void loadOptions());

const typeChoices = computed(() => (template.value ? newTournamentTypeChoices(template.value, options.value, date.value) : []));
const formatChoices = computed(() =>
  template.value && form.value ? newTournamentFormats(template.value, form.value.typeKey, options.value, date.value) : { formats: [], note: null },
);
// A format the type no longer offers is cleared, so it can't be planned without a format.
watch(formatChoices, ({ formats }) => {
  if (form.value && form.value.category && options.value && !formats.includes(form.value.category)) form.value.category = '';
});
// A series whose window no longer holds the date goes back to the template's type.
watch([date, options], () => {
  const f = form.value;
  if (!f || !options.value || typeStillOffered(f.typeKey, options.value, date.value)) return;
  const picked = options.value.types.find((x) => x.kind === 'premier' && x.seriesId === f.typeKey);
  const name = picked?.kind === 'premier' ? picked.name : 'That series';
  typeNote.value = `${name} isn’t offered on ${dayLabel(date.value)}; type reset to the template’s.`;
  f.typeKey = AS_TEMPLATE;
});

const venues = computed(() => venueChoices(options.value, base.value?.venue ?? null));
const venueId = computed({
  get: () => form.value?.venue.id,
  set: (id) => {
    const v = venues.value.find((x) => x.id === id);
    if (v && form.value) form.value.venue = id === base.value?.venue.id ? { ...base.value!.venue } : venueValue(v, props.timeZone);
  },
});

function resetToTemplate() {
  if (base.value) form.value = detailsCopy(base.value);
  typeNote.value = null;
}

const problem = computed(() => {
  if (!form.value) return null;
  if (!form.value.name.trim()) return 'Name the tournament.';
  if (!form.value.category) return 'Choose a format.';
  if (!blankToNull(form.value.contactEmail) && !blankToNull(form.value.contactPhone)) return 'Give a contact email or phone.';
  return null;
});

async function save() {
  if (!templateId.value || problem.value) return;
  saving.value = true;
  error.value = null;
  const { overrides, seriesId, count } = changes.value;
  try {
    await $fetch('/api/planned-tournaments', {
      method: 'POST',
      body: {
        templateId: templateId.value,
        localDate: date.value,
        ...(startTime.value ? { startTime: startTime.value } : {}),
        ...(count > 0 && Object.keys(overrides).length > 0 ? { overrides } : {}),
        ...(seriesId ? { seriesId } : {}),
      },
    });
    await Promise.all([refreshUpcoming(), refreshRequiredEvents()]);
    toast.add({ color: 'success', title: `Planned for ${dayLabel(date.value)}` });
    open.value = false;
  } catch (err) {
    error.value = plannedErrorText(apiErrorCode(err), template.value?.name) ?? apiErrorMessage(err, 'Could not plan the tournament.');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="New tournament"
    description="A one-off from a template. Nothing goes to play-tools until you create it."
    :ui="{ content: showDetails ? 'sm:max-w-2xl' : undefined }"
  >
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
          <USelect v-model="templateChoice" :items="templates.map((t) => ({ value: t.id, label: t.name }))" placeholder="Choose a template" aria-label="Template" class="w-full" />
        </UFormField>
        <UAlert v-if="pendingTemplateId !== null" color="warning" variant="subtle" icon="i-lucide-triangle-alert" title="Discard your changes to the details?">
          <template #actions>
            <UButton size="xs" variant="ghost" color="neutral" @click="pendingTemplateId = null">Keep them</UButton>
            <UButton size="xs" color="warning" @click="discardChanges">Discard changes</UButton>
          </template>
        </UAlert>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UFormField label="Date" required :help="`From ${dayLabel(min)} (2 days back) to 12 months ahead`">
            <UInput v-model="date" type="date" :min="min" :max="max" class="w-full" />
          </UFormField>
          <UFormField label="Start time" help="Leave empty for the template's">
            <UInput v-model="startTime" type="time" class="w-full" />
          </UFormField>
        </div>
        <p v-if="isShortNotice(date, today)" class="text-sm text-warning">Short notice: less than 7 days before it is held. You'll be asked to confirm when you create it.</p>

        <template v-if="template && form">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <UButton
              variant="link"
              color="neutral"
              class="px-0"
              :icon="showDetails ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
              :aria-expanded="showDetails"
              aria-controls="new-tournament-details"
              @click="showDetails = !showDetails"
            >
              Change from the template
            </UButton>
            <span v-if="changes.count > 0" class="flex items-center gap-2 text-sm text-muted">
              {{ changes.count === 1 ? '1 detail differs' : `${changes.count} details differ` }} from the template
              <UButton size="xs" variant="outline" color="neutral" @click="resetToTemplate">Reset to template</UButton>
            </span>
          </div>

          <div v-show="showDetails" id="new-tournament-details" class="space-y-3">
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <UFormField label="Organizer" help="Use another template to change these">
                <UInput :model-value="organizer" disabled aria-label="Organizer" class="w-full" />
              </UFormField>
              <UFormField label="Game">
                <UInput :model-value="GAME[template.product]" disabled aria-label="Game" class="w-full" />
              </UFormField>
              <UFormField label="Name" help="{month}, {year} and {date} are filled in" class="sm:col-span-2">
                <UInput v-model="form.name" maxlength="80" aria-label="Name" class="w-full" />
              </UFormField>
              <UFormField label="Type">
                <USelect v-model="form.typeKey" :items="typeChoices" aria-label="Type" class="w-full" />
              </UFormField>
              <UFormField label="Format">
                <USelect v-model="form.category" :items="formatChoices.formats" placeholder="Choose a format" aria-label="Format" class="w-full" />
              </UFormField>
              <UFormField label="Venue" class="sm:col-span-2">
                <USelect v-model="venueId" :items="venues.map((v) => ({ value: v.id, label: v.label }))" aria-label="Venue" class="w-full" />
              </UFormField>
              <RegistrationFields v-model="form.registration" class="sm:col-span-2" />
              <UFormField label="Contact email"><UInput v-model="form.contactEmail" type="email" aria-label="Contact email" class="w-full" /></UFormField>
              <UFormField label="Contact phone"><UInput v-model="form.contactPhone" type="tel" aria-label="Contact phone" class="w-full" /></UFormField>
              <UFormField label="Event website" class="sm:col-span-2"><UInput v-model="form.eventWebsite" type="url" aria-label="Event website" class="w-full" /></UFormField>
              <UFormField label="Details" class="sm:col-span-2">
                <UTextarea v-model="form.details" :rows="3" :maxlength="DETAILS_MAX_CHARS" aria-label="Details" class="w-full" />
              </UFormField>
            </div>
            <p v-if="typeNote" class="text-sm text-warning">{{ typeNote }}</p>
            <p v-if="formatChoices.note" class="text-sm text-muted">{{ formatChoices.note }}</p>
            <p v-if="loadingOptions" class="text-sm text-muted">Reading play-tools’ choices…</p>
            <UAlert v-if="optionsError" color="warning" variant="subtle" icon="i-lucide-circle-alert" :title="optionsError">
              <template #actions><UButton size="xs" variant="outline" @click="loadOptions(true)">Try again</UButton></template>
            </UAlert>
          </div>
          <p v-if="problem" class="text-sm text-muted">{{ problem }}</p>
        </template>
        <p v-if="error" class="text-sm text-error">{{ error }}</p>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" @click="open = false">Cancel</UButton>
        <UButton :disabled="!templateId || !date || !!problem || pendingTemplateId !== null" :loading="saving" @click="save">Plan tournament</UButton>
      </div>
    </template>
  </UModal>
</template>
