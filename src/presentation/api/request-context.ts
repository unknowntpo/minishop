import type { NextRequest } from "next/server";

export type RequestContext = {
  requestId: string;
  traceId: string;
};

export function getRequestContext(request: NextRequest): RequestContext {
  const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
  const traceId = request.headers.get("x-trace-id")?.trim() || requestId;

  return {
    requestId,
    traceId,
  };
}

export function logApiError(message: string, context: RequestContext, error: unknown) {
  console.error(message, {
    requestId: context.requestId,
    traceId: context.traceId,
    error,
  });
}

export function apiErrorBody(message: string, context: RequestContext) {
  return {
    error: message,
    requestId: context.requestId,
  };
}
