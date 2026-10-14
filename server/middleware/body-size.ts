import { bodySizeLimit } from '@towerism/selfhost-kit/nitro';

/**
 * Request size limit (architecture §9), from the kit: a POST, PUT, PATCH or
 * DELETE /api body over 2 MiB is refused by its `Content-Length` (413) before
 * it is read, and one sent without a length (chunked) gets 411. The TDF
 * preview route has its own, larger limit (and its own 411/413), so it is
 * left alone here.
 */
const TDF_PREVIEW = /^\/api\/sessions\/[^/]+\/tdf\/?(?:\?|$)/;

export default bodySizeLimit({ maxBytes: 2 * 1024 * 1024, exempt: [TDF_PREVIEW] });
