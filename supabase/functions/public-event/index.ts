import { notImplemented } from '../_shared/not-implemented.ts';

// TODO: published-field allowlist, rate limits, signup idempotency + seat transaction.
// Never return MissionState, private files or registration lists through this public endpoint.
Deno.serve(() => notImplemented('public-event'));
