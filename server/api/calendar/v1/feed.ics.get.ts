/**
 * A subscribed calendar feed (ADR-0016 §4): `?token=ppa_cal_…` is its only credential. Calendar apps fetch it from
 * their own servers; it never calls play-tools. A refusal is an empty 404 (gone for good), 503 (try later) or 429.
 */
export default defineEventHandler((event) => answerCalendarFeed(event, () => requireCalendarFeed(event)));
