<script setup lang="ts">
import type { PeriodCoverage } from '../../shared/requirements/coverage';
import type { Requirement } from '../../server/modules/tournaments/requirements';
import type { Template } from '../../server/modules/tournaments/service';

/**
 * Tournaments (ADR-0010 decisions 10 and 12, architecture §8, #98, #162): tabs Upcoming, Required events, Templates
 * and Schedules. Required events keeps its grid to its own tab, with the nav badge's count; the other tabs show the
 * compact banner above, so nothing at risk is hidden. Every dialog that reaches play-tools lists what it changes and
 * waits for its confirm.
 */
useHead({ title: 'Tournaments' });

const route = useRoute();
const router = useRouter();
const toast = useToast();

// Every read starts now, together, and none blocks the page: each part shows what it is waiting for (#191). The
// league's zone and date come from settings, which never waits on play-tools, never from the browser.
const { data: coverage, error: coverageError } = useRequiredEvents();
const { data: clock, error: clockError, refresh: refreshClock } = useLeagueClock();
useUpcoming();
useTournamentTemplates();
useAllTournamentTemplates();
useTournamentScaffolds();
useTournamentSchedules();
const timeZone = computed(() => clock.value?.league.timeZone ?? null);
const today = computed(() => clock.value?.league.today ?? null);
const clockFailed = computed(() => !!clockError.value && !clock.value);

const tabs = computed(() => tournamentsTabs(badgeCount(coverage.value)));
const tab = computed({
  get: () => tabFromQuery(route.query.tab),
  set: (value: string) => void router.replace({ query: tabQuery(route.query, tabFromQuery(value)) as Record<string, string> }),
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

    <RequiredEventsBanner v-if="tab !== 'required'" progress :failed="!!coverageError" />
    <div class="space-y-4">
      <UTabs v-model="tab" :items="tabs" :content="false" class="w-full">
        <template #default="{ item }">
          <span aria-hidden="true">{{ item.label }}</span><span class="sr-only">{{ item.ariaLabel ?? item.label }}</span>
        </template>
        <template #trailing="{ item }">
          <UBadge v-if="item.badge" :label="item.badge" color="warning" variant="subtle" size="sm" aria-hidden="true" />
        </template>
      </UTabs>
      <RequiredEventsGrid v-if="tab === 'required'" :plan-ready="!!today" @plan="planOne" @create="(id) => (creating = { plannedIds: [id], retry: false })" />
      <UpcomingList
        v-else-if="tab === 'upcoming'"
        :today="today"
        :clock-failed="clockFailed"
        @retry-clock="refreshClock()"
        @new="planning = { templateId: null, missingFor: null }"
        @create="(ids) => (creating = { plannedIds: ids, retry: false })"
        @retry="(id) => (creating = { plannedIds: [id], retry: true })"
        @edit="(id) => (editing = id)"
        @cancel="(id) => (cancelling = id)"
      />
      <TemplatesTab v-else-if="tab === 'templates'" :time-zone="timeZone" :today="today" :clock-failed="clockFailed" />
      <SchedulesTab v-else :today="today" :clock-failed="clockFailed" />
    </div>

    <template v-if="today && timeZone">
    <NewTournamentDialog
      v-if="planning"
      :key="`${planning.templateId}-${planning.date}`"
      :today="today"
      :time-zone="timeZone"
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
