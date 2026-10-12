<script setup lang="ts">
import type { StaffAssignmentView, TournamentStaffView } from '../../server/modules/staffing/service';
import type { StaffRole } from '~/utils/staff';

const props = defineProps<{ date: string; tournament: TournamentStaffView; roles: readonly StaffRole[] | undefined }>();
/** Wanted staff changed here, or play-tools turned out to differ: read the date's staff again. */
const emit = defineEmits<{ changed: [] }>();
const toast = useToast();

const headingId = useId();
const editable = computed(() => props.tournament.editable && !props.tournament.missing && !props.tournament.unavailable);
const note = computed(() => readOnlyNote(props.tournament));

const STATE: Record<StaffAssignmentView['state'], { label: string; color: 'neutral' | 'success' | 'error' | 'warning' }> = {
  pending: { label: 'Not sent yet', color: 'neutral' },
  assigned: { label: 'In play-tools', color: 'success' },
  failed: { label: 'Failed', color: 'error' },
  removing: { label: 'Removing', color: 'warning' },
};

const roleItems = computed(() => (props.roles ?? []).map((r) => ({ label: r.label, value: r.code })));
const label = (code: string) => roleLabel(code, props.roles);
const who = (a: { name: string; playerId: string }) => a.name || a.playerId;

/** Rows saved here since the card was read; dropped when the date's staff is read again. */
const saved = ref<Record<number, StaffAssignmentView>>({});
/** A role change on its way to the server, shown at once and dropped if it is refused. */
const changing = ref<Record<number, string>>({});
watch(
  () => props.tournament,
  () => (saved.value = {}),
);
const rows = computed(() => props.tournament.assignments.map((a) => saved.value[a.id] ?? a));

/** Changing a staffer's role; the staff job changes it in play-tools on the next apply. */
async function changeRole(a: StaffAssignmentView, role: string) {
  if (role === a.role) return;
  changing.value = { ...changing.value, [a.id]: role };
  try {
    const { assignment } = await $fetch<{ assignment: StaffAssignmentView }>(`/api/sessions/${props.date}/staff/${a.id}`, { method: 'PATCH', body: { role } });
    saved.value = { ...saved.value, [a.id]: assignment };
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not change the role.') });
    if (['tournament_locked', 'unknown_tournament', 'not_found'].includes(apiErrorCode(err) ?? '')) emit('changed');
  } finally {
    const { [a.id]: _, ...rest } = changing.value;
    changing.value = rest;
  }
}

async function remove(a: StaffAssignmentView) {
  try {
    await $fetch(`/api/sessions/${props.date}/staff/${a.id}`, { method: 'DELETE' });
  } catch (err) {
    // Already gone: the refresh shows that.
    if (apiErrorCode(err) !== 'not_found') toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not remove the staffer.') });
  }
  emit('changed');
}
</script>

<template>
  <section :aria-labelledby="headingId" class="space-y-3 rounded-md border border-default p-3">
    <div>
      <h3 :id="headingId" class="font-medium break-words">{{ tournament.label }}</h3>
      <p v-if="organizerText(tournament.organizer)" class="text-sm text-muted break-words">{{ organizerText(tournament.organizer) }}</p>
    </div>
    <p v-if="note" class="text-sm" :class="note.warning ? 'text-warning' : 'text-muted'">
      {{ note.text }}
      <NuxtLink v-if="note.settings" to="/settings" class="underline">Open Settings</NuxtLink>
    </p>

    <ul v-if="rows.length" aria-label="Wanted staff" class="divide-y divide-default">
      <li v-for="a in rows" :key="a.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
        <div class="min-w-0 flex-1 basis-40">
          <span class="break-words" :class="{ 'text-muted italic': !a.name }">{{ a.name || 'No name' }}</span>
          <span class="ms-2 text-sm text-muted tabular-nums">{{ a.playerId }}</span>
          <p v-if="a.appliedRole" class="text-xs text-muted">In play-tools as {{ label(a.appliedRole) }}; changes on the next apply</p>
        </div>
        <UBadge variant="subtle" :color="STATE[a.state].color">{{ STATE[a.state].label }}</UBadge>
        <template v-if="editable && a.state !== 'removing'">
          <USelect
            :model-value="changing[a.id] ?? a.role"
            :items="roleItems.length ? roleItems : [{ label: a.role, value: a.role }]"
            :aria-label="`Role for ${who(a)}`"
            class="w-36"
            @update:model-value="changeRole(a, $event as string)"
          />
          <UButton icon="i-lucide-x" size="sm" variant="ghost" color="neutral" :aria-label="`Remove ${who(a)} from staff`" @click="remove(a)" />
        </template>
        <span v-else class="text-sm">{{ label(a.role) }}</span>
      </li>
    </ul>
    <p v-else class="text-sm text-muted">No staff wanted yet.</p>

    <div v-if="tournament.upstreamOnly.length" class="space-y-1">
      <h4 class="text-sm font-medium">Also in play-tools</h4>
      <ul aria-label="Also in play-tools" class="text-sm space-y-0.5">
        <li v-for="u in tournament.upstreamOnly" :key="u.playerId" class="flex flex-wrap gap-x-2">
          <span class="break-words" :class="{ 'text-muted italic': !u.name }">{{ u.name || 'No name' }}</span>
          <span class="text-muted tabular-nums">{{ u.playerId }}</span>
          <span class="text-muted">{{ label(u.role) }}</span>
        </li>
      </ul>
    </div>

    <template v-if="editable">
      <StaffSearch :date="date" :tournament="tournament" :roles="roles" @changed="emit('changed')" />
      <AddStaffForm :date="date" :tournament-id="tournament.tournamentId" :roles="roles" @changed="emit('changed')" />
      <StaffApplyDialog
        v-if="rows.length"
        :date="date"
        :tournament-id="tournament.tournamentId"
        :label="tournament.label"
        :organizer="tournament.organizer"
        @finished="emit('changed')"
      />
    </template>
  </section>
</template>
