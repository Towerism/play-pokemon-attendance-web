<script setup lang="ts">
import { LoginBody, SetupBody } from '#shared/schemas/auth';

const route = useRoute();
const { fetch: refreshSession } = useUserSession();

const { data: status, refresh: refreshStatus } = await useFetch('/api/auth/setup', { key: 'auth-setup' });
const needsSetup = computed(() => status.value?.needsSetup === true);

const setupState = reactive({ setupCode: '', username: '', password: '' });
const loginState = reactive({ username: '', password: '' });
const error = ref('');
const busy = ref(false);

async function submit(path: '/api/auth/setup' | '/api/auth/login', body: object) {
  error.value = '';
  busy.value = true;
  try {
    await $fetch(path, { method: 'POST', body });
    await refreshSession();
    await navigateTo(authRedirect({ path: '/login', fullPath: route.fullPath, query: route.query }, true));
  } catch (err) {
    const fetchError = err as { statusCode?: number; data?: { message?: string } };
    if (fetchError.statusCode === 409) await refreshStatus();
    // The form state is kept, so the username survives a rate-limit refusal.
    error.value = rateLimitMessage(err) ?? fetchError.data?.message ?? 'Something went wrong. Try again.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="mx-auto max-w-sm pt-8">
    <UCard v-if="needsSetup">
      <template #header>
        <h1 class="text-lg font-semibold">Set up the organizer account</h1>
        <p class="text-sm text-muted mt-1">
          The setup code is in the container log (Unraid: Docker tab → this container → Logs).
        </p>
      </template>
      <UForm :schema="SetupBody" :state="setupState" class="space-y-4" @submit="submit('/api/auth/setup', setupState)">
        <UFormField label="Setup code" name="setupCode">
          <UInput v-model="setupState.setupCode" placeholder="ABCD-EFGH" autocomplete="off" class="w-full" />
        </UFormField>
        <UFormField label="Username" name="username">
          <UInput v-model="setupState.username" autocomplete="username" class="w-full" />
        </UFormField>
        <UFormField label="Password" name="password" help="At least 8 characters">
          <UInput v-model="setupState.password" type="password" autocomplete="new-password" class="w-full" />
        </UFormField>
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />
        <UButton type="submit" block :loading="busy">Create account</UButton>
      </UForm>
    </UCard>

    <UCard v-else>
      <template #header>
        <h1 class="text-lg font-semibold">Log in</h1>
      </template>
      <UForm :schema="LoginBody" :state="loginState" class="space-y-4" @submit="submit('/api/auth/login', loginState)">
        <UFormField label="Username" name="username">
          <UInput v-model="loginState.username" autocomplete="username" class="w-full" />
        </UFormField>
        <UFormField label="Password" name="password">
          <UInput v-model="loginState.password" type="password" autocomplete="current-password" class="w-full" />
        </UFormField>
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />
        <UButton type="submit" block :loading="busy">Log in</UButton>
      </UForm>
    </UCard>
  </div>
</template>
