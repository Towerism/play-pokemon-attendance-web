<script setup lang="ts">
import type { CardLease } from '~/utils/leases';

/**
 * A tournament's lease on its card or row (ADR-0015 §5): the line saying who may change it, and for the organizer
 * **Lend…** or **End lease**, for the lent professor **Give back**. Ending and giving back ask first.
 */
const props = defineProps<{
  tournamentId: string;
  label: string;
  organizerPlayerId: string | null | undefined;
  lease: CardLease | null | undefined;
  /** The viewer's play-tools tournaments on the page, for the Lend dialog. */
  candidates: readonly { tournamentId: string; label: string; startsAt: string | null }[];
  /** Whether the tournament can still be lent (not cancelled, not past). */
  lendable: boolean;
}>();
const emit = defineEmits<{ changed: [] }>();
const toast = useToast();

const { user } = useUserSession();
const { data: connections } = usePokemonConnection();
const zone = browserTimeZone();
const mine = computed(() => !!props.organizerPlayerId && !!connections.value?.connections.some((c) => c.mine && c.professorPlayerId === props.organizerPlayerId));
const line = computed(() => leaseLine(props.lease, user.value?.id, mine.value, zone));
const lending = ref(false);
const confirming = ref(false);
const busy = ref(false);

async function end() {
  if (!line.value) return;
  busy.value = true;
  try {
    const { endNotice } = await $fetch<{ endNotice: 'sending' | 'genie_unavailable' | 'no_recipient' | 'none' }>(`/api/tournament-leases/${line.value.leaseId}`, { method: 'DELETE' });
    const giving = line.value.kind === 'lessee';
    toast.add({
      color: 'success',
      title: giving ? `Gave back ${props.label}` : `Ended the lease on ${props.label}`,
      description: noticeLine(endNotice, props.lease?.lesseeName ?? '') ?? undefined,
    });
    confirming.value = false;
    await refreshLeases();
    emit('changed');
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not end the lease.') });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="line || (mine && lendable)" class="flex flex-wrap items-center gap-2 text-sm">
    <span v-if="line" :class="line.kind === 'other' ? 'text-muted' : ''">{{ line.text }}</span>
    <UButton v-if="line?.kind === 'organizer'" size="xs" variant="outline" :aria-label="`End lease on ${label}`" @click="confirming = true">End lease</UButton>
    <UButton v-else-if="line?.kind === 'lessee'" size="xs" variant="outline" :aria-label="`Give back ${label}`" @click="confirming = true">Give back</UButton>
    <UButton v-else-if="!line && mine && lendable" size="xs" variant="outline" icon="i-lucide-hand-helping" :aria-label="`Lend… ${label}`" @click="lending = true">Lend…</UButton>

    <LendDialog v-if="lending" :tournament-id="tournamentId" :candidates="candidates" :time-zone="zone" @close="lending = false" @lent="emit('changed')" />
    <UModal v-model:open="confirming" :title="line?.kind === 'lessee' ? 'Give back this tournament?' : 'End this lease?'">
      <template #body>
        <p class="text-sm">
          {{
            line?.kind === 'lessee'
              ? `You won't be able to staff ${label} or upload its results any more.`
              : `${lease?.lesseeName} won't be able to staff ${label} or upload its results any more.`
          }}
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="confirming = false">Keep it</UButton>
          <UButton color="warning" :loading="busy" @click="end">{{ line?.kind === 'lessee' ? 'Give back' : 'End lease' }}</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
