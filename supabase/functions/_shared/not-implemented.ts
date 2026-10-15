import type { ApiResult } from '../../../mission/contracts.ts';

export function notImplemented(area: string): Response {
  const body = {
    ok: false,
    error: {
      code: 'NOT_IMPLEMENTED',
      message: `${area} is a scaffold. No database or provider operation was performed.`,
      retryable: false,
      requiredUserAction: 'Implement auth, validation and transactions before enabling this endpoint.',
    },
  } satisfies ApiResult<never>;
  return Response.json(body, { status: 501, headers: { 'Cache-Control': 'no-store' } });
}
