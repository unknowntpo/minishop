import { isEventMetadataJson } from "@/src/domain/schema-rules";
import type { TraceCarrier } from "@/src/ports/trace-carrier";

export type EventMetadata = TraceCarrier & {
  request_id: string;
  trace_id: string;
  source: "web" | "api" | "worker" | "benchmark";
  actor_id: string;
};

export function isEventMetadata(value: unknown): value is EventMetadata {
  return isEventMetadataJson(value);
}
