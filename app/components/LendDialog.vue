<script setup lang="ts">
import type { LeaseView } from '~/utils/leases';

/**
 * **Lend…** (ADR-0015 §5): lend one or more of the viewer's tournaments to one league member, who can then staff them
 * and upload their results through the viewer's Pokémon account until the lease ends. All or none.
 */
const props = defineProps<{
  /** The tournament the dialog was opened from. */
  tournamentId: string;
  /** The viewer's play-tools tournaments shown on the page, the one clicked among them. */
  candidates: readonly { tournamentId: string; label: string; startsAt: string | null }[];
  timeZone: string;
}>();
const emit = defineEmits<{ close: []; lent: [] }>();
const toast = useToast();

const { data } = useLeaseList();
const open = ref(true);
const picked = ref<string[]>([props.tournamentId]);
const lessee = ref<number | undefined>();
const endDate = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const refused = ref<{ tournamentId: string; message: string }[]>([]);

watch(open, (o) => {
  if (!o) emit('close');
});

const lessees = computed(() => (data.value?.lessees ?? []).map((l) => ({ value: l.userId, label: l.name ? `${l.name} (${l.username})` : l.username })));
const latest = computed(() =>
  latestEndDate(
    props.candidates.filter((c) => picked.value.includes(c.tournamentId) && c.startsAt).map((c) => c.startsAt!),
    props.timeZone,
  ),
);
const labelOf = (id: string) => props.candidates.find((c) => c.tournamentId === id)?.label ?? id;
const lesseeName = computed(() => data.value?.lessees.find((l) => l.userId === lessee.value)?.name ?? data.value?.lessees.find((l) => l.userId === lessee.value)?.username ?? '');

function toggle(id: string, on: boolean | 'indeterminate') {
  picked.value = on === true ? [...new Set([...picked.value, id])] : picked.value.filter((x) => x !== id);
}

async function lend() {
  if (!lessee.value || picked.value.length === 0) return;
  busy.value = true;
  error.value = null;
  refused.value = [];
  try {
    const { leases } = await $fetch<{ leases: LeaseView[] }>('/api/tournament-leases', {
      method: 'POST',
      body: { tournamentIds: picked.value, lesseeUserId: lessee.value, ...(endDate.value && { endsAt: leaseEndsAt(endDate.value, props.timeZone) }) },
    });
    const n = leases.length;
    toast.add({
      color: 'success',
      title: `Lent ${n} tournament${n === 1 ? '' : 's'} to ${lesseeName.value}`,
      description: noticeLine(leases[0]?.notice, lesseeName.value) ?? undefined,
    });
    await refreshLeases();
    emit('lent');
    open.value = false;
  } catch (err) {
    const data = (err as { data?: { data?: { code?: string; refusals?: { tournamentId: string; message: string }[] } } }).data?.data;
    if (data?.code === 'lease_refused' && data.refusals) refused.value = data.refusals;
    else error.value = apiErrorMessage(err, 'Could not lend the tournament.');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Lend tournaments">
    <template #body>
      <div class="space-y-4 text-sm">
        <p class="text-muted">The person you pick can staff these tournaments and upload their results through your Pokémon account until the lease ends. You can still act on them yourself.</p>
        <UFormField label="Lend to" required>
          <USelect v-model="lessee" :items="lessees" placeholder="Choose a league member" aria-label="Lend to" class="w-full" />
        </UFormField>
        <fieldset class="space-y-2">
          <legend class="font-medium">Tournaments</legend>
          <UCheckbox
            v-for="c in candidates"
            :key="c.tournamentId"
            :model-value="picked.includes(c.tournamentId)"
            :label="c.label"
            @update:model-value="(on) => toggle(c.tournamentId, on)"
          />
        </fieldset>
        <UFormField label="Lend until (optional)" :help="`Until the end of the 7th day after it starts unless you pick a date.${latest ? ` Latest: ${latest}.` : ''}`">
          <UInput v-model="endDate" type="date" :max="latest ?? undefined" aria-label="Lend until" />
        </UFormField>
        <UAlert v-if="refused.length" color="error" variant="subtle" icon="i-lucide-circle-alert" title="Nothing was lent">
          <template #description>
            <ul class="list-disc pl-4">
              <li v-for="r in refused" :key="r.tournamentId">{{ labelOf(r.tournamentId) }}: {{ r.message }}</li>
            </ul>
          </template>
        </UAlert>
        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="error" />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" @click="open = false">Cancel</UButton>
        <UButton icon="i-lucide-hand-helping" :loading="busy" :disabled="!lessee || picked.length === 0" @click="lend">Lend</UButton>
      </div>
    </template>
  </UModal>
</template>
