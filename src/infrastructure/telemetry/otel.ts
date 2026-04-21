import {
  ROOT_CONTEXT,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Attributes,
  type Context,
  type Span,
  type SpanOptions,
} from "@opentelemetry/api";
import { headers, type MsgHdrs } from "nats";

import type { TraceCarrier } from "@/src/ports/trace-carrier";

const tracer = trace.getTracer("minishop");

export function getTracer() {
  return tracer;
}

export function activeTraceId() {
  return trace.getActiveSpan()?.spanContext().traceId;
}

export function injectTraceCarrier(activeContext: Context = context.active()): TraceCarrier {
  const carrier: Record<string, string> = {};
  propagation.inject(activeContext, carrier);

  return {
    ...(carrier.traceparent ? { traceparent: carrier.traceparent } : {}),
    ...(carrier.tracestate ? { tracestate: carrier.tracestate } : {}),
    ...(carrier.baggage ? { baggage: carrier.baggage } : {}),
  };
}

export function extractContextFromTraceCarrier(traceCarrier?: TraceCarrier | null) {
  if (!traceCarrier) {
    return ROOT_CONTEXT;
  }

  const carrier: Record<string, string> = {};

  if (traceCarrier.traceparent) {
    carrier.traceparent = traceCarrier.traceparent;
  }
  if (traceCarrier.tracestate) {
    carrier.tracestate = traceCarrier.tracestate;
  }
  if (traceCarrier.baggage) {
    carrier.baggage = traceCarrier.baggage;
  }

  if (Object.keys(carrier).length === 0) {
    return ROOT_CONTEXT;
  }

  return propagation.extract(ROOT_CONTEXT, carrier);
}

export function injectTraceCarrierToNatsHeaders(
  messageHeaders: MsgHdrs = headers(),
  activeContext: Context = context.active(),
) {
  const traceCarrier = injectTraceCarrier(activeContext);

  if (traceCarrier.traceparent) {
    messageHeaders.set("traceparent", traceCarrier.traceparent);
  }
  if (traceCarrier.tracestate) {
    messageHeaders.set("tracestate", traceCarrier.tracestate);
  }
  if (traceCarrier.baggage) {
    messageHeaders.set("baggage", traceCarrier.baggage);
  }

  return messageHeaders;
}

export function traceCarrierFromNatsHeaders(messageHeaders?: MsgHdrs | null): TraceCarrier | undefined {
  if (!messageHeaders) {
    return undefined;
  }

  const traceparent = messageHeaders.get("traceparent") ?? undefined;
  const tracestate = messageHeaders.get("tracestate") ?? undefined;
  const baggage = messageHeaders.get("baggage") ?? undefined;

  if (!traceparent && !tracestate && !baggage) {
    return undefined;
  }

  return {
    ...(traceparent ? { traceparent } : {}),
    ...(tracestate ? { tracestate } : {}),
    ...(baggage ? { baggage } : {}),
  };
}

export function extractContextFromNatsHeaders(messageHeaders?: MsgHdrs | null) {
  return extractContextFromTraceCarrier(traceCarrierFromNatsHeaders(messageHeaders));
}

export async function withSpan<T>(
  name: string,
  options: SpanOptions,
  fn: (span: Span) => Promise<T>,
  parentContext: Context = context.active(),
) {
  const span = tracer.startSpan(name, options, parentContext);
  const spanContext = trace.setSpan(parentContext, span);

  return await context.with(spanContext, async () => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function setSpanAttributes(span: Span, attributes: Attributes) {
  span.setAttributes(attributes);
}
