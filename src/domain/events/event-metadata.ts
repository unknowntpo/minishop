export type EventMetadata = {
  request_id: string;
  trace_id: string;
  source: "web" | "api" | "worker" | "benchmark";
  actor_id: string;
};

export function isEventMetadata(value: unknown): value is EventMetadata {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.request_id) &&
    isNonEmptyString(value.trace_id) &&
    isNonEmptyString(value.source) &&
    ["web", "api", "worker", "benchmark"].includes(value.source) &&
    isNonEmptyString(value.actor_id)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
