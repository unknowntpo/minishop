import "dotenv/config";

import { loadConfluentKafkaJsCompat } from "@/src/infrastructure/kafka/confluent-kafka";

type TopicOffsets = Array<{
  partition: number;
  offset: string;
}>;

type RequestMessage = {
  primary_bucket_id?: number;
  bucket_id?: number;
  attempt?: number;
  processing_key?: string;
};

type ResultMessage = {
  result?: {
    status?: string;
    skuId?: string;
  };
  request?: {
    commandId?: string;
  };
};

type Report = {
  generatedAt: string;
  requestTopic: {
    topic: string;
    offsets: TopicOffsets;
    partitionHighWatermarks: Record<string, number>;
    sampleSize: number;
    partitionDistribution: Record<string, number>;
    primaryBucketDistribution: Record<string, number>;
    bucketDistribution: Record<string, number>;
    attemptDistribution: Record<string, number>;
    processingKeyDistribution: Record<string, number>;
  };
  resultTopic: {
    topic: string;
    offsets: TopicOffsets;
    partitionHighWatermarks: Record<string, number>;
    sampleSize: number;
    partitionDistribution: Record<string, number>;
    statusDistribution: Record<string, number>;
  };
};

type TopicSampleSummary = {
  sampleSize: number;
  partitionDistribution: Record<string, number>;
  primaryBucketDistribution: Record<string, number>;
  bucketDistribution: Record<string, number>;
  attemptDistribution: Record<string, number>;
  processingKeyDistribution: Record<string, number>;
  statusDistribution: Record<string, number>;
};

type TopicSampleCounters = Omit<TopicSampleSummary, "sampleSize">;

async function main() {
  const brokers = readCsvEnv("BENCHMARK_KAFKA_BROKERS", readCsvEnv("KAFKA_BROKERS", ["localhost:19092"]));
  const requestTopic =
    process.env.BENCHMARK_KAFKA_SECKILL_REQUEST_TOPIC ??
    process.env.KAFKA_SECKILL_REQUEST_TOPIC ??
    "inventory.seckill.requested";
  const resultTopic =
    process.env.BENCHMARK_KAFKA_SECKILL_RESULT_TOPIC ??
    process.env.KAFKA_SECKILL_RESULT_TOPIC ??
    "inventory.seckill.result";
  const samplePerPartition = readPositiveIntegerEnv("SECKILL_SKEW_SAMPLE_PER_PARTITION", 250);

  const { Kafka, logLevel } = await loadConfluentKafkaJsCompat();
  const kafka = new Kafka({
    kafkaJS: {
      clientId: `seckill-skew-report-${Date.now()}`,
      brokers,
      logLevel: logLevel.NOTHING,
    },
  });
  const admin = kafka.admin();

  await admin.connect();
  const requestOffsets = await admin.fetchTopicOffsets(requestTopic);
  const resultOffsets = await admin.fetchTopicOffsets(resultTopic);
  await admin.disconnect();

  const requestSummary = await sampleTopic<RequestMessage>({
    kafka,
    topic: requestTopic,
    offsets: requestOffsets,
    samplePerPartition,
    summarize(message, partition, counters) {
      increment(counters.partitionDistribution, String(partition));
      increment(counters.primaryBucketDistribution, String(message.primary_bucket_id ?? "unknown"));
      increment(counters.bucketDistribution, String(message.bucket_id ?? "unknown"));
      increment(counters.attemptDistribution, String(message.attempt ?? "unknown"));
      increment(counters.processingKeyDistribution, String(message.processing_key ?? "unknown"));
    },
  });

  const resultSummary = await sampleTopic<ResultMessage>({
    kafka,
    topic: resultTopic,
    offsets: resultOffsets,
    samplePerPartition,
    summarize(message, partition, counters) {
      increment(counters.partitionDistribution, String(partition));
      increment(counters.statusDistribution, String(message.result?.status ?? "unknown"));
    },
  });

  const report: Report = {
    generatedAt: new Date().toISOString(),
    requestTopic: {
      topic: requestTopic,
      offsets: requestOffsets,
      partitionHighWatermarks: offsetsToMap(requestOffsets),
      sampleSize: requestSummary.sampleSize,
      partitionDistribution: sortNumericRecord(requestSummary.partitionDistribution),
      primaryBucketDistribution: sortNumericRecord(requestSummary.primaryBucketDistribution),
      bucketDistribution: sortNumericRecord(requestSummary.bucketDistribution),
      attemptDistribution: sortNumericRecord(requestSummary.attemptDistribution),
      processingKeyDistribution: sortNumericRecord(requestSummary.processingKeyDistribution),
    },
    resultTopic: {
      topic: resultTopic,
      offsets: resultOffsets,
      partitionHighWatermarks: offsetsToMap(resultOffsets),
      sampleSize: resultSummary.sampleSize,
      partitionDistribution: sortNumericRecord(resultSummary.partitionDistribution),
      statusDistribution: sortNumericRecord(resultSummary.statusDistribution),
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

async function sampleTopic<T>(input: {
  kafka: {
    consumer(config: Record<string, unknown>): {
      connect(): Promise<void>;
      disconnect(): Promise<void>;
      subscribe(args: { topic: string }): Promise<void>;
      run(args: {
        eachMessage: (payload: {
          partition: number;
          message: {
            value: Buffer | null;
          };
        }) => Promise<void>;
      }): Promise<void>;
      seek(args: { topic: string; partition: number; offset: string }): void;
    };
  };
  topic: string;
  offsets: TopicOffsets;
  samplePerPartition: number;
  summarize: (message: T, partition: number, counters: TopicSampleCounters) => void;
}): Promise<TopicSampleSummary> {
  const counters: TopicSampleSummary = {
    sampleSize: 0,
    partitionDistribution: {},
    primaryBucketDistribution: {},
    bucketDistribution: {},
    attemptDistribution: {},
    processingKeyDistribution: {},
    statusDistribution: {},
  };
  const partitionCounts = new Map<number, number>();

  const consumer = input.kafka.consumer({
    kafkaJS: {
      groupId: `seckill-skew-report-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });

  await consumer.connect();
  await consumer.subscribe({ topic: input.topic });

  for (const entry of input.offsets) {
    const offset = Math.max(0, Number.parseInt(entry.offset ?? "0", 10) - input.samplePerPartition);
    consumer.seek({
      topic: input.topic,
      partition: entry.partition,
      offset: String(offset),
    });
  }

  let resolveDone: (() => void) | null = null;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  await consumer.run({
    eachMessage: async ({ partition, message }) => {
      if (!message.value) {
        return;
      }

      const seen = partitionCounts.get(partition) ?? 0;
      if (seen >= input.samplePerPartition) {
        if (allPartitionsComplete(partitionCounts, input.offsets, input.samplePerPartition)) {
          resolveDone?.();
        }
        return;
      }

      try {
        const parsed = JSON.parse(message.value.toString("utf8")) as T;
        partitionCounts.set(partition, seen + 1);
        counters.sampleSize += 1;
        input.summarize(parsed, partition, counters);
      } catch {
        partitionCounts.set(partition, seen + 1);
        counters.sampleSize += 1;
      }

      if (allPartitionsComplete(partitionCounts, input.offsets, input.samplePerPartition)) {
        resolveDone?.();
      }
    },
  });

  await Promise.race([done, sleep(2000)]);
  await consumer.disconnect().catch(() => undefined);

  return counters;
}

function allPartitionsComplete(
  partitionCounts: Map<number, number>,
  offsets: TopicOffsets,
  samplePerPartition: number,
) {
  return offsets.every((entry) => {
    const target = Math.min(samplePerPartition, Number.parseInt(entry.offset ?? "0", 10));
    return (partitionCounts.get(entry.partition) ?? 0) >= target;
  });
}

function offsetsToMap(offsets: TopicOffsets) {
  return Object.fromEntries(
    offsets.map((entry) => [String(entry.partition), Number.parseInt(entry.offset ?? "0", 10)]),
  );
}

function increment(record: Record<string, number>, key: string) {
  record[key] = (record[key] ?? 0) + 1;
}

function sortNumericRecord(record: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true })),
  );
}

function readCsvEnv(name: string, fallback: string[]) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
