<script setup lang="ts">
import type { PeriodCoverage } from '../../shared/requirements/coverage';
import type { Requirement } from '../../server/modules/tournaments/requirements';
import type { Template, Upcoming } from '../../server/modules/tournaments/service';

/**
 * Tournaments (ADR-0010 decision 10, architecture §8, #98): Required events on top, then Upcoming, Templates and
 * Schedules. Every dialog that reaches play-tools lists what it changes and waits for its confirm.
 */
useHead({ title: 'Tournaments' });

const route = useRoute();
const router = useRouter();
const toast = useToast();

const { data: coverage, error: coverageError } = await useRequiredEvents();
// The league's time zone and date: coverage's, else Upcoming's, never the browser's own (a venue saved with a
// missing zone takes the league's, and short notice counts from the league's date).
const upcoming = useNuxtData<Upcoming>(UPCOMING_KEY).data;
const zoneFromUpcoming = ref<string | null>(null);
watch(
  coverageError,
  async (err) => {
    if (!err || upcoming.value) return;
    zoneFromUpcoming.value = (await $fetch<Upcoming>('/api/tournaments/upcoming').catch(() => null))?.timeZone ?? null;
  },
  { immediate: true },
);
const timeZone = computed(() => coverage.value?.timeZone ?? upcoming.value?.timeZone ?? zoneFromUpcoming.value);
const today = computed(() => coverage.value?.today ?? (timeZone.value ? todayIn(timeZone.value, new Date()) : null));

const TABS = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'templates', label: 'Templates' },
  { value: 'schedules', label: 'Schedules' },
];
const tab = computed({
  get: () => tabFromQuery(route.query.tab),
  set: (value: string) => void router.replace({ query: { ...route.query, tab: value === 'upcoming' ? undefined : value } }),
});

// Dialogs
const creating = ref<{ plannedIds: number[]; retry: boolean } | null>(null);
const editing = ref<string | null>(null);
const cancelling = ref<string | null>(null);
const planning = ref<{ templateId: number | null; date?: string; missingFor: Requirement | null } | null>(null);
const newTemplateFor = ref<{ requirement: Requirement; date: string } | null>(null);

async function planOne(requirement: Requirement, period: PeriodCoverage) {
  if (!today.value) return;
  try {
    const { templates } = await $fetch<{ templates: Template[] }>('/api/tournament-templates');
    const defaults = planOneDefaults(requirement, period, templates, today.value!);
    if (!defaults) return;
    planning.value = { templateId: defaults.template?.id ?? null, date: defaults.date, missingFor: defaults.template ? null : requirement };
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not read the templates.') });
  }
}

function templateSaved(t: Template) {
  // Plan one… continues with the template just made.
  if (planning.value) planning.value = { ...planning.value, templateId: t.id, missingFor: null };
}
</script>

<template>
  <div class="space-y-8">
    <div>
      <h1 class="text-2xl font-semibold">Tournaments</h1>
      <p class="text-sm text-muted">Plan the league's tournaments, create them in play-tools, and never miss a League Cup or League Challenge.</p>
    </div>

    <RequiredEventsGrid @plan="planOne" @create="(id) => (creating = { plannedIds: [id], retry: false })" />

    <p v-if="!today || !timeZone" class="text-sm text-muted">Reading the league's time zone…</p>
    <template v-else>
    <div class="space-y-4">
      <UTabs v-model="tab" :items="TABS" :content="false" class="w-full" />
      <UpcomingList
        v-if="tab === 'upcoming'"
        :today="today"
        @new="planning = { templateId: null, missingFor: null }"
        @create="(ids) => (creating = { plannedIds: ids, retry: false })"
        @retry="(id) => (creating = { plannedIds: [id], retry: true })"
        @edit="(id) => (editing = id)"
        @cancel="(id) => (cancelling = id)"
      />
      <TemplatesTab v-else-if="tab === 'templates'" :time-zone="timeZone" :today="today" />
      <SchedulesTab v-else :today="today" />
    </div>

    <NewTournamentDialog
      v-if="planning"
      :key="`${planning.templateId}-${planning.date}`"
      :today="today"
      :template-id="planning.templateId"
      :date="planning.date"
      :missing-for="planning.missingFor"
      @new-template="(requirement, date) => (newTemplateFor = { requirement, date })"
      @close="planning = null"
    />
    <TemplateForm
      v-if="newTemplateFor"
      :time-zone="timeZone"
      :today="today"
      :prefill="{ product: newTemplateFor.requirement.product, seriesMatch: newTemplateFor.requirement.seriesMatch, date: newTemplateFor.date }"
      @saved="templateSaved"
      @close="newTemplateFor = null"
    />
    <CreateTournamentsDialog v-if="creating" :planned-ids="creating.plannedIds" :retry="creating.retry" :today="today" @close="creating = null" />
    <EditTournamentDialog v-if="editing" :id="editing" :time-zone="timeZone" @close="editing = null" />
    <CancelTournamentDialog v-if="cancelling" :id="cancelling" @close="cancelling = null" />
    </template>
  </div>
</template>
