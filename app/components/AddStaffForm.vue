<script setup lang="ts">
import { PlayerInput } from '#shared/schemas/roster';
import type { StaffRole } from '~/utils/staff';

const props = defineProps<{ date: string; tournamentId: string; roles: readonly StaffRole[] | undefined }>();
/** A staffer was added, or the card turned out to be stale. */
const emit = defineEmits<{ changed: [] }>();

const state = reactive({ playerId: '', name: '', role: '' });
const busy = ref(false);
const addStaff = useAddStaff(
  () => props.date,
  () => props.roles,
  () => emit('changed'),
);
const roleItems = computed(() => (props.roles ?? []).map((r) => ({ label: r.label, value: r.code })));
const role = computed({
  get: () => state.role || defaultRole(null, props.roles),
  set: (value: string) => (state.role = value),
});

/** For a first-time staffer the app doesn't know yet: their ID, a name if the app has none, and the role. */
async function onSubmit() {
  const player = PlayerInput.parse(state);
  busy.value = true;
  try {
    if (await addStaff({ tournamentId: props.tournamentId, ...player, role: role.value }, player.name ?? '')) {
      Object.assign(state, { playerId: '', name: '', role: '' });
      emit('changed');
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <UForm
    :schema="PlayerInput"
    :state="state"
    aria-label="Add staff by ID"
    class="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start"
    @submit="onSubmit"
  >
    <UFormField name="playerId" class="sm:w-36">
      <UInput v-model="state.playerId" placeholder="Player ID" aria-label="Player ID" inputmode="numeric" autocomplete="off" class="w-full" />
    </UFormField>
    <UFormField name="name" class="min-w-0 flex-1">
      <UInput v-model="state.name" placeholder="Name (optional)" aria-label="Name" autocomplete="off" class="w-full" />
    </UFormField>
    <USelect v-model="role" :items="roleItems.length ? roleItems : [{ label: role, value: role }]" aria-label="Role" class="sm:w-36" />
    <UButton type="submit" icon="i-lucide-user-plus" :loading="busy">Add staffer</UButton>
  </UForm>
</template>
