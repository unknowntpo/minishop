import { isEventMetadataJson } from "@/src/domain/schema-conventions";

export type EventMetadata = {
  request_id: string;
  trace_id: string;
  source: "web" | "api" | "worker" | "benchmark";
  actor_id: string;
};

export function isEventMetadata(value: unknown): value is EventMetadata {
  return isEventMetadataJson(value);
}
