<script setup lang="ts">
import type { SubmissionView } from '../../server/modules/submission/service';
import type { ResultsPreview, ResultsWarning } from '../../server/modules/tournaments/results';
import type { StaffRole } from '~/utils/staff';

/**
 * **Upload results** (ADR-0011 decisions 3–8): a dropped TDF's warnings and fixes, then one send. Nothing reaches
 * play-tools' validation before the confirm, and the confirm carries the fingerprint of exactly the warnings shown.
 * `again`: opened by **Upload again…**, so sending gives Pokémon support another copy.
 */
const props = defineProps<{ date: string; tournamentId: string; label: string; preview: ResultsPreview; roles?: readonly StaffRole[]; again?: boolean }>();
/** `finished`: the upload job ended (Results and the session's attendance may have changed). */
const emit = defineEmits<{ close: []; finished: [] }>();
const toast = useToast();

const base = computed(() => `/api/sessions/${props.date}/tournaments/${props.tournamentId}/results/${current.value.uploadId}`);
const open = ref(true);
const current = ref<ResultsPreview>(props.preview);
const fullName = ref(props.preview.needsOrganizerFullName?.playToolsName ?? '');
const importAttendance = ref(true);
const error = ref<string | null>(null);
const errorLines = ref<string[]>([]);
const stale = ref(false);
const busy = ref(false);
/** Remove from staff: who the in-dialog confirm names, then its job. */
const removing = ref<{ playerId: string; name: string; role: string }[] | null>(null);
const removalId = ref<number | null>(null);
const recheckFailed = ref(false);
const submissionId = ref<number | null>(null);
const finished = ref(false);

watch(open, (o) => {
  if (!o) emit('close');
});

const warnings = computed(() => orderedWarnings(current.value.warnings));
type StaffWarning = Extract<ResultsWarning, { code: 'tdf_staff_also_playing' }>;
type UnknownWarning = Extract<ResultsWarning, { code: 'tdf_unknown_players' }>;
const staffWarnings = computed(() => warnings.value.filter((w): w is StaffWarning => w.code === 'tdf_staff_also_playing'));
const unknownWarning = computed(() => warnings.value.find((w): w is UnknownWarning => w.code === 'tdf_unknown_players') ?? null);
const otherWarnings = computed(() => warnings.value.filter((w) => w.code !== 'tdf_staff_also_playing' && w.code !== 'tdf_unknown_players'));
const removable = computed(() => staffWarnings.value.filter((w) => w.player.removable).map((w) => w.player));
const confirmLabel = computed(() => uploadButtonLabel(current.value.warnings));
const canSend = computed(
  () => !current.value.needsOrganizerFullName && current.value.fingerprint !== null && !removalId.value && !recheckFailed.value && !busy.value,
);
const players = (n: number) => `${n} ${n === 1 ? 'player' : 'players'}`;

function failed(err: unknown, fallback: string) {
  error.value = apiErrorMessage(err, fallback);
  errorLines.value = notRemovableLines(err);
}

async function saveName() {
  busy.value = true;
  error.value = null;
  try {
    current.value = await $fetch<ResultsPreview>(`${base.value}/organizer`, { method: 'POST', body: { fullName: fullName.value } });
  } catch (err) {
    failed(err, 'Could not save the name.');
  } finally {
    busy.value = false;
  }
}

async function removeFromStaff() {
  if (!removing.value) return;
  busy.value = true;
  error.value = null;
  try {
    const started = await $fetch<{ submissionId: number }>(`${base.value}/remove-staff`, {
      method: 'POST',
      body: { playerIds: removing.value.map((p) => p.playerId) },
    });
    removalId.value = started.submissionId;
  } catch (err) {
    failed(err, 'Could not remove them from staff.');
  } finally {
    busy.value = false;
    removing.value = null;
  }
}

/** After Remove from staff: the checks again, so the warnings shown (and acknowledged) are current. */
async function removalDone() {
  try {
    current.value = await $fetch<ResultsPreview>(`${base.value}/recheck`, { method: 'POST' });
    recheckFailed.value = false;
  } catch (err) {
    recheckFailed.value = true;
    failed(err, 'Could not check the file again.');
  } finally {
    removalId.value = null;
  }
}

async function send() {
  busy.value = true;
  error.value = null;
  try {
    const started = await $fetch<{ submissionId: number }>(`${base.value}/confirm`, {
      method: 'POST',
      body: { importAttendance: importAttendance.value && current.value.attendance !== null, acknowledgedWarnings: current.value.fingerprint },
    });
    submissionId.value = started.submissionId;
  } catch (err) {
    const fresh = staleWarnings(err);
    if (fresh) {
      current.value = { ...current.value, ...fresh };
      stale.value = true;
    } else failed(err, 'Could not start the upload.');
  } finally {
    busy.value = false;
  }
}

function done(view: SubmissionView) {
  finished.value = true;
  const { label, color } = submissionStatus(view.status, view.kind);
  toast.add({ color: color === 'info' ? 'neutral' : color, title: `${props.label}: ${label}` });
  emit('finished');
}
</script>

<template>
  <UModal v-model:open="open" title="Upload results" :description="`${label} · ${dayLabel(current.tournament.date)}`" :dismissible="!submissionId || finished">
    <template #body>
      <TournamentJobProgress v-if="submissionId" :submission-id="submissionId" @finished="done" />
      <div v-else class="space-y-4 text-sm">
        <p class="break-words text-muted">{{ current.file.filename }} · {{ players(current.file.playerCount) }}</p>

        <form v-if="current.needsOrganizerFullName" class="space-y-2" @submit.prevent="saveName">
          <UFormField :label="`${current.needsOrganizerFullName.playToolsName ?? current.needsOrganizerFullName.playerId}’s full name, as it should appear in the TDF`" required>
            <UInput v-model="fullName" maxlength="100" required autocomplete="off" class="w-full" />
          </UFormField>
          <UButton type="submit" :loading="busy" :disabled="!fullName.trim()">Save name</UButton>
        </form>

        <template v-else>
          <UAlert v-if="stale" color="warning" variant="subtle" icon="i-lucide-triangle-alert" title="The warnings changed. Check them again before uploading." />
          <ul v-if="otherWarnings.length" aria-label="Warnings" class="space-y-2">
            <li v-for="(w, i) in otherWarnings" :key="`${w.code}-${i}`" class="flex gap-2">
              <UIcon name="i-lucide-triangle-alert" class="mt-0.5 shrink-0 text-warning" />
              <span class="break-words">{{ w.message }}</span>
            </li>
          </ul>

          <div v-if="staffWarnings.length" class="space-y-2">
            <h3 class="font-medium">Also on staff</h3>
            <ul aria-label="Also on staff" class="divide-y divide-default">
              <li v-for="w in staffWarnings" :key="w.player.playerId" class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <div class="min-w-0 flex-1 basis-40">
                  <span class="break-words">{{ w.player.name || 'No name' }}</span>
                  <span class="ms-2 text-muted tabular-nums">{{ w.player.playerId }}</span>
                  <p class="text-xs text-muted break-words">{{ w.message }}</p>
                </div>
                <UButton
                  v-if="w.player.removable"
                  size="sm"
                  variant="outline"
                  color="neutral"
                  :disabled="!!removalId"
                  :aria-label="`Remove ${w.player.name || w.player.playerId} from staff`"
                  @click="removing = [w.player]"
                >
                  Remove from staff
                </UButton>
                <span v-else class="text-xs text-muted">The organizer’s own record can’t be removed.</span>
              </li>
            </ul>
            <UButton v-if="removable.length >= 2" size="sm" variant="outline" color="neutral" :disabled="!!removalId" @click="removing = removable">
              Remove all from staff ({{ removable.length }})
            </UButton>
            <div v-if="removing" class="space-y-2 rounded-md border border-default p-3">
              <p>
                Remove {{ removing.map((p) => `${p.name || p.playerId} (${roleLabel(p.role, roles)})`).join(', ') }} from this tournament’s staff in play-tools?
              </p>
              <div class="flex flex-wrap gap-2">
                <UButton size="sm" color="error" :loading="busy" @click="removeFromStaff">Remove from staff</UButton>
                <UButton size="sm" variant="ghost" color="neutral" @click="removing = null">Keep them</UButton>
              </div>
            </div>
            <TournamentJobProgress v-if="removalId" :submission-id="removalId" @finished="removalDone" />
          </div>

          <div v-if="unknownWarning" class="space-y-1">
            <h3 class="font-medium">Not in the app yet. Check these ids weren’t mis-keyed in TOM</h3>
            <ul aria-label="Not in the app yet" class="space-y-0.5">
              <li v-for="p in unknownWarning.players" :key="p.playerId" class="break-words">
                {{ p.name || 'No name' }} <span class="text-muted tabular-nums">{{ p.playerId }}</span>
                <span v-if="p.knownAs" class="block text-xs text-muted">A known player with this name has id {{ p.knownAs }}</span>
              </li>
            </ul>
          </div>

          <UCheckbox
            v-if="current.attendance"
            v-model="importAttendance"
            :label="`Also import attendance for ${dayLabel(date)} (${players(current.attendance.players.length)})`"
          />

          <p v-if="current.warnings.length">
            This file has problems. Uploading sends it to play-tools, and Pokémon support receives a copy. If play-tools’ validation fails, it won’t be accepted,
            and Pokémon support usually has to resolve it.
          </p>
          <p v-else>Uploading sends the file to play-tools, and Pokémon support receives a copy.</p>
          <p v-if="again">Sending gives Pokémon support another copy.</p>
        </template>

        <div v-if="error" class="text-error">
          <p>{{ error }}</p>
          <ul v-if="errorLines.length" class="list-disc pl-5">
            <li v-for="line in errorLines" :key="line">{{ line }}</li>
          </ul>
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton variant="ghost" color="neutral" @click="open = false">{{ submissionId ? 'Close' : 'Not now' }}</UButton>
        <UButton v-if="!submissionId && !current.needsOrganizerFullName" :color="current.warnings.length ? 'warning' : 'primary'" :disabled="!canSend" :loading="busy" @click="send">
          {{ confirmLabel }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
