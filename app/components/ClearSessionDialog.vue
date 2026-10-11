<script setup lang="ts">
import type { Resolution } from '../../server/modules/submission/resolve';
import type { ClearPreview } from '../../server/modules/submission/service';

/**
 * Clear session (danger zone, architecture §6.3): deletes every player record
 * in one play session in play-tools, never a staff record. The organizer picks
 * the resolved play session, sees who would go, and types the date to confirm.
 */
const props = defineProps<{ date: string; playSessionId: string | null }>();
const emit = defineEmits<{ finished: [] }>();
const toast = useToast();

const open = ref(false);
const resolving = ref(false);
const resolution = ref<Resolution | null>(null);
const chosen = ref<string | undefined>();
const preview = ref<ClearPreview | null>(null);
const previewing = ref(false);
const error = ref<{ message: string; code?: string } | null>(null);
const typed = ref('');
const starting = ref(false);
const submissionId = ref<number | null>(null);

const { latest, result } = useSubmissionEvents(submissionId);

const candidates = computed(() => resolution.value?.candidates ?? []);
const selected = computed(() => candidates.value.find((c) => c.id === chosen.value));
const confirmed = computed(() => clearConfirmed(typed.value, props.date));
const canClear = computed(() => !!preview.value && preview.value.players.length > 0 && !!selected.value?.editable && confirmed.value);

async function openDialog() {
  open.value = true;
  submissionId.value = null;
  resolution.value = null;
  // Reset the choice too, so choosing the same session again reloads its preview.
  chosen.value = undefined;
  preview.value = null;
  error.value = null;
  typed.value = '';
  resolving.value = true;
  try {
    const url: string = `/api/sessions/${props.date}/resolve`;
    resolution.value = await $fetch<Resolution>(url, { method: 'POST', body: {} });
    const known = candidates.value.find((c) => c.id === props.playSessionId);
    chosen.value = known?.id ?? (candidates.value.length === 1 ? candidates.value[0]!.id : undefined);
  } catch (err) {
    error.value = { message: apiErrorMessage(err, 'Could not reach play-tools.'), code: apiErrorCode(err) };
  } finally {
    resolving.value = false;
  }
}

watch(chosen, async (playSessionId) => {
  preview.value = null;
  typed.value = '';
  if (!playSessionId) return;
  previewing.value = true;
  try {
    const url: string = `/api/sessions/${props.date}/clear`;
    preview.value = await $fetch<ClearPreview>(url, { query: { playSessionId } });
  } catch (err) {
    error.value = { message: apiErrorMessage(err, 'Could not read the session from play-tools.'), code: apiErrorCode(err) };
  } finally {
    previewing.value = false;
  }
});

async function clearSession() {
  if (!canClear.value || !selected.value) return;
  starting.value = true;
  try {
    const url: string = `/api/sessions/${props.date}/clear`;
    const started = await $fetch<{ submissionId: number }>(url, {
      method: 'POST',
      body: { playSessionId: selected.value.id, confirmDate: typed.value },
    });
    submissionId.value = started.submissionId;
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not start clearing the session.') });
  } finally {
    starting.value = false;
  }
}

watch(result, (view) => {
  if (!view) return;
  const { label, color } = submissionStatus(view.status, view.kind);
  toast.add({ color: color === 'info' ? 'neutral' : color, title: `Clear session ${props.date}: ${label}` });
  emit('finished');
});
</script>

<template>
  <div>
    <UButton color="error" variant="outline" icon="i-lucide-trash-2" @click="openDialog">Clear session…</UButton>

    <UModal
      v-model:open="open"
      title="Clear session"
      :description="`Delete every player's attendance in one play session on ${date} from play-tools.`"
      :dismissible="!submissionId || !!result"
    >
      <template #body>
        <div v-if="resolving" class="flex items-center gap-2 text-sm text-muted">
          <UIcon name="i-lucide-loader-circle" class="animate-spin" /> Finding the play session in play-tools…
        </div>

        <UAlert v-else-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="error.message">
          <template v-if="['not_connected', 'needs_reconnect', 'league_not_selected'].includes(error.code ?? '')" #description>
            <NuxtLink to="/settings" class="underline">Open Settings</NuxtLink>
          </template>
        </UAlert>

        <!-- Progress, then the outcome -->
        <div v-else-if="submissionId" class="space-y-3">
          <template v-if="!result">
            <UProgress :model-value="latest ? progressPercent(latest.done, latest.total) : null" />
            <p class="text-sm text-muted">{{ latest?.message ?? 'Reading the session from play-tools…' }}</p>
            <p class="text-xs text-muted">Players are removed one at a time. You can close this; it keeps going.</p>
          </template>
          <template v-else>
            <UBadge :color="submissionStatus(result.status, result.kind).color" variant="subtle" size="lg">
              {{ submissionStatus(result.status, result.kind).label }}
            </UBadge>
            <p v-if="result.error" class="text-sm text-error">{{ result.error }}</p>
          </template>
          <NuxtLink :to="`/history/${submissionId}`" class="text-sm underline">Details</NuxtLink>
        </div>

        <!-- Choose the session, see who goes, type the date -->
        <div v-else-if="resolution" class="space-y-3">
          <UAlert
            v-if="candidates.length === 0"
            color="warning"
            variant="subtle"
            icon="i-lucide-calendar-x"
            :title="`No play session exists on ${date} in play-tools.`"
          />
          <URadioGroup
            v-else
            v-model="chosen"
            :items="candidates.map((c) => ({ value: c.id, label: c.label, description: c.editable ? undefined : 'Attendance is closed for this session', disabled: !c.editable }))"
          />

          <div v-if="previewing" class="flex items-center gap-2 text-sm text-muted">
            <UIcon name="i-lucide-loader-circle" class="animate-spin" /> Reading who is in this session…
          </div>
          <template v-else-if="preview">
            <p v-if="preview.players.length === 0" class="text-sm">play-tools has no players in this session.</p>
            <template v-else>
              <UAlert color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="clearConfirmText(preview)" />
              <ul class="max-h-48 list-disc space-y-0.5 overflow-y-auto pl-5 text-sm">
                <li v-for="player in preview.players" :key="player.playerId">
                  {{ player.name || player.playerId }}
                  <span v-if="!player.addedByApp" class="text-muted">· entered in play-tools</span>
                </li>
              </ul>
              <UFormField :label="`Type ${date} to confirm`">
                <UInput v-model="typed" :placeholder="date" autocomplete="off" class="w-full" @keydown.enter.prevent="clearSession" />
              </UFormField>
            </template>
          </template>
        </div>
      </template>

      <template v-if="!submissionId" #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="open = false">Cancel</UButton>
          <UButton color="error" icon="i-lucide-trash-2" :disabled="!canClear" :loading="starting" @click="clearSession">Clear session</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
