export const stagingIngestStatuses = [
  "pending",
  "claimed",
  "merged",
  "retry",
  "dlq",
] as const;

export type StagingIngestStatus = (typeof stagingIngestStatuses)[number];
