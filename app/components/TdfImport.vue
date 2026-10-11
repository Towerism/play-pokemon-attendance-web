<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui';
import type { TdfCommitResult, TdfPlayerStatus, TdfPreview } from '../../server/modules/sessions/tdf-import';

const props = defineProps<{ date: string }>();
const emit = defineEmits<{ imported: [] }>();
const toast = useToast();

const file = ref<File | null>(null);
const preview = ref<TdfPreview | null>(null);
const open = ref(false);
const reading = ref(false);
const committing = ref(false);

const dateWarning = computed(() => preview.value && tdfDateWarning(preview.value.tournament.date, props.date));

const STATUS: Record<TdfPlayerStatus, { label: string; color: 'primary' | 'neutral' | 'info' | 'success' }> = {
  new: { label: 'New', color: 'primary' },
  known: { label: 'Known', color: 'info' },
  regular: { label: 'Regular', color: 'success' },
  listed: { label: 'Already listed', color: 'neutral' },
};

type PreviewPlayer = TdfPreview['players'][number];
const columns: TableColumn<PreviewPlayer>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'playerId', header: 'Player ID' },
  { accessorKey: 'status', header: '' },
];

watch(file, async (picked) => {
  if (!picked) return;
  reading.value = true;
  try {
    const read = await readTdfFile(picked);
    if (!read.ok) {
      toast.add({ color: 'error', title: read.error });
      return;
    }
    const url: string = `/api/sessions/${props.date}/tdf`;
    preview.value = await $fetch<TdfPreview>(url, { method: 'POST', body: read.value });
    open.value = true;
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, `Could not read ${picked.name}.`) });
  } finally {
    reading.value = false;
    file.value = null;
  }
});

async function commit() {
  if (!preview.value) return;
  committing.value = true;
  try {
    const url: string = `/api/sessions/${props.date}/tdf/${preview.value.uploadId}/commit`;
    const result = await $fetch<TdfCommitResult>(url, { method: 'POST', body: {} });
    toast.add({ color: 'success', title: `Imported ${preview.value.filename}`, description: tdfCommitSummary(result) });
    open.value = false;
    emit('imported');
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not import the file.') });
  } finally {
    committing.value = false;
  }
}
</script>

<template>
  <div>
    <UFileUpload
      v-model="file"
      accept=".tdf,.xml"
      icon="i-lucide-file-up"
      label="Drop a tournament file (.tdf)"
      description="Its players become session players for this date. You'll see a preview first."
      :disabled="reading"
      class="w-full min-h-28"
    />

    <UModal v-model:open="open" :title="preview?.tournament.name ?? preview?.filename ?? 'Tournament file'" :description="`Import into ${date}`">
      <template #body>
        <div v-if="preview" class="space-y-4">
          <UAlert v-if="dateWarning" color="warning" variant="subtle" icon="i-lucide-calendar-x" :title="dateWarning" />
          <UAlert
            v-if="preview.alreadyImported"
            color="info"
            variant="subtle"
            icon="i-lucide-info"
            title="This file was already imported for this date."
          />
          <p class="text-sm">{{ tdfPreviewSummary(preview.counts) }}</p>
          <UTable :data="preview.players" :columns="columns" class="max-h-80">
            <template #name-cell="{ row }">
              <span :class="{ 'text-muted italic': !row.original.name }">{{ row.original.name || 'No name' }}</span>
            </template>
            <template #status-cell="{ row }">
              <UBadge variant="subtle" :color="STATUS[row.original.status].color">{{ STATUS[row.original.status].label }}</UBadge>
            </template>
          </UTable>
          <div v-if="preview.invalid.length" class="text-sm">
            <p class="font-medium">Skipped rows</p>
            <ul class="text-muted">
              <li v-for="(row, i) in preview.invalid" :key="i">{{ row.name || 'No name' }}: {{ row.reason }}</li>
            </ul>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="open = false">Cancel</UButton>
          <!-- Even with nobody new, importing records who attended (sightings). -->
          <UButton v-if="!preview?.alreadyImported" icon="i-lucide-download" :loading="committing" @click="commit">Import</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
