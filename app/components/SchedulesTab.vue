<script setup lang="ts">
import type { Scaffold, Schedule } from '../../server/modules/tournaments/service';

/**
 * Schedules (ADR-0010 decision 3): scaffolds and their recurrence, and **Create through date…**. Its three reads run
 * together and each list shows when its own answers; forms wait for what they need: the league's clock for schedules,
 * the template list for scaffolds (#191).
 */
const props = defineProps<{ today: string | null; clockFailed?: boolean }>();
const toast = useToast();

const { data: scaffolds, error: scaffoldsError, refresh: rereadScaffolds } = useTournamentScaffolds();
const { data: schedules, error: schedulesError, refresh: rereadSchedules } = useTournamentSchedules();
const { data: templates, error: templatesError } = useAllTournamentTemplates();
const refreshScaffolds = () => rereadScaffolds({ dedupe: 'cancel' });
const refreshSchedules = () => rereadSchedules({ dedupe: 'cancel' });
const clockPending = computed(() => !props.today && !props.clockFailed);
const schedulesLoading = computed(() => !schedules.value && !schedulesError.value);
const scaffoldsLoading = computed(() => !scaffolds.value && !scaffoldsError.value);
const templatesPending = computed(() => !templates.value && !templatesError.value);

const editingScaffold = ref<Scaffold | 'new' | null>(null);
const editingSchedule = ref<Schedule | 'new' | null>(null);
const creatingThrough = ref<Schedule | null>(null);

const templateName = (id: number) => templates.value?.templates.find((t) => t.id === id)?.name ?? `Template #${id}`;
const slotText = (s: Scaffold['slots'][number]) => `${templateName(s.templateId)} · day +${s.dayOffset} · ${s.startTime ?? 'its own time'}`;
const liveSchedules = computed(() => (schedules.value?.schedules ?? []).filter((s) => !s.archived));
const liveScaffolds = computed(() => (scaffolds.value?.scaffolds ?? []).filter((s) => !s.archived));

async function archiveScaffold(s: Scaffold) {
  if (!window.confirm(`Archive the scaffold “${s.name}”?`)) return;
  try {
    await $fetch(`/api/tournament-scaffolds/${s.id}`, { method: 'DELETE' });
    await refreshScaffolds();
  } catch (err) {
    if (apiErrorCode(err) === 'scaffold_in_use') {
      const ids = (err as { data?: { data?: { scheduleIds?: number[] } } }).data?.data?.scheduleIds ?? [];
      const names = ids.map((id) => {
        const sch = schedules.value?.schedules.find((x) => x.id === id);
        return sch ? ruleText(sch.rule) : `#${id}`;
      });
      toast.add({ color: 'error', title: `“${s.name}” is used by the schedules ${names.join(', ')}. Archive those first.` });
    } else toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not archive the scaffold.') });
  }
}

async function archiveSchedule(s: Schedule) {
  if (!window.confirm(`Archive the schedule “${s.scaffoldName} · ${ruleText(s.rule)}”? Dates it planned that aren't in play-tools go.`)) return;
  try {
    await $fetch(`/api/tournament-schedules/${s.id}`, { method: 'DELETE' });
    await Promise.all([refreshSchedules(), refreshUpcoming().catch(() => undefined), refreshRequiredEvents()]);
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not archive the schedule.') });
  }
}
</script>

<template>
  <div class="space-y-6">
    <section aria-labelledby="schedules-heading" :aria-busy="schedulesLoading" class="space-y-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 id="schedules-heading" class="text-lg font-semibold">Schedules</h2>
        <UButton
          size="sm"
          icon="i-lucide-plus"
          :loading="clockPending || scaffoldsLoading"
          :disabled="liveScaffolds.length === 0 || !props.today"
          @click="editingSchedule = 'new'"
        >
          New schedule
        </UButton>
      </div>
      <UAlert v-if="schedulesError && !schedules" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="apiErrorMessage(schedulesError, 'Could not read the schedules.')" />
      <div v-else-if="schedulesLoading" class="space-y-2">
        <span class="sr-only">Loading Schedules…</span>
        <USkeleton v-for="n in 2" :key="n" class="h-20 w-full" aria-hidden="true" />
      </div>
      <p v-else-if="liveSchedules.length === 0" class="text-sm text-muted">No schedules yet. Make a scaffold, then a schedule that repeats it.</p>
      <ul class="space-y-2">
        <li v-for="s in liveSchedules" :key="s.id" :aria-label="`${s.scaffoldName} · ${ruleText(s.rule)}`" class="rounded border border-default p-3 text-sm space-y-1 min-w-0">
          <div class="flex flex-wrap items-center gap-1">
            <span class="font-medium break-words">{{ s.scaffoldName }} · {{ ruleText(s.rule) }}</span>
            <UBadge v-if="s.paused" variant="subtle" color="neutral">Paused</UBadge>
          </div>
          <p class="text-muted">
            From {{ dayLabel(s.startsOn) }}<template v-if="s.endsOn"> to {{ dayLabel(s.endsOn) }}</template> · planned {{ s.horizonWeeks }} weeks ahead<template
              v-if="s.createdThrough"
            >
              · created through {{ dayLabel(s.createdThrough) }}</template
            >
          </p>
          <div class="flex flex-wrap gap-1">
            <UButton size="xs" :disabled="s.paused || !props.today" :aria-label="`Create through date… ${s.scaffoldName}`" @click="creatingThrough = s">Create through date…</UButton>
            <UButton size="xs" variant="outline" :disabled="!props.today" :aria-label="`Edit… ${s.scaffoldName} · ${ruleText(s.rule)}`" @click="editingSchedule = s">Edit…</UButton>
            <UButton size="xs" variant="ghost" color="error" :aria-label="`Archive… ${s.scaffoldName} · ${ruleText(s.rule)}`" @click="archiveSchedule(s)">Archive…</UButton>
          </div>
        </li>
      </ul>
    </section>

    <section aria-labelledby="scaffolds-heading" :aria-busy="scaffoldsLoading" class="space-y-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 id="scaffolds-heading" class="text-lg font-semibold">Scaffolds</h2>
        <UButton size="sm" variant="outline" icon="i-lucide-plus" :loading="templatesPending" @click="editingScaffold = 'new'">New scaffold</UButton>
      </div>
      <UAlert v-if="scaffoldsError && !scaffolds" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="apiErrorMessage(scaffoldsError, 'Could not read the scaffolds.')" />
      <div v-else-if="scaffoldsLoading" class="space-y-2">
        <span class="sr-only">Loading Scaffolds…</span>
        <USkeleton v-for="n in 2" :key="n" class="h-16 w-full" aria-hidden="true" />
      </div>
      <ul class="space-y-2">
        <li v-for="s in liveScaffolds" :key="s.id" :aria-label="s.name" class="rounded border border-default p-3 text-sm space-y-1 min-w-0">
          <span class="font-medium break-words">{{ s.name }}</span>
          <ul class="list-disc pl-5 text-muted">
            <li v-for="slot in s.slots" :key="slot.position" class="break-words">{{ slotText(slot) }}</li>
          </ul>
          <div class="flex gap-1">
            <UButton size="xs" variant="outline" :aria-label="`Edit… ${s.name}`" :loading="templatesPending" @click="editingScaffold = s">Edit…</UButton>
            <UButton size="xs" variant="ghost" color="error" :aria-label="`Archive… ${s.name}`" @click="archiveScaffold(s)">Archive…</UButton>
          </div>
        </li>
      </ul>
    </section>

    <ScaffoldForm
      v-if="editingScaffold"
      :scaffold="editingScaffold === 'new' ? null : editingScaffold"
      :templates="templates?.templates ?? []"
      @saved="refreshScaffolds()"
      @close="editingScaffold = null"
    />
    <ScheduleForm
      v-if="editingSchedule && props.today"
      :schedule="editingSchedule === 'new' ? null : editingSchedule"
      :scaffolds="scaffolds?.scaffolds ?? []"
      :today="props.today"
      @saved="refreshSchedules()"
      @close="editingSchedule = null"
    />
    <CreateThroughDialog v-if="creatingThrough && props.today" :schedule="creatingThrough" :today="props.today" @close="creatingThrough = null" />
  </div>
</template>
