import { SubmissionIdParam } from '#shared/schemas/submission';
import type { SubmissionEvent } from '../../../modules/submission/service';

/**
 * Submission progress as server-sent events. Replays what is persisted after
 * `Last-Event-ID`, then streams live until the `finished` event, then ends.
 */
export default defineEventHandler(async (event) => {
  const { leagueId } = await requireMember(event);
  const { id } = await getValidatedRouterParams(event, SubmissionIdParam.parse);
  const submissions = useSubmissions();
  const lastId = Number(getRequestHeader(event, 'last-event-id')) || 0;
  let backlog: SubmissionEvent[];
  try {
    backlog = submissions.events(leagueId, id, lastId);
  } catch (err) {
    return submissionHttpError(err);
  }

  const stream = createEventStream(event);
  let sentId = lastId;
  let ended = false;
  let queue = Promise.resolve();

  const end = () => {
    if (ended) return;
    ended = true;
    unsubscribe();
    void stream.close();
  };

  const push = async (e: SubmissionEvent) => {
    if (ended || e.id <= sentId) return;
    sentId = e.id;
    const status = e.type === 'finished' ? submissions.get(leagueId, id).status : undefined;
    await stream.push({ id: String(e.id), event: e.type, data: JSON.stringify({ ...e, status }) });
    if (e.type === 'finished') end();
  };
  // One ordered queue: the backlog first, live events after, duplicates dropped by id.
  const enqueue = (e: SubmissionEvent) => {
    queue = queue.then(() => push(e)).catch(end);
  };

  const unsubscribe = submissions.subscribe(id, enqueue);
  stream.onClosed(end);
  backlog.forEach(enqueue);
  // Already over (e.g. resuming after the `finished` event): nothing more will come.
  queue = queue.then(() => {
    if (!['planned', 'running'].includes(submissions.get(leagueId, id).status) && !ended) end();
  });

  return stream.send();
});
