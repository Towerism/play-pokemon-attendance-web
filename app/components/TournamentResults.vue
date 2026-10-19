<script setup lang="ts">
import type { ResultsPreview, ResultsSection } from '../../server/modules/tournaments/results';
import type { StaffRole } from '~/utils/staff';

/**
 * A tournament card's **Results** section (ADR-0011 decision 1): play-tools' state from a fresh read as the organizer,
 * the latest upload, a dropzone while play-tools takes an upload, **Upload again…**, and **Download TDF** once the app
 * holds the file. Read in the browser only and never retried on its own.
 */
/** `readonly`: another user holds the organizer's connection (ADR-0015 §4); only Download TDF stays. */
const props = defineProps<{ date: string; tournamentId: string; label: string; displayId: string | null; roles?: readonly StaffRole[]; readonly?: boolean }>();
/** An upload job ended: the date's attendance may have been imported. */
const emit = defineEmits<{ uploaded: [] }>();
const toast = useToast();

const url = computed(() => `/api/sessions/${props.date}/tournaments/${props.tournamentId}/results`);
const { data, error, status, refresh } = useFetch<ResultsSection>(url, {
  key: computed(() => `results-${props.date}-${props.tournamentId}`),
  server: false,
  lazy: true,
  retry: false,
});
const view = computed(() => {
  const v = data.value ? resultsView(data.value) : null;
  return v && props.readonly ? { ...v, drop: false, again: false, review: false } : v;
});

const headingId = useId();
const file = ref<File | null>(null);
const reading = ref(false);
const dialog = ref<{ preview: ResultsPreview; again: boolean } | null>(null);
const downloading = ref(false);
const downloadTdf = useTdfDownload();

watch(file, async (picked) => {
  if (!picked) return;
  reading.value = true;
  try {
    const read = await readTdfFile(picked);
    if (!read.ok) {
      toast.add({ color: 'error', title: read.error });
      return;
    }
    dialog.value = { preview: await $fetch<ResultsPreview>(url.value, { method: 'POST', body: read.value }), again: false };
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, `Could not read ${picked.name}.`) });
    await refresh();
  } finally {
    reading.value = false;
    file.value = null;
  }
});

/** **Upload again…** and **Review upload…**: the checks again from the archived file, then the same dialog. */
async function recheck(again: boolean) {
  const latest = data.value?.latest;
  if (!latest) return;
  reading.value = true;
  try {
    dialog.value = { preview: await $fetch<ResultsPreview>(`${url.value}/${latest.uploadId}/recheck`, { method: 'POST' }), again };
  } catch (err) {
    const deleted = apiErrorCode(err) === 'tdf_file_deleted';
    toast.add({ color: 'error', title: deleted ? 'The file was deleted. Drop it again to upload.' : apiErrorMessage(err, 'Could not check the file again.') });
    await refresh();
  } finally {
    reading.value = false;
  }
}

async function download() {
  downloading.value = true;
  try {
    await downloadTdf(props.tournamentId, props.displayId);
  } finally {
    downloading.value = false;
  }
}

async function uploaded() {
  emit('uploaded');
  await refresh();
}

async function closed() {
  dialog.value = null;
  await refresh();
}
</script>

<template>
  <section :aria-labelledby="headingId" class="space-y-2">
    <h4 :id="headingId" class="font-medium">Results</h4>
    <p v-if="status === 'pending' && !data" role="status" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-lucide-loader-circle" class="animate-spin" /> Reading results…
    </p>
    <div v-else-if="error" class="flex flex-wrap items-center gap-2 text-sm text-error">
      <span>{{ apiErrorMessage(error, 'Could not read the results from play-tools.') }}</span>
      <UButton size="sm" variant="outline" color="neutral" icon="i-lucide-refresh-cw" :aria-label="`Try again: results for ${label}`" @click="refresh()">
        Try again
      </UButton>
    </div>
    <template v-else-if="view">
      <p class="flex flex-wrap items-center gap-2 text-sm">
        <span class="break-words">{{ view.status.text }}</span>
        <NuxtLink v-if="view.status.settings" to="/settings" class="underline">Open Settings</NuxtLink>
        <UButton v-if="view.status.retry" size="sm" variant="outline" color="neutral" icon="i-lucide-refresh-cw" :aria-label="`Try again: results for ${label}`" @click="refresh()">
          Try again
        </UButton>
      </p>

      <div v-if="view.latest" class="space-y-1 text-sm">
        <p class="flex flex-wrap items-center gap-2">
          <span class="text-muted">Latest upload:</span>
          <UBadge variant="subtle" :color="view.latest.color">{{ view.latest.label }}</UBadge>
          <NuxtLink v-if="view.latest.details" :to="`/history/${view.latest.details}`" class="underline">Details</NuxtLink>
        </p>
        <ul v-if="view.latest.lines.length" class="space-y-0.5">
          <li v-for="line in view.latest.lines" :key="line" class="break-words">{{ line }}</li>
        </ul>
        <p v-if="view.fileDeleted">The file was deleted. Drop it again to upload.</p>
      </div>

      <p v-if="view.noCopy" class="text-sm text-muted">Results are in play-tools. This app has no copy of the TDF.</p>

      <div v-if="view.again || view.review || view.download" class="flex flex-wrap gap-2">
        <UButton v-if="view.again" size="sm" variant="outline" :loading="reading" :aria-label="`Upload again… ${label}`" @click="recheck(true)">Upload again…</UButton>
        <UButton v-if="view.review" size="sm" variant="outline" :loading="reading" :aria-label="`Review upload… ${label}`" @click="recheck(false)">Review upload…</UButton>
        <UButton
          v-if="view.download"
          size="sm"
          variant="outline"
          color="neutral"
          icon="i-lucide-download"
          :loading="downloading"
          :aria-label="`Download TDF ${label}`"
          @click="download"
        >
          Download TDF
        </UButton>
      </div>

      <UFileUpload
        v-if="view.drop"
        v-model="file"
        accept=".tdf,.xml"
        icon="i-lucide-file-up"
        label="Drop the tournament's .tdf"
        description="Results go to play-tools only after a preview and your confirm. Attendance can be imported from the same file."
        :aria-label="`Drop the TDF for ${label}`"
        :disabled="reading"
        class="w-full min-h-24"
      />
    </template>

    <ResultsUploadDialog
      v-if="dialog"
      :date="date"
      :tournament-id="tournamentId"
      :label="label"
      :preview="dialog.preview"
      :roles="roles"
      :again="dialog.again"
      @finished="uploaded"
      @close="closed"
    />
  </section>
</template>
