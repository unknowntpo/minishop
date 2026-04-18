import { isEventMetadataJson } from "@/src/domain/schema-rules";

export type EventMetadata = {
  request_id: string;
  trace_id: string;
  source: "web" | "api" | "worker" | "benchmark";
  actor_id: string;
};

export function isEventMetadata(value: unknown): value is EventMetadata {
  return isEventMetadataJson(value);
}
