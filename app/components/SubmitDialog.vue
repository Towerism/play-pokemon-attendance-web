<script setup lang="ts">
import type { Resolution } from '../../server/modules/submission/resolve';

const props = defineProps<{ date: string; playerCount: number }>();
const emit = defineEmits<{ finished: [] }>();
const toast = useToast();

const open = ref(false);
const resolving = ref(false);
const starting = ref(false);
const resolution = ref<Resolution | null>(null);
const resolveError = ref<{ message: string; code?: string } | null>(null);
const chosen = ref<string | undefined>();
const submissionId = ref<number | null>(null);

const { latest, result } = useSubmissionEvents(submissionId);

const candidates = computed(() => resolution.value?.candidates ?? []);
const selected = computed(() => candidates.value.find((c) => c.id === chosen.value));
const formatInstant = (iso: string | Date) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

async function openDialog() {
  open.value = true;
  submissionId.value = null;
  resolution.value = null;
  resolveError.value = null;
  resolving.value = true;
  try {
    const url: string = `/api/sessions/${props.date}/resolve`;
    resolution.value = await $fetch<Resolution>(url, { method: 'POST', body: {} });
    // One session: auto-select it for confirmation; several: the organizer chooses (§4.4).
    chosen.value = candidates.value.length === 1 ? candidates.value[0]!.id : undefined;
  } catch (err) {
    resolveError.value = { message: apiErrorMessage(err, 'Could not reach play-tools.'), code: apiErrorCode(err) };
  } finally {
    resolving.value = false;
  }
}

async function start() {
  if (!selected.value) return;
  starting.value = true;
  try {
    const url: string = `/api/sessions/${props.date}/submissions`;
    const started = await $fetch<{ submissionId: number }>(url, { method: 'POST', body: { playSessionId: selected.value.id } });
    submissionId.value = started.submissionId;
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not start the submission.') });
  } finally {
    starting.value = false;
  }
}

watch(result, (view) => {
  if (!view) return;
  const { label, color } = submissionStatus(view.status);
  toast.add({ color: color === 'info' ? 'neutral' : color, title: `Attendance for ${props.date}: ${label}`, description: submissionSummary(view.counts) });
  emit('finished');
});
</script>

<template>
  <div>
    <UButton size="lg" icon="i-lucide-send" :disabled="playerCount === 0" @click="openDialog">Submit attendance</UButton>

    <UModal v-model:open="open" title="Submit attendance" :description="`${playerCount} players for ${date}`" :dismissible="!submissionId || !!result">
      <template #body>
        <div v-if="resolving" class="flex items-center gap-2 text-sm text-muted">
          <UIcon name="i-lucide-loader-circle" class="animate-spin" /> Finding the play session in play-tools…
        </div>

        <UAlert v-else-if="resolveError" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="resolveError.message">
          <template v-if="['not_connected', 'needs_reconnect', 'league_not_selected'].includes(resolveError.code ?? '')" #description>
            <NuxtLink to="/settings" class="underline">Open Settings</NuxtLink>
          </template>
        </UAlert>

        <!-- Progress, then the outcome -->
        <div v-else-if="submissionId" class="space-y-3">
          <template v-if="!result">
            <UProgress :model-value="latest ? progressPercent(latest.done, latest.total) : null" />
            <p class="text-sm text-muted">{{ latest?.message ?? 'Reading what play-tools already has…' }}</p>
            <p class="text-xs text-muted">Batches of up to 20 players go out at least 10 seconds apart. You can close this; it keeps going.</p>
          </template>
          <template v-else>
            <UBadge :color="submissionStatus(result.status).color" variant="subtle" size="lg">{{ submissionStatus(result.status).label }}</UBadge>
            <p class="text-sm">{{ submissionSummary(result.counts) }}</p>
            <p v-if="result.error" class="text-sm text-error">{{ result.error }}</p>
            <ul v-if="result.counts.failed" class="text-sm space-y-0.5">
              <li v-for="item in result.items.filter((i) => i.outcome === 'failed')" :key="item.playerId">
                {{ item.displayName || item.playerId }}: <span class="text-muted">{{ item.error }}</span>
              </li>
            </ul>
          </template>
          <NuxtLink :to="`/history/${submissionId}`" class="text-sm underline">Details</NuxtLink>
        </div>

        <!-- Choose / confirm the session -->
        <div v-else-if="resolution" class="space-y-3">
          <UAlert
            v-if="candidates.length === 0"
            color="warning"
            variant="subtle"
            icon="i-lucide-calendar-x"
            :title="`No play session exists on ${date} in play-tools.`"
            description="Create it there first, then try again."
          />
          <URadioGroup
            v-else
            v-model="chosen"
            :items="candidates.map((c) => ({ value: c.id, label: c.label, description: c.editable ? undefined : 'Attendance is closed for this session', disabled: !c.editable }))"
          />
          <p v-if="selected?.editableUntil" class="text-sm text-muted">
            play-tools accepts attendance for this session until {{ formatInstant(selected.editableUntil) }}.
          </p>
          <p class="text-xs text-muted">Times are in {{ resolution.timeZone }}. Players already in play-tools are not sent again.</p>
        </div>
      </template>

      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="open = false">{{ submissionId ? 'Close' : 'Cancel' }}</UButton>
          <UButton v-if="!submissionId" icon="i-lucide-send" :disabled="!selected || !selected.editable" :loading="starting" @click="start">
            Submit
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
