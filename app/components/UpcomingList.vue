<script setup lang="ts">
import type { UpcomingEntry } from '../../server/modules/tournaments/service';

/**
 * Upcoming (ADR-0010 decision 10): planned and play-tools tournaments by date, from 2 days ago. Skip, Unskip, a series
 * pick and Download TDF happen here; the dialogs that reach play-tools are the page's. Its buttons show before its
 * read or the league's clock (`today`) answers; rows wait for both (#191).
 */
const props = defineProps<{ today: string | null; clockFailed?: boolean }>();
const emit = defineEmits<{ create: [plannedIds: number[]]; retry: [plannedId: number]; edit: [id: string]; cancel: [id: string]; new: []; retryClock: [] }>();
const toast = useToast();

const { data: upcoming, error } = useUpcoming();
// Rows whose organizer another user holds offer only Download TDF, saying who may change them (ADR-0015 §4).
const { data: connections } = usePokemonConnection();
const actionsOf = (e: UpcomingEntry) => rowActions(e, onlyText(connections.value, e.organizer?.playerId));
// A play-tools tournament the viewer organizes can be lent (ADR-0015 §5); its lease is added after the listing cache.
const leaseOf = (e: UpcomingEntry) => (e as WithLease<UpcomingEntry>).lease ?? null;
const canLend = (e: UpcomingEntry) => !!e.tournamentId && e.state !== 'cancelled' && e.state !== 'skipped';
const lendable = computed(() =>
  (upcoming.value?.tournaments ?? [])
    .filter((e) => canLend(e) && !leaseOf(e) && connections.value?.connections.some((c) => c.mine && c.professorPlayerId === e.organizer?.playerId))
    .map((e) => ({ tournamentId: e.tournamentId!, label: name(e), startsAt: e.startsAt })),
);
const clockPending = computed(() => !props.today && !props.clockFailed);
const loading = computed(() => (!upcoming.value && !error.value) || clockPending.value);
const selected = ref<Set<number>>(new Set());
const refreshing = ref(false);
const busy = ref<string | null>(null);

const groups = computed(() => groupByDate(upcoming.value?.tournaments ?? []));
const notice = computed(() => (upcoming.value ? upcomingNotice(upcoming.value) : { settingsNote: null, warnings: [] }));
const name = (e: UpcomingEntry) => `${e.name} · ${dayLabel(e.localDate)}`;
const keyOf = (e: UpcomingEntry) => (e.plannedId !== null ? `p:${e.plannedId}` : `t:${e.tournamentId}`);
const idOf = (e: UpcomingEntry) => String(e.plannedId ?? e.tournamentId);

// A refresh can take `create` away (the row is being created): it leaves the selection.
watch(upcoming, (u) => {
  const creatable = new Set((u?.tournaments ?? []).filter((e) => actionsOf(e).actions.includes('create')).map((e) => e.plannedId!));
  selected.value = new Set([...selected.value].filter((id) => creatable.has(id)));
});

function toggle(e: UpcomingEntry, on: boolean | 'indeterminate') {
  const next = new Set(selected.value);
  if (on === true) next.add(e.plannedId!);
  else next.delete(e.plannedId!);
  selected.value = next;
}

async function refresh() {
  refreshing.value = true;
  try {
    await refreshUpcoming({ upstream: true });
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not read Upcoming.') });
  } finally {
    refreshing.value = false;
  }
}

async function patchPlanned(e: UpcomingEntry, body: Record<string, unknown>, done: string) {
  busy.value = keyOf(e);
  try {
    await $fetch(`/api/planned-tournaments/${e.plannedId}`, { method: 'PATCH', body });
    await Promise.all([refreshUpcoming(), refreshRequiredEvents()]);
    toast.add({ color: 'success', title: done });
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not change the tournament.') });
  } finally {
    busy.value = null;
  }
}

const downloadTdf = useTdfDownload();
async function download(e: UpcomingEntry) {
  busy.value = keyOf(e);
  try {
    await downloadTdf(e.tournamentId!, e.displayId);
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <section aria-label="Upcoming" :aria-busy="loading" class="space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-sm text-muted">From 2 days ago. play-tools is read at most every 5 minutes; Refresh reads it now.</p>
      <div class="flex flex-wrap gap-2">
        <UButton
          v-if="selected.size > 0"
          size="sm"
          icon="i-lucide-send"
          :disabled="selected.size > MAX_CREATE"
          :title="selected.size > MAX_CREATE ? `At most ${MAX_CREATE} at a time` : undefined"
          @click="emit('create', [...selected])"
        >
          Create {{ selected.size }} in play-tools
        </UButton>
        <UButton size="sm" variant="outline" icon="i-lucide-plus" :loading="clockPending" :disabled="!props.today" @click="emit('new')">New tournament</UButton>
        <UButton size="sm" variant="outline" icon="i-lucide-refresh-cw" :loading="refreshing" aria-label="Refresh upcoming" @click="refresh">Refresh</UButton>
      </div>
    </div>
    <p v-if="selected.size > MAX_CREATE" class="text-sm text-error">At most {{ MAX_CREATE }} at a time.</p>

    <UAlert v-if="error && !upcoming" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="apiErrorMessage(error, 'Could not read Upcoming.')" />
    <UAlert v-if="props.clockFailed" color="error" variant="subtle" icon="i-lucide-circle-alert" title="Could not read the league's time zone.">
      <template #actions><UButton size="xs" variant="outline" @click="emit('retryClock')">Try again</UButton></template>
    </UAlert>
    <div v-if="loading" class="space-y-2">
      <span class="sr-only">Loading Upcoming…</span>
      <USkeleton class="h-4 w-32" aria-hidden="true" />
      <USkeleton v-for="n in 3" :key="n" class="h-16 w-full" aria-hidden="true" />
    </div>
    <template v-if="upcoming && props.today">
      <UAlert v-if="notice.settingsNote" color="warning" variant="subtle" icon="i-lucide-plug-zap" :title="notice.settingsNote">
        <template #actions><UButton size="xs" variant="outline" to="/settings">Open Settings</UButton></template>
      </UAlert>
      <UAlert v-for="w in notice.warnings" :key="w.text" color="warning" variant="subtle" icon="i-lucide-circle-alert" :title="w.text">
        <template #actions>
          <UButton v-if="w.settings" size="xs" variant="outline" to="/settings">Open Settings</UButton>
          <UButton v-if="w.retry" size="xs" variant="outline" @click="refresh">Try again</UButton>
        </template>
      </UAlert>
      <p v-if="groups.length === 0" class="text-sm text-muted">Nothing planned or in play-tools yet. Add a <strong>New tournament</strong>, or a schedule.</p>

      <div v-for="g in groups" :key="g.date" class="space-y-2">
        <h3 class="text-sm font-semibold">{{ g.heading }}</h3>
        <ul class="space-y-2">
          <li v-for="e in g.entries" :key="keyOf(e)" :aria-label="name(e)" class="rounded border border-default p-3 text-sm space-y-2 min-w-0">
            <div class="flex items-start gap-2">
              <UCheckbox
                v-if="actionsOf(e).actions.includes('create')"
                :model-value="selected.has(e.plannedId!)"
                :aria-label="`Select ${name(e)}`"
                class="pt-0.5"
                @update:model-value="toggle(e, $event)"
              />
              <div class="min-w-0 flex-1 space-y-1">
                <div class="flex flex-wrap items-center gap-1">
                  <span class="font-medium break-words">{{ e.name }}</span>
                  <UBadge variant="subtle" :color="entryStatus(e).color">{{ entryStatus(e).label }}</UBadge>
                  <UBadge v-if="sanctionTag(e, props.today)" variant="outline" :color="sanctionTag(e, props.today)!.startsWith('Create by') ? 'neutral' : 'warning'">
                    {{ sanctionTag(e, props.today) }}
                  </UBadge>
                  <UBadge v-if="e.inSchedule === false" variant="outline" color="neutral">No longer in its schedule</UBadge>
                  <UBadge v-if="e.timeProblem" variant="outline" color="warning">A clock change {{ e.timeProblem === 'nonexistent' ? 'skips' : 'repeats' }} this start time</UBadge>
                </div>
                <p class="text-muted break-words">
                  {{ e.startTime }} · {{ professorName(e.organizer) }}<template v-if="e.product"> · {{ GAME[e.product as 'tcg'] ?? e.product }}</template
                  ><template v-if="e.category"> · {{ e.category }}</template><template v-if="e.displayId"> · {{ e.displayId }}</template>
                </p>
                <template v-if="e.type?.kind === 'premier' && e.type.status !== 'resolved'">
                  <div v-if="e.type.status === 'series_ambiguous'" class="flex flex-wrap items-center gap-2">
                    <span class="text-warning">More than one series matches. Pick one:</span>
                    <USelect
                      :items="e.type.candidates.map((c) => ({ value: c.id, label: c.name }))"
                      :aria-label="`Series for ${name(e)}`"
                      placeholder="Series"
                      class="min-w-40"
                      @update:model-value="patchPlanned(e, { seriesId: $event }, 'Series chosen')"
                    />
                  </div>
                  <p v-else-if="e.type.status === 'series_not_found'" class="text-warning">play-tools has no matching series for this date yet.</p>
                  <p v-else class="text-warning">Couldn’t read {{ professorName(e.organizer) }}’s series.</p>
                </template>
                <p v-if="actionsOf(e).organizerNote && !leaseOf(e)" :class="actionsOf(e).settings ? 'text-warning' : 'text-muted'">
                  {{ actionsOf(e).organizerNote }} <NuxtLink v-if="actionsOf(e).settings" to="/settings" class="underline">Open Settings</NuxtLink>
                </p>
                <LeaseControls
                  v-if="e.tournamentId"
                  :tournament-id="e.tournamentId"
                  :label="name(e)"
                  :organizer-player-id="e.organizer?.playerId"
                  :lease="leaseOf(e)"
                  :candidates="lendable"
                  :lendable="canLend(e)"
                  @changed="refreshUpcoming()"
                />
              </div>
            </div>
            <div class="flex flex-wrap gap-1">
              <template v-for="a in actionsOf(e).actions" :key="a">
                <UButton v-if="a === 'create'" size="xs" :aria-label="`Create in play-tools ${name(e)}`" @click="emit('create', [e.plannedId!])">Create in play-tools</UButton>
                <UButton v-else-if="a === 'retry_create'" size="xs" color="warning" :aria-label="`Retry create… ${name(e)}`" @click="emit('retry', e.plannedId!)">Retry create…</UButton>
                <UButton
                  v-else-if="a === 'skip'"
                  size="xs"
                  variant="ghost"
                  :loading="busy === keyOf(e)"
                  :aria-label="`Skip ${name(e)}`"
                  @click="patchPlanned(e, { skipped: true }, `Skipped ${name(e)}`)"
                >
                  Skip
                </UButton>
                <UButton
                  v-else-if="a === 'unskip'"
                  size="xs"
                  variant="ghost"
                  :loading="busy === keyOf(e)"
                  :aria-label="`Unskip ${name(e)}`"
                  @click="patchPlanned(e, { skipped: false }, `Unskipped ${name(e)}`)"
                >
                  Unskip
                </UButton>
                <UButton v-else-if="a === 'edit'" size="xs" variant="outline" :aria-label="`Edit… ${name(e)}`" @click="emit('edit', idOf(e))">Edit…</UButton>
                <UButton v-else-if="a === 'cancel'" size="xs" variant="outline" color="error" :aria-label="`Cancel… ${name(e)}`" @click="emit('cancel', e.tournamentId!)">
                  Cancel…
                </UButton>
                <UButton
                  v-else-if="a === 'download'"
                  size="xs"
                  variant="outline"
                  icon="i-lucide-download"
                  :loading="busy === keyOf(e)"
                  :aria-label="`Download TDF ${name(e)}`"
                  @click="download(e)"
                >
                  Download TDF
                </UButton>
              </template>
            </div>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>
