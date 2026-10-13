<script setup lang="ts">
import { CreateIntegrationTokenBody } from '#shared/schemas/integrations';

// Tokens another app reads this league's days with (#115, ADR-0013): Tournament Genie's import. A token's secret
// is shown once, in the dialog after it is made, and dropped from the page when the dialog closes.

const toast = useToast();
const { data, refresh } = await useFetch('/api/integrations/tokens', { key: 'integration-tokens' });
const tokens = computed(() => data.value?.tokens ?? []);

const state = reactive({ label: '' });
const creating = ref(false);
/** The new token's secret while its dialog is open; null otherwise. */
const secret = ref<string | null>(null);
const open = computed({
  get: () => secret.value !== null,
  set: (v) => {
    if (!v) secret.value = null;
  },
});

const formatDate = (iso: string) => new Date(iso).toLocaleString();

async function create() {
  creating.value = true;
  try {
    const result = await $fetch('/api/integrations/tokens', { method: 'POST', body: CreateIntegrationTokenBody.parse(state) });
    secret.value = result.secret;
    state.label = '';
    await refresh();
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not create the token.') });
  } finally {
    creating.value = false;
  }
}

async function copy() {
  if (!secret.value) return;
  try {
    await navigator.clipboard.writeText(secret.value);
    toast.add({ color: 'success', title: 'Token copied' });
  } catch {
    toast.add({ color: 'warning', title: 'Could not copy. Select the token and copy it yourself.' });
  }
}

async function revoke(token: { id: number; label: string }) {
  if (!window.confirm(`Revoke "${token.label}"? Anything using it stops working at once.`)) return;
  try {
    await $fetch(`/api/integrations/tokens/${token.id}`, { method: 'DELETE' });
    toast.add({ color: 'success', title: `Revoked "${token.label}"` });
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not revoke the token.') });
  } finally {
    await refresh();
  }
}
</script>

<template>
  <UCard as="section" aria-labelledby="integrations-heading">
    <template #header>
      <h2 id="integrations-heading" class="font-semibold">Integrations</h2>
      <p class="text-sm text-muted">
        Tokens that let another app, such as Tournament Genie, read each day's tournaments and staff. They can only read, and only that.
      </p>
    </template>

    <div class="space-y-4">
      <p v-if="tokens.length === 0" class="text-sm text-muted">No integration tokens yet.</p>
      <ul v-else class="divide-y divide-default">
        <li v-for="t in tokens" :key="t.id" class="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
          <div>
            <p class="font-medium">{{ t.label }}</p>
            <p class="font-mono text-muted">{{ t.hint }}</p>
            <p class="text-muted">
              Created {{ formatDate(t.createdAt) }} by {{ t.createdBy }} ·
              {{ t.lastUsedAt ? `Last used ${formatDate(t.lastUsedAt)}` : 'Never used' }}
            </p>
          </div>
          <UButton color="error" variant="soft" size="sm" :aria-label="`Revoke ${t.label}`" @click="revoke(t)">Revoke</UButton>
        </li>
      </ul>

      <UForm :schema="CreateIntegrationTokenBody" :state="state" class="flex flex-wrap items-end gap-2" @submit="create">
        <UFormField name="label" label="Token name" class="min-w-48 flex-1">
          <UInput v-model="state.label" placeholder="Tournament Genie" maxlength="60" class="w-full" />
        </UFormField>
        <UButton type="submit" :loading="creating">Create token</UButton>
      </UForm>
    </div>

    <UModal v-model:open="open" title="Integration token created" description="Paste it into the other app now. It won't be shown again.">
      <template #body>
        <div class="space-y-3">
          <UFormField label="Integration token">
            <UInput :model-value="secret ?? ''" readonly class="w-full font-mono" @focus="($event.target as HTMLInputElement).select()" />
          </UFormField>
          <p class="text-sm text-muted">This app keeps only a fingerprint of it. If it's lost, revoke it and create another.</p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="soft" icon="i-lucide-copy" @click="copy">Copy</UButton>
          <UButton @click="open = false">Done</UButton>
        </div>
      </template>
    </UModal>
  </UCard>
</template>
