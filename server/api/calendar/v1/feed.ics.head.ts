/** `HEAD` of the calendar feed: h3 routes `HEAD` only to a handler for it, so it answers here like `GET`, without the body. */
export default defineEventHandler((event) => answerCalendarFeed(event, () => requireCalendarFeed(event)));
