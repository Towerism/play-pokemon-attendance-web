<script setup lang="ts">
import { InviteAcceptBody } from '#shared/schemas/professors';

// Accepting an invite or a password reset link (ADR-0015 §6, §8). Public: the secret is read from the URL fragment,
// which browsers never send to a server, and dropped from the address bar at once.

definePageMeta({ layout: false });
useHead({ title: 'Join the league' });

interface InviteCheck {
  kind: 'invite' | 'reset';
  label: string | null;
  leagueName: string | null;
  expiresAt: string;
  username: string | null;
}

const { loggedIn, user, clear, fetch: refreshSession } = useUserSession();
const secret = ref<string | null>(null);
const invite = ref<InviteCheck | null>(null);
const invalid = ref(false);
const state = reactive({ username: '', password: '', confirm: '' });
const busy = ref(false);
const failure = ref<string | null>(null);

onMounted(async () => {
  secret.value = secretFromHash(window.location.hash);
  // The secret leaves the address bar and the history entry at once.
  window.history.replaceState(window.history.state, '', '/invite');
  if (loggedIn.value) return;
  if (!secret.value) {
    invalid.value = true;
    return;
  }
  try {
    invite.value = await $fetch<InviteCheck>('/api/invites/check', { method: 'POST', body: { secret: secret.value } });
  } catch {
    invalid.value = true;
  }
});

const mismatch = computed(() => state.confirm !== '' && state.confirm !== state.password);

async function accept() {
  if (!secret.value || !invite.value) return;
  failure.value = null;
  if (state.password !== state.confirm) {
    failure.value = 'The two passwords differ.';
    return;
  }
  const body = invite.value.kind === 'invite' ? { secret: secret.value, username: state.username, password: state.password } : { secret: secret.value, password: state.password };
  const parsed = InviteAcceptBody.safeParse(body);
  if (!parsed.success) {
    failure.value = parsed.error.issues[0]?.message ?? 'Check the form.';
    return;
  }
  busy.value = true;
  try {
    await $fetch('/api/invites/accept', { method: 'POST', body: parsed.data });
    secret.value = null;
    await refreshSession();
    await navigateTo('/settings');
  } catch (err) {
    failure.value = apiErrorMessage(err, 'Could not accept the link.');
  } finally {
    busy.value = false;
  }
}

async function logOut() {
  await $fetch('/api/auth/logout', { method: 'POST' });
  await clear();
}
</script>

<template>
  <main class="mx-auto max-w-md space-y-6 px-4 py-10">
    <h1 class="text-xl font-semibold">Play! Pokémon Attendance</h1>

    <UAlert v-if="loggedIn" color="warning" variant="subtle" :title="signedInText(user?.username ?? 'someone')">
      <template #actions>
        <UButton size="sm" @click="logOut">Log out</UButton>
      </template>
    </UAlert>

    <UAlert v-else-if="invalid" color="error" variant="subtle" :title="INVALID_LINK" />

    <UCard v-else-if="invite">
      <template #header>
        <h2 v-if="invite.kind === 'invite'" class="font-semibold">You're invited to help run {{ invite.leagueName ?? 'the league' }}</h2>
        <h2 v-else class="font-semibold">Set a new password for {{ invite.username }}</h2>
        <p v-if="invite.label" class="text-sm text-muted">{{ invite.label }}</p>
        <p class="text-sm text-muted">This link works once, until {{ new Date(invite.expiresAt).toLocaleString() }}.</p>
      </template>
      <form class="space-y-4" @submit.prevent="accept">
        <UFormField v-if="invite.kind === 'invite'" label="Username" hint="Letters, digits, dots, dashes and underscores">
          <UInput v-model="state.username" autocomplete="username" class="w-full" />
        </UFormField>
        <UFormField label="Password" hint="At least 8 characters">
          <UInput v-model="state.password" type="password" autocomplete="new-password" class="w-full" />
        </UFormField>
        <UFormField label="Confirm password" :error="mismatch ? 'The two passwords differ.' : undefined">
          <UInput v-model="state.confirm" type="password" autocomplete="new-password" class="w-full" />
        </UFormField>
        <UAlert v-if="failure" color="error" variant="subtle" :title="failure" />
        <UButton type="submit" block :loading="busy">{{ invite.kind === 'invite' ? 'Create account' : 'Set password' }}</UButton>
      </form>
    </UCard>

    <p v-else class="text-sm text-muted">Checking the link…</p>
  </main>
</template>
