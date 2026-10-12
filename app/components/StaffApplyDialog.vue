<script setup lang="ts">
import type { StaffOutcome } from '~/utils/staff';

const props = defineProps<{ date: string; tournamentId: string; label: string }>();
const emit = defineEmits<{ finished: [] }>();
const toast = useToast();

const open = ref(false);
const starting = ref(false);
const startError = ref<{ message: string; code?: string } | null>(null);
const submissionId = ref<number | null>(null);

const { latest, result } = useSubmissionEvents(submissionId);

const SETTINGS_CODES = ['not_connected', 'needs_reconnect', 'league_not_selected'];
const staffItems = computed(() => (result.value?.items ?? []).map((i) => ({ ...i, outcome: i.outcome as StaffOutcome })));
const attention = computed(() => staffItems.value.filter(needsAttention));

/** Applies this tournament's wanted staff to play-tools as a staff job, then follows its progress. */
async function start() {
  open.value = true;
  submissionId.value = null;
  startError.value = null;
  starting.value = true;
  try {
    const url: string = `/api/sessions/${props.date}/staff/apply`;
    const started = await $fetch<{ submissionId: number }>(url, { method: 'POST', body: { tournamentId: props.tournamentId } });
    submissionId.value = started.submissionId;
  } catch (err) {
    const code = apiErrorCode(err);
    startError.value = { message: applyStartText(code) ?? apiErrorMessage(err, 'Could not start assigning staff.'), code };
    if (code === 'needs_reconnect' || code === 'not_connected') await refreshPokemonConnection();
  } finally {
    starting.value = false;
  }
}

watch(result, (view) => {
  if (!view) return;
  const { label, color } = submissionStatus(view.status, 'staff');
  toast.add({ color: color === 'info' ? 'neutral' : color, title: `Staff for ${props.label}: ${label}`, description: staffSummary(staffItems.value) });
  emit('finished');
});
</script>

<template>
  <div>
    <UButton icon="i-lucide-badge-check" :loading="starting" @click="start">Assign staff in play-tools</UButton>

    <UModal v-model:open="open" :title="`Staff for ${label}`" :description="`Tournament on ${date}`" :dismissible="!submissionId || !!result">
      <template #body>
        <div v-if="starting" class="flex items-center gap-2 text-sm text-muted">
          <UIcon name="i-lucide-loader-circle" class="animate-spin" /> Starting…
        </div>

        <UAlert v-else-if="startError" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="startError.message">
          <template v-if="SETTINGS_CODES.includes(startError.code ?? '')" #description>
            <NuxtLink to="/settings" class="underline">Open Settings</NuxtLink>
          </template>
        </UAlert>

        <div v-else-if="submissionId" class="space-y-3">
          <template v-if="!result">
            <UProgress :model-value="latest ? progressPercent(latest.done, latest.total) : null" />
            <p class="text-sm text-muted">{{ latest?.message ?? 'Reading who play-tools already lists…' }}</p>
            <p class="text-xs text-muted">Staff go out one at a time, at least a second apart. You can close this; it keeps going.</p>
          </template>
          <template v-else>
            <UBadge :color="submissionStatus(result.status, 'staff').color" variant="subtle" size="lg">{{ submissionStatus(result.status, 'staff').label }}</UBadge>
            <p class="text-sm">{{ staffSummary(staffItems) }}</p>
            <p v-if="result.error" class="text-sm text-error">{{ result.error }}</p>
            <ul v-if="attention.length" class="space-y-0.5 text-sm">
              <li v-for="item in attention" :key="item.playerId" class="break-words">
                {{ item.displayName || item.playerId }}: <span class="text-muted">{{ staffOutcomeText(item) }}</span>
              </li>
            </ul>
          </template>
          <NuxtLink :to="`/history/${submissionId}`" class="text-sm underline">Details</NuxtLink>
        </div>
      </template>

      <template #footer>
        <div class="flex w-full justify-end">
          <UButton variant="ghost" color="neutral" @click="open = false">Close</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
