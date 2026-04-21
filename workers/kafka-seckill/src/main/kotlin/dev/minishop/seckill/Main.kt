package dev.minishop.seckill

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import org.apache.kafka.clients.consumer.ConsumerConfig
import org.apache.kafka.common.serialization.Serdes
import org.apache.kafka.streams.KafkaStreams
import org.apache.kafka.streams.StreamsConfig
import org.apache.kafka.streams.errors.StreamsUncaughtExceptionHandler
import org.apache.kafka.streams.StreamsBuilder
import org.apache.kafka.streams.kstream.Branched
import org.apache.kafka.streams.kstream.Named
import org.apache.kafka.streams.processor.api.ContextualProcessor
import org.apache.kafka.streams.processor.api.ProcessorContext
import org.apache.kafka.streams.processor.api.ProcessorSupplier
import org.apache.kafka.streams.processor.api.Record
import org.apache.kafka.streams.state.KeyValueStore
import org.apache.kafka.streams.state.Stores
import org.slf4j.LoggerFactory
import java.net.URI
import java.sql.DriverManager
import java.time.Instant
import java.util.Properties
import java.util.UUID
import java.util.concurrent.CountDownLatch

private val mapper = jacksonObjectMapper()
private val logger = LoggerFactory.getLogger("minishop-seckill")

private const val INVENTORY_STORE_NAME = "inventory-store"
private const val DEDUPE_STORE_NAME = "dedupe-store"

fun main() {
    val config = AppConfig.fromEnv()
    val bootstrapGateway = PostgresBootstrapGateway(config)

    val builder = StreamsBuilder()
    val inventoryStore = Stores.keyValueStoreBuilder(
        Stores.persistentKeyValueStore(INVENTORY_STORE_NAME),
        Serdes.String(),
        Serdes.String()
    )
    val dedupeStore = Stores.keyValueStoreBuilder(
        Stores.persistentKeyValueStore(DEDUPE_STORE_NAME),
        Serdes.String(),
        Serdes.String()
    )

    builder.addStateStore(inventoryStore)
    builder.addStateStore(dedupeStore)

    builder.stream<String, String>(config.requestTopic)
        .process(
            ProcessorSupplier {
                SeckillDecisionProcessor(bootstrapGateway)
            },
            INVENTORY_STORE_NAME,
            DEDUPE_STORE_NAME
        )
        .split(Named.`as`("seckill-output-"))
        .branch(
            { _, value -> parseTopologyOutput(value).kind == "retry" },
            Branched.withConsumer { stream ->
                stream
                    .selectKey { _, value -> parseTopologyOutput(value).outputKey }
                    .mapValues { value -> parseTopologyOutput(value).payload }
                    .to(config.requestTopic)
            }
        )
        .defaultBranch(
            Branched.withConsumer { stream ->
                stream
                    .selectKey { _, value -> parseTopologyOutput(value).outputKey }
                    .mapValues { value -> parseTopologyOutput(value).payload }
                    .to(config.resultTopic)
            }
        )

    val streams = KafkaStreams(builder.build(), config.streamProperties())
    val shutdownLatch = CountDownLatch(1)

    streams.setStateListener { newState, oldState ->
        logger.info("Kafka Streams state changed: {} -> {}", oldState, newState)
    }
    streams.setUncaughtExceptionHandler { throwable ->
        logger.error("Kafka seckill worker crashed", throwable)
        shutdownLatch.countDown()
        StreamsUncaughtExceptionHandler.StreamThreadExceptionResponse.SHUTDOWN_APPLICATION
    }
    Runtime.getRuntime().addShutdownHook(Thread {
        logger.info("Stopping Kafka seckill worker")
        streams.close()
        shutdownLatch.countDown()
    })
    logger.info(
        "Starting Kafka seckill worker appId={} brokers={} requestTopic={} resultTopic={} stateDir={}",
        config.applicationId,
        config.brokers,
        config.requestTopic,
        config.resultTopic,
        config.stateDir,
    )
    streams.start()
    shutdownLatch.await()
}

data class AppConfig(
    val brokers: String,
    val applicationId: String,
    val requestTopic: String,
    val resultTopic: String,
    val dlqTopic: String?,
    val deserializationExceptionHandler: String,
    val processingExceptionHandler: String,
    val productionExceptionHandler: String,
    val stateDir: String,
    val jdbcUrl: String,
    val jdbcUser: String,
    val jdbcPassword: String,
) {
    fun streamProperties(): Properties =
        Properties().apply {
            put(StreamsConfig.APPLICATION_ID_CONFIG, applicationId)
            put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, brokers)
            put(StreamsConfig.DEFAULT_KEY_SERDE_CLASS_CONFIG, Serdes.StringSerde::class.java)
            put(StreamsConfig.DEFAULT_VALUE_SERDE_CLASS_CONFIG, Serdes.StringSerde::class.java)
            put(StreamsConfig.NUM_STREAM_THREADS_CONFIG, "1")
            put(StreamsConfig.PROCESSING_GUARANTEE_CONFIG, StreamsConfig.EXACTLY_ONCE_V2)
            put(StreamsConfig.STATE_DIR_CONFIG, stateDir)
            put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
            put(
                StreamsConfig.DEFAULT_DESERIALIZATION_EXCEPTION_HANDLER_CLASS_CONFIG,
                deserializationExceptionHandler,
            )
            put(
                StreamsConfig.PROCESSING_EXCEPTION_HANDLER_CLASS_CONFIG,
                processingExceptionHandler,
            )
            put(
                StreamsConfig.PRODUCTION_EXCEPTION_HANDLER_CLASS_CONFIG,
                productionExceptionHandler,
            )
            if (!dlqTopic.isNullOrBlank()) {
                put("errors.deadletterqueue.topic.name", dlqTopic)
            }
        }

    companion object {
        fun fromEnv(): AppConfig {
            val jdbcUrl = env("JDBC_DATABASE_URL")
            return AppConfig(
                brokers = env("KAFKA_BROKERS"),
                applicationId = env("KAFKA_SECKILL_APPLICATION_ID", "minishop-seckill-worker"),
                requestTopic = env("KAFKA_SECKILL_REQUEST_TOPIC", "inventory.seckill.requested"),
                resultTopic = env("KAFKA_SECKILL_RESULT_TOPIC", "inventory.seckill.result"),
                dlqTopic = optionalEnv("KAFKA_SECKILL_DLQ_TOPIC"),
                deserializationExceptionHandler = env(
                    "KAFKA_SECKILL_DESERIALIZATION_EXCEPTION_HANDLER",
                    "org.apache.kafka.streams.errors.LogAndFailExceptionHandler",
                ),
                processingExceptionHandler = env(
                    "KAFKA_SECKILL_PROCESSING_EXCEPTION_HANDLER",
                    "org.apache.kafka.streams.errors.LogAndFailProcessingExceptionHandler",
                ),
                productionExceptionHandler = env(
                    "KAFKA_SECKILL_PRODUCTION_EXCEPTION_HANDLER",
                    "org.apache.kafka.streams.errors.DefaultProductionExceptionHandler",
                ),
                stateDir = env("KAFKA_SECKILL_STATE_DIR", "/var/lib/minishop-seckill/state"),
                jdbcUrl = jdbcUrl,
                jdbcUser = env("DATABASE_USER", "postgres"),
                jdbcPassword = env("DATABASE_PASSWORD", "postgres"),
            )
        }

        private fun optionalEnv(name: String): String? =
            System.getenv(name)?.trim()?.takeIf { it.isNotEmpty() }

        private fun env(name: String, default: String? = null): String =
            System.getenv(name)?.trim()?.takeIf { it.isNotEmpty() }
                ?: default
                ?: error("$name is required")
    }
}

class SeckillDecisionProcessor(
    private val bootstrapGateway: PostgresBootstrapGateway,
) : ContextualProcessor<String, String, String, String>() {
    private lateinit var inventoryStore: KeyValueStore<String, String>
    private lateinit var dedupeStore: KeyValueStore<String, String>

    override fun init(context: ProcessorContext<String, String>) {
        super.init(context)
        @Suppress("UNCHECKED_CAST")
        inventoryStore = context.getStateStore(INVENTORY_STORE_NAME) as KeyValueStore<String, String>
        @Suppress("UNCHECKED_CAST")
        dedupeStore = context.getStateStore(DEDUPE_STORE_NAME) as KeyValueStore<String, String>
    }

    override fun process(record: Record<String, String>) {
        val request = mapper.readValue<SeckillBuyIntentRequest>(record.value())
        val dedupeKey = request.command.idempotency_key ?: request.command.command_id
        val storedResult = dedupeStore.get(dedupeKey)?.let { mapper.readValue<SeckillCommandResult>(it) }
        val processedAt = Instant.now().toString()

        if (storedResult != null) {
            val duplicateResult = storedResult.copy(
                commandId = request.command.command_id,
                correlationId = request.command.correlation_id,
                duplicate = true,
            )
            forwardFinalOutcome(record, request, duplicateResult, processedAt)
            return
        }

        var state = inventoryStore.get(record.key())
            ?.let { mapper.readValue<SeckillInventoryState>(it) }
            ?: bootstrapGateway.loadInitialState(
                request.sku_id,
                request.seckill_stock_limit,
                request.bucket_id,
                request.bucket_count,
            )
            ?: SeckillInventoryState(
                skuId = request.sku_id,
                bucketId = request.bucket_id,
                projectionAvailableRemaining = 0,
                configuredStockLimit = bucketLimitFor(
                    request.seckill_stock_limit,
                    request.bucket_count,
                    request.bucket_id,
                ),
                acceptedUnits = 0,
            )

        val bucketStockLimit = bucketLimitFor(
            request.seckill_stock_limit,
            request.bucket_count,
            request.bucket_id,
        )
        if (state.configuredStockLimit != bucketStockLimit) {
            state = state.copy(configuredStockLimit = bucketStockLimit)
        }

        val effectiveRemaining = minOf(
            state.projectionAvailableRemaining,
            (state.configuredStockLimit - state.acceptedUnits).coerceAtLeast(0),
        )

        if (request.quantity <= effectiveRemaining) {
                val checkoutIntentId = UUID.randomUUID().toString()
                val eventId = UUID.randomUUID().toString()
                val acceptedState = state.copy(
                    projectionAvailableRemaining = (state.projectionAvailableRemaining - request.quantity).coerceAtLeast(0),
                    acceptedUnits = state.acceptedUnits + request.quantity,
                )
                state = acceptedState
                val result = SeckillCommandResult(
                    commandId = request.command.command_id,
                    correlationId = request.command.correlation_id,
                    skuId = request.sku_id,
                    checkoutIntentId = checkoutIntentId,
                    status = "reserved",
                    requestedQuantity = request.quantity,
                    seckillStockLimit = request.seckill_stock_limit,
                    failureReason = null,
                    eventId = eventId,
                    duplicate = false,
                )
                inventoryStore.put(record.key(), mapper.writeValueAsString(state))
                dedupeStore.put(dedupeKey, mapper.writeValueAsString(result))
                forwardFinalOutcome(record, request, result, processedAt)
                return
        }

        if (request.attempt + 1 < request.max_probe && request.bucket_count > 1) {
            val nextBucketId = (request.primary_bucket_id + request.attempt + 1) % request.bucket_count
            val retryRequest = request.copy(
                bucket_id = nextBucketId,
                attempt = request.attempt + 1,
                processing_key = buildProcessingKey(request.sku_id, nextBucketId),
            )
            forwardRetry(record, retryRequest)
            return
        }

        val result = SeckillCommandResult(
            commandId = request.command.command_id,
            correlationId = request.command.correlation_id,
            skuId = request.sku_id,
            checkoutIntentId = null,
            status = "rejected",
            requestedQuantity = request.quantity,
            seckillStockLimit = request.seckill_stock_limit,
            failureReason = "seckill_out_of_stock",
            eventId = null,
            duplicate = false,
        )
        dedupeStore.put(dedupeKey, mapper.writeValueAsString(result))
        forwardFinalOutcome(record, request, result, processedAt)
    }

    private fun forwardRetry(record: Record<String, String>, request: SeckillBuyIntentRequest) {
        context().forward(
            record
                .withKey(request.processing_key)
                .withValue(
                    mapper.writeValueAsString(
                        SeckillTopologyOutput(
                            kind = "retry",
                            outputKey = request.processing_key,
                            payload = mapper.writeValueAsString(request),
                        )
                    )
                )
        )
    }

    private fun forwardFinalOutcome(
        record: Record<String, String>,
        request: SeckillBuyIntentRequest,
        result: SeckillCommandResult,
        processedAt: String,
    ) {
        context().forward(
            record
                .withKey(request.processing_key)
                .withValue(
                    mapper.writeValueAsString(
                        SeckillTopologyOutput(
                            kind = "result",
                            outputKey = request.processing_key,
                            payload = mapper.writeValueAsString(
                                SeckillCommandOutcome(
                                    request = request,
                                    result = result,
                                    processedAt = processedAt,
                                )
                            ),
                        )
                    )
                )
        )
    }
}

@JsonIgnoreProperties(ignoreUnknown = true)
data class SeckillBuyIntentRequest(
    val sku_id: String,
    val quantity: Int,
    val seckill_stock_limit: Int,
    val bucket_count: Int,
    val primary_bucket_id: Int,
    val bucket_id: Int,
    val attempt: Int,
    val max_probe: Int,
    val processing_key: String,
    val command: BuyIntentCommand,
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class BuyIntentCommand(
    val command_id: String,
    val correlation_id: String,
    val buyer_id: String,
    val items: List<CheckoutItem>,
    val idempotency_key: String? = null,
    val metadata: EventMetadata,
    val issued_at: String,
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class CheckoutItem(
    val sku_id: String,
    val quantity: Int,
    val unit_price_amount_minor: Int,
    val currency: String,
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class EventMetadata(
    val request_id: String,
    val trace_id: String,
    val source: String,
    val actor_id: String,
)

data class SeckillInventoryState(
    val skuId: String,
    val bucketId: Int,
    val projectionAvailableRemaining: Int,
    val configuredStockLimit: Int,
    val acceptedUnits: Int,
)

data class SeckillCommandResult(
    val commandId: String,
    val correlationId: String,
    val skuId: String,
    val checkoutIntentId: String?,
    val status: String,
    val requestedQuantity: Int,
    val seckillStockLimit: Int,
    val failureReason: String?,
    val eventId: String?,
    val duplicate: Boolean,
)

data class SeckillCommandOutcome(
    val request: SeckillBuyIntentRequest,
    val result: SeckillCommandResult,
    val processedAt: String,
)

data class SeckillTopologyOutput(
    val kind: String,
    val outputKey: String,
    val payload: String,
)

private fun parseTopologyOutput(value: String): SeckillTopologyOutput =
    mapper.readValue(value)

private fun buildProcessingKey(skuId: String, bucketId: Int): String =
    "$skuId#${bucketId.toString().padStart(2, '0')}"

private fun bucketLimitFor(totalStockLimit: Int, bucketCount: Int, bucketId: Int): Int {
    val base = totalStockLimit / bucketCount
    val remainder = totalStockLimit % bucketCount
    return base + if (bucketId < remainder) 1 else 0
}

class PostgresBootstrapGateway(private val config: AppConfig) {
    fun loadInitialState(
        skuId: String,
        stockLimit: Int,
        bucketId: Int,
        bucketCount: Int,
    ): SeckillInventoryState? =
        connection().use { connection ->
            connection.prepareStatement(
                """
                select
                  sku_inventory_projection.available,
                  coalesce(sku.seckill_stock_limit, ?) as seckill_stock_limit
                from sku
                left join sku_inventory_projection on sku_inventory_projection.sku_id = sku.sku_id
                where sku.sku_id = ?
                  and sku.seckill_candidate = true
                limit 1
                """.trimIndent()
            ).use { statement ->
                statement.setInt(1, stockLimit)
                statement.setString(2, skuId)
                statement.executeQuery().use { result ->
                    if (!result.next()) {
                        null
                    } else {
                        val effectiveStockLimit = minOf(
                            result.getInt("available"),
                            result.getInt("seckill_stock_limit"),
                        )
                        val bucketLimit = bucketLimitFor(effectiveStockLimit, bucketCount, bucketId)
                        SeckillInventoryState(
                            skuId = skuId,
                            bucketId = bucketId,
                            projectionAvailableRemaining = bucketLimit,
                            configuredStockLimit = bucketLimit,
                            acceptedUnits = 0,
                        )
                    }
                }
            }
        }

    private fun connection() =
        DriverManager.getConnection(config.jdbcUrl, config.jdbcUser, config.jdbcPassword)
}
