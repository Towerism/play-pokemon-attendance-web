import { jsonOnly } from '@towerism/selfhost-kit/nitro';

/**
 * CSRF guard (architecture §9), from the kit: a POST, PUT, PATCH or DELETE
 * under /api that declares a body type must declare JSON, or it gets 415
 * before any handler runs. Cross-site forms and no-cors fetches can only send
 * form, multipart or text bodies.
 */
export default jsonOnly();
