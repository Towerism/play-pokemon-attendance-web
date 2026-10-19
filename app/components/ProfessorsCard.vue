<script setup lang="ts">
import type { Delivery, Membership, Recipient } from '~/utils/professors';

// Settings → Professors, for the owner (ADR-0015 §6, §8): who has joined, open invites and reset links, and the
// actions on them. A link to copy is shown once, in its dialog, and dropped when the dialog closes.

interface InviteJson {
  id: number;
  kind: 'invite' | 'reset';
  label: string | null;
  playerId: string | null;
  username: string | null;
  hint: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  delivery: Delivery | null;
}
interface ProfessorJson {
  userId: number;
  username: string;
  createdAt: string;
  lastSignInAt: string | null;
  reverifyRequired: boolean;
  connection: null | { playerId: string | null; name: string | null; status: 'connected' | 'needs_reconnect'; membership: Membership; claimedAt: string | null };
}
interface ProfessorsJson {
  professors: ProfessorJson[];
  invites: InviteJson[];
  seats: { used: number; max: number };
  genie: { available: boolean };
}
interface Minted {
  invite: InviteJson;
  secret?: string;
  link?: string | null;
}

const toast = useToast();
const siteUrl = useRuntimeConfig().public.siteUrl;
const { data, refresh } = await useFetch<ProfessorsJson>('/api/professors', { key: 'professors' });
const formatDate = (iso: string) => new Date(iso).toLocaleString();

// While an invite is still being delivered, read the list again every few seconds, for a while.
let readingSince = 0;
let timer: ReturnType<typeof setInterval> | undefined;
function watchSending() {
  readingSince = Date.now();
  clearInterval(timer);
  timer = setInterval(() => {
    if (!keepReading(data.value?.invites ?? [], readingSince, Date.now())) return clearInterval(timer);
    void refresh();
  }, READ_INTERVAL_MS);
}
onScopeDispose(() => clearInterval(timer));

/** The dialog: minting an invite, or a reset link for one professor. */
const dialog = reactive({
  open: false,
  /** The professor a reset link is for; null for an invite. */
  forProfessor: null as ProfessorJson | null,
  label: '',
  recipient: null as Recipient | null,
  busy: false,
  /** The link to copy, once minted. */
  link: null as { url: string; localOnly: boolean } | null,
  refusal: null as string | null,
});

function openInvite() {
  Object.assign(dialog, { open: true, forProfessor: null, label: '', recipient: null, link: null, refusal: null });
}
function openReset(p: ProfessorJson) {
  const recipient = p.connection?.playerId ? { playerId: p.connection.playerId, name: p.connection.name ?? p.username, player: false, known: true } : null;
  Object.assign(dialog, { open: true, forProfessor: p, label: '', recipient, link: null, refusal: null });
}
watch(
  () => dialog.open,
  (open) => {
    if (!open) dialog.link = null;
  },
);

const title = computed(() => (dialog.forProfessor ? `Reset ${dialog.forProfessor.username}'s password` : 'Invite a professor'));
const discordReason = computed(() =>
  dialog.forProfessor
    ? (resetDiscordDisabled(dialog.forProfessor) ?? discordDisabledReason({ recipient: dialog.recipient, genieAvailable: data.value?.genie.available ?? false, siteUrl }))
    : discordDisabledReason({ recipient: dialog.recipient, genieAvailable: data.value?.genie.available ?? false, siteUrl }),
);

const mintUrl = () => (dialog.forProfessor ? `/api/professors/${dialog.forProfessor.userId}/reset-link` : '/api/professors/invites');
const mintBody = (send: 'copy' | 'discord') =>
  dialog.forProfessor ? { send } : { send, ...(dialog.label.trim() ? { label: dialog.label.trim() } : {}), ...(dialog.recipient ? { playerId: dialog.recipient.playerId } : {}) };

async function copyLink() {
  dialog.busy = true;
  dialog.refusal = null;
  try {
    const minted = await $fetch<Minted>(mintUrl(), { method: 'POST', body: mintBody('copy') });
    dialog.link = inviteLink({ secret: minted.secret!, link: minted.link ?? null }, window.location.origin);
    await refresh();
  } catch (err) {
    dialog.refusal = apiErrorMessage(err, 'Could not make the link.');
  } finally {
    dialog.busy = false;
  }
}

async function sendByDiscord() {
  const recipient = dialog.recipient!;
  const question = dialog.forProfessor ? null : recipientConfirm(recipient);
  if (question && !window.confirm(question)) return;
  dialog.busy = true;
  dialog.refusal = null;
  try {
    const res = await $fetch.raw<Minted>(mintUrl(), { method: 'POST', body: mintBody('discord') });
    const outcome = sendOutcome({ status: res.status }, recipient);
    toast.add({ color: outcome.kind === 'sent' ? 'success' : 'info', title: outcome.text });
    dialog.open = false;
    if (outcome.kind === 'sending') watchSending();
  } catch (err) {
    const e = err as { statusCode?: number; data?: { data?: { code?: string } } };
    if (e.statusCode === 422 || e.statusCode === 503) dialog.refusal = sendOutcome({ status: e.statusCode, code: e.data?.data?.code }, recipient).text;
    else dialog.refusal = apiErrorMessage(err, 'Could not send the link.');
  } finally {
    dialog.busy = false;
    await refresh();
  }
}

async function copyToClipboard() {
  if (!dialog.link) return;
  try {
    await navigator.clipboard.writeText(dialog.link.url);
    toast.add({ color: 'success', title: 'Link copied' });
  } catch {
    toast.add({ color: 'warning', title: 'Could not copy. Select the link and copy it yourself.' });
  }
}

async function revoke(i: InviteJson) {
  const what = i.kind === 'reset' ? `the reset link for ${i.username}` : `the invite ${i.label ?? i.hint}`;
  if (!window.confirm(`Revoke ${what}? The link stops working at once.`)) return;
  try {
    await $fetch(`/api/professors/invites/${i.id}`, { method: 'DELETE' });
    toast.add({ color: 'success', title: 'Link revoked' });
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not revoke the link.') });
  } finally {
    await refresh();
  }
}

async function remove(p: ProfessorJson) {
  if (!window.confirm(`Remove ${p.username}? This disconnects their Pokémon account and they can no longer sign in. Their history stays.`)) return;
  try {
    await $fetch(`/api/professors/${p.userId}`, { method: 'DELETE' });
    toast.add({ color: 'success', title: `Removed ${p.username}` });
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not remove the professor.') });
  } finally {
    await refresh();
  }
}

const inviteName = (i: InviteJson) => (i.kind === 'reset' ? `Password reset for ${i.username}` : (i.label ?? 'Invite'));
</script>

<template>
  <UCard as="section" aria-labelledby="professors-heading">
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="professors-heading" class="font-semibold">Professors</h2>
          <p class="text-sm text-muted">Everyone who helps run the league signs in as themselves and connects their own Pokémon account.</p>
        </div>
        <UButton icon="i-lucide-user-plus" @click="openInvite">Invite professor</UButton>
      </div>
    </template>

    <div v-if="data" class="space-y-4">
      <p class="text-sm text-muted">{{ seatsText(data.seats) }}</p>

      <p v-if="data.professors.length === 0" class="text-sm text-muted">No professors yet.</p>
      <ul v-else class="divide-y divide-default">
        <li v-for="p in data.professors" :key="p.userId" class="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
          <div>
            <p class="font-medium">{{ professorRowLabel(p) }}</p>
            <p class="text-muted">
              <template v-if="p.connection">
                {{ membershipLabel(p.connection.membership) }} ·
                {{ p.connection.status === 'connected' ? 'Connected' : 'Needs a reconnect' }} ·
              </template>
              <template v-else>No Pokémon account connected · </template>
              {{ signInText(p.lastSignInAt, formatDate) }}
            </p>
            <p v-if="p.reverifyRequired" class="text-warning">Must confirm their Pokémon login</p>
            <p v-if="claimedText(p.connection?.claimedAt ?? null, formatDate)" class="text-muted">
              {{ claimedText(p.connection?.claimedAt ?? null, formatDate) }}
            </p>
          </div>
          <div class="flex gap-2">
            <UButton size="sm" variant="soft" :aria-label="`Reset password for ${p.username}`" @click="openReset(p)">Reset password</UButton>
            <UButton size="sm" color="error" variant="soft" :aria-label="`Remove ${p.username}`" @click="remove(p)">Remove</UButton>
          </div>
        </li>
      </ul>

      <div v-if="data.invites.length">
        <h3 class="text-sm font-medium">Open links</h3>
        <ul class="divide-y divide-default">
          <li v-for="i in data.invites" :key="i.id" class="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <div>
              <p class="font-medium">{{ inviteName(i) }}</p>
              <p class="text-muted">
                <span v-if="i.playerId" class="font-mono">{{ i.playerId }} · </span>
                Minted by {{ i.createdBy }} · Expires {{ formatDate(i.expiresAt) }}
                <template v-if="deliveryLabel(i.delivery)"> · {{ deliveryLabel(i.delivery) }}</template>
              </p>
            </div>
            <UButton size="sm" color="error" variant="soft" :aria-label="`Revoke ${inviteName(i)}`" @click="revoke(i)">Revoke</UButton>
          </li>
        </ul>
      </div>
    </div>

    <UModal v-model:open="dialog.open" :title="title" :description="dialog.link ? 'Send it any way you like. It works once, for 72 hours, and won\'t be shown again.' : undefined">
      <template #body>
        <div v-if="dialog.link" class="space-y-3">
          <UFormField :label="dialog.forProfessor ? 'Reset link' : 'Invite link'">
            <UInput :model-value="dialog.link.url" readonly class="w-full font-mono" @focus="($event.target as HTMLInputElement).select()" />
          </UFormField>
          <p v-if="dialog.link.localOnly" class="text-sm text-muted">
            This link uses the address you opened the app with, so it only works where that address does.
          </p>
        </div>
        <div v-else class="space-y-4">
          <template v-if="!dialog.forProfessor">
            <UFormField label="Label" hint="Optional, only you see it">
              <UInput v-model="dialog.label" maxlength="60" placeholder="e.g. their Discord name" class="w-full" />
            </UFormField>
            <RecipientSearch v-model="dialog.recipient" />
          </template>
          <p v-else class="text-sm text-muted">
            The link lets {{ dialog.forProfessor.username }} choose a new password. They then log in to Pokémon again to confirm it's them.
          </p>
          <UAlert v-if="dialog.refusal" color="error" variant="subtle" :title="dialog.refusal" />
          <p v-if="discordReason" class="text-sm text-muted" data-testid="discord-reason">{{ discordReason }}</p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <template v-if="dialog.link">
            <UButton variant="soft" icon="i-lucide-copy" @click="copyToClipboard">Copy</UButton>
            <UButton @click="dialog.open = false">Done</UButton>
          </template>
          <template v-else>
            <UButton variant="soft" :loading="dialog.busy" @click="copyLink">Copy link</UButton>
            <UButton :disabled="discordReason !== null" :loading="dialog.busy" icon="i-lucide-send" @click="sendByDiscord">Send by Discord</UButton>
          </template>
        </div>
      </template>
    </UModal>
  </UCard>
</template>
