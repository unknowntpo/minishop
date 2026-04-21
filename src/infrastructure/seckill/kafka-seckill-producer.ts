import type { SeckillBuyIntentRequest } from "@/src/domain/seckill/seckill-buy-intent-request";
import {
  loadConfluentKafkaJsCompat,
  type KafkaAdminLike,
  type KafkaProducerLike,
} from "@/src/infrastructure/kafka/confluent-kafka";

export type KafkaSeckillProducerOptions = {
  brokers: string[];
  requestTopic: string;
  resultTopic: string;
  clientId?: string;
  producerLingerMs?: number;
  producerBatchNumMessages?: number;
};

export type SeckillPendingMessage = {
  request: SeckillBuyIntentRequest;
  headers: Record<string, Buffer>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export class KafkaSeckillProducer {
  private kafka:
    | {
        producer(config?: Record<string, unknown>): KafkaProducerLike;
        admin(config?: Record<string, unknown>): KafkaAdminLike;
      }
    | null = null;
  private producer: KafkaProducerLike | null = null;
  private producerConnected = false;
  private producerConnectPromise: Promise<KafkaProducerLike> | null = null;
  private admin: KafkaAdminLike | null = null;
  private adminConnected = false;
  private adminConnectPromise: Promise<KafkaAdminLike> | null = null;
  private topicsEnsured: Promise<void> | null = null;

  constructor(private readonly options: KafkaSeckillProducerOptions) {}

  async send(entries: SeckillPendingMessage[]) {
    await this.ensureTopics();

    const execute = async () => {
      const producer = await this.getProducer();
      await producer.sendBatch({
        topicMessages: [
          {
            topic: this.options.requestTopic,
            messages: entries.map((entry) => ({
              key: entry.request.processing_key,
              value: JSON.stringify(entry.request),
              headers: entry.headers,
            })),
          },
        ],
      });
    };

    try {
      await execute();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("disconnected")) {
        throw error;
      }

      await this.resetProducer();
      await execute();
    }
  }

  private async getKafka() {
    if (this.kafka) {
      return this.kafka;
    }

    const { Kafka, logLevel } = await loadConfluentKafkaJsCompat();
    this.kafka = new Kafka({
      kafkaJS: {
        clientId: this.options.clientId ?? "minishop-seckill-app",
        brokers: this.options.brokers,
        logLevel: logLevel.NOTHING,
      },
    });
    return this.kafka;
  }

  private async getProducer() {
    if (!this.producer) {
      const kafka = await this.getKafka();
      this.producer = kafka.producer({
        "linger.ms": this.options.producerLingerMs ?? 1,
        "batch.num.messages": this.options.producerBatchNumMessages ?? 10000,
      });
    }

    if (this.producerConnected) {
      return this.producer;
    }

    if (this.producerConnectPromise) {
      return this.producerConnectPromise;
    }

    this.producerConnectPromise = (async () => {
      const producer = this.producer;
      if (!producer) {
        throw new Error("Kafka producer is not initialized.");
      }

      await producer.connect();
      this.producerConnected = true;
      return producer;
    })().finally(() => {
      this.producerConnectPromise = null;
    });

    return this.producerConnectPromise;
  }

  private async resetProducer() {
    const producer = this.producer;
    this.producer = null;
    this.producerConnected = false;
    this.producerConnectPromise = null;
    if (!producer) {
      return;
    }

    try {
      await producer.disconnect();
    } catch {
      // Ignore disconnect races while replacing a stale shared producer.
    }
  }

  private async getAdmin() {
    if (!this.admin) {
      const kafka = await this.getKafka();
      this.admin = kafka.admin();
    }

    if (this.adminConnected) {
      return this.admin;
    }

    if (this.adminConnectPromise) {
      return this.adminConnectPromise;
    }

    this.adminConnectPromise = (async () => {
      const admin = this.admin;
      if (!admin) {
        throw new Error("Kafka admin is not initialized.");
      }

      await admin.connect();
      this.adminConnected = true;
      return admin;
    })().finally(() => {
      this.adminConnectPromise = null;
    });

    return this.adminConnectPromise;
  }

  private async ensureTopics() {
    if (this.topicsEnsured) {
      return this.topicsEnsured;
    }

    this.topicsEnsured = (async () => {
      const admin = await this.getAdmin();
      await admin.createTopics({
        topics: [
          {
            topic: this.options.requestTopic,
            numPartitions: 6,
            replicationFactor: 1,
          },
          {
            topic: this.options.resultTopic,
            numPartitions: 6,
            replicationFactor: 1,
          },
        ],
      });
    })();

    return this.topicsEnsured;
  }
}
