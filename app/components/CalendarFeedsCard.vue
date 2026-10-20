<script setup lang="ts">
// Calendar feeds (ADR-0016 §6): every member's own feed, and the owner's public feed, to subscribe to in a calendar app.
// A new link is shown once, in the dialog after it is made, and dropped from the page when the dialog closes; after
// that only its hint shows.

const props = defineProps<{ isOwner: boolean }>();
const toast = useToast();
const { data, refresh } = await useFetch('/api/calendar-feeds', { key: 'calendar-feeds' });

type Kind = 'public' | 'user';
interface Minted {
  kind: Kind;
  url: string;
  webcalUrl: string;
  reach: CalendarReach;
}

const feeds = computed(() => {
  const rows: { kind: Kind; title: string; about: string; feed: { hint: string; createdAt: string; lastReadAt: string | null } | null }[] = [
    { kind: 'user', title: 'Your tournaments', about: 'The tournaments you organize, staff or were lent, and the ones you have planned.', feed: data.value?.me ?? null },
  ];
  if (props.isOwner) {
    rows.push({ kind: 'public', title: 'Public feed', about: "The league's tournaments and play sessions, for players. Anyone with the link can subscribe.", feed: data.value?.public ?? null });
  }
  return rows;
});
const stale = computed(() => data.value?.snapshot.staleSources ?? []);
const timeZone = computed(() => data.value?.timeZone ?? 'UTC');

const busy = ref<Kind | null>(null);
/** The new link while its dialog is open; null otherwise. */
const minted = ref<Minted | null>(null);
const open = computed({
  get: () => minted.value !== null,
  set: (v) => {
    if (!v) minted.value = null;
  },
});

const formatDate = (iso: string) => new Date(iso).toLocaleString();
// A plain string: Nuxt's typed routes can't compare a union of two literal routes.
const path = (kind: Kind): string => (kind === 'public' ? '/api/calendar-feeds/public' : '/api/calendar-feeds/me');

async function mint(kind: Kind, rotating: boolean) {
  if (rotating && !window.confirm(confirmText(kind, 'rotate'))) return;
  busy.value = kind;
  try {
    minted.value = await $fetch<Minted>(path(kind), { method: 'POST' });
    await refresh();
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not make the calendar link.') });
  } finally {
    busy.value = null;
  }
}

async function turnOff(kind: Kind) {
  if (!window.confirm(confirmText(kind, 'off'))) return;
  busy.value = kind;
  try {
    await $fetch<null>(path(kind), { method: 'DELETE' });
    toast.add({ color: 'success', title: kind === 'public' ? 'Public feed turned off' : 'Your feed turned off' });
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not turn the feed off.') });
  } finally {
    busy.value = null;
    await refresh();
  }
}

async function copy() {
  if (!minted.value) return;
  try {
    await navigator.clipboard.writeText(minted.value.url);
    toast.add({ color: 'success', title: 'Link copied' });
  } catch {
    toast.add({ color: 'warning', title: 'Could not copy. Select the link and copy it yourself.' });
  }
}
</script>

<template>
  <UCard as="section" aria-labelledby="calendar-heading">
    <template #header>
      <h2 id="calendar-heading" class="font-semibold">Calendar</h2>
      <p class="text-sm text-muted">
        Links to subscribe to in Google Calendar, Apple Calendar or Outlook. They update about once an hour; a calendar app may
        take longer to fetch them.
      </p>
    </template>

    <div class="space-y-4">
      <ul class="divide-y divide-default">
        <li v-for="row in feeds" :key="row.kind" class="flex flex-wrap items-center justify-between gap-2 py-2 text-sm" :data-feed="row.kind">
          <div>
            <p class="font-medium">{{ row.title }}</p>
            <p class="text-muted">{{ row.about }}</p>
            <template v-if="row.feed">
              <p class="font-mono text-muted">{{ row.feed.hint }}</p>
              <p class="text-muted">
                Made {{ formatDate(row.feed.createdAt) }} ·
                {{ row.feed.lastReadAt ? `Last fetched ${formatDate(row.feed.lastReadAt)}` : 'Not fetched yet' }}
              </p>
            </template>
            <p v-else class="text-muted">Off</p>
          </div>
          <div class="flex gap-2">
            <UButton v-if="!row.feed" size="sm" :loading="busy === row.kind" :aria-label="`Turn on ${row.title}`" @click="mint(row.kind, false)">
              Turn on
            </UButton>
            <template v-else>
              <UButton size="sm" variant="soft" :loading="busy === row.kind" :aria-label="`Rotate link of ${row.title}`" @click="mint(row.kind, true)">
                Rotate link
              </UButton>
              <UButton size="sm" color="error" variant="soft" :aria-label="`Turn off ${row.title}`" @click="turnOff(row.kind)">Turn off</UButton>
            </template>
          </div>
        </li>
      </ul>

      <p class="text-sm text-muted">
        {{ data?.snapshot.builtAt ? `Events as of ${formatDate(data.snapshot.builtAt)}.` : 'No events read yet; turning a feed on reads them.' }}
      </p>
      <UAlert
        v-if="stale.length > 0"
        color="warning"
        variant="soft"
        title="Some events can't be confirmed"
      >
        <template #description>
          <p>Calendars keep these events, marked as not confirmed, until the professor reconnects or the events pass.</p>
          <ul class="mt-1 list-disc pl-5">
            <li v-for="s in stale" :key="s.key">{{ staleText(s, timeZone) }}</li>
          </ul>
        </template>
      </UAlert>
    </div>

    <UModal v-model:open="open" title="Calendar link" description="Subscribe to it now, or copy it somewhere safe. It won't be shown again.">
      <template #body>
        <div v-if="minted" class="space-y-3">
          <UFormField label="Calendar link">
            <UInput :model-value="minted.url" readonly class="w-full font-mono" @focus="($event.target as HTMLInputElement).select()" />
          </UFormField>
          <p class="text-sm">{{ reachText(minted.reach) }}</p>
          <p class="text-sm text-muted">
            Anyone with this link can see the feed. If it reaches the wrong people, rotate it here and subscribe again.
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <UButton v-if="minted" variant="soft" icon="i-lucide-calendar-plus" :href="minted.webcalUrl" external>Open in calendar app</UButton>
          <UButton variant="soft" icon="i-lucide-copy" @click="copy">Copy</UButton>
          <UButton @click="open = false">Done</UButton>
        </div>
      </template>
    </UModal>
  </UCard>
</template>
