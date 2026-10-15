import { notImplemented } from '../_shared/not-implemented.ts';

// TODO: JWT verification, owner-scoped routing, runtime schemas, CORS allowlist.
// create/get/update/start/cancel/publish/export must not trust client owner/checks/status fields.
Deno.serve(() => notImplemented('mission-api'));
