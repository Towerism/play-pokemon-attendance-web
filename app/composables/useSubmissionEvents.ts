import type { SubmissionEvent, SubmissionEventType, SubmissionView } from '../../server/modules/submission/service';

// A Record, so the type checker insists on every event type the server sends.
const LISTENED: Record<SubmissionEventType, true> = {
  planned: true,
  batch_sent: true,
  batch_rejected: true,
  retrying: true,
  reconciled: true,
  finished: true,
  record_removed: true,
};
const TYPES = Object.keys(LISTENED) as SubmissionEventType[];

/**
 * Live progress of a submission (architecture §8): `EventSource` on
 * `/api/submissions/{id}/events`, falling back to polling the submission if
 * the stream drops. `result` is set once the job is over.
 */
export function useSubmissionEvents(id: Ref<number | null>) {
  const events = ref<SubmissionEvent[]>([]);
  const result = ref<SubmissionView | null>(null);
  const latest = computed(() => events.value.at(-1) ?? null);

  let source: EventSource | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;

  function stop() {
    source?.close();
    source = undefined;
    if (poll) clearInterval(poll);
    poll = undefined;
  }

  async function load(submissionId: number) {
    const view = await $fetch<SubmissionView>(`/api/submissions/${submissionId}`);
    if (!isSubmissionActive(view.status)) {
      result.value = view;
      stop();
    }
  }

  function pollUntilDone(submissionId: number) {
    stop();
    poll = setInterval(() => void load(submissionId).catch(() => undefined), 2_000);
  }

  watch(
    id,
    (submissionId) => {
      stop();
      events.value = [];
      result.value = null;
      if (submissionId === null) return;

      source = new EventSource(`/api/submissions/${submissionId}/events`);
      for (const type of TYPES) {
        source.addEventListener(type, (message) => {
          events.value = [...events.value, JSON.parse((message as MessageEvent<string>).data) as SubmissionEvent];
          if (type === 'finished') void load(submissionId);
        });
      }
      // The server ends the stream after `finished`; anything else is a dropped connection.
      source.onerror = () => {
        if (!result.value) pollUntilDone(submissionId);
      };
    },
    { immediate: true },
  );

  onScopeDispose(stop);
  return { events, latest, result };
}
