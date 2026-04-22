package dev.minishop.seckill

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import org.apache.kafka.clients.admin.Admin
import org.apache.kafka.clients.admin.AdminClientConfig
import org.apache.kafka.clients.admin.NewTopic
import org.apache.kafka.clients.consumer.ConsumerConfig
import org.apache.kafka.common.errors.TopicExistsException
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
import java.lang.management.ManagementFactory
import java.net.URI
import java.sql.DriverManager
import java.time.Instant
import java.util.Properties
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import javax.management.ObjectName

private val mapper = jacksonObjectMapper()
private val requestReader = mapper.readerFor(SeckillBuyIntentRequest::class.java)
private val requestWriter = mapper.writerFor(SeckillBuyIntentRequest::class.java)
private val outcomeWriter = mapper.writerFor(SeckillCommandOutcome::class.java)
private val logger = LoggerFactory.getLogger("minishop-seckill")

private const val INVENTORY_STORE_NAME = "inventory-store"
private const val DEDUPE_STORE_NAME = "dedupe-store"
private const val RETRY_KEY_PREFIX = "retry|"
private const val RESULT_KEY_PREFIX = "result|"
private val bucketMetricsRegistry = SeckillBucketMetricsRegistry()
private val retryEdgeMetricsRegistry = SeckillRetryEdgeMetricsRegistry()

fun main() {
    val config = AppConfig.fromEnv()
    ensureTopics(config)
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
            { key, _ -> key.startsWith(RETRY_KEY_PREFIX) },
            Branched.withConsumer { stream ->
                stream
                    .selectKey { key, _ -> stripRoutingPrefix(key) }
                    .to(config.requestTopic)
            }
        )
        .defaultBranch(
            Branched.withConsumer { stream ->
                stream
                    .selectKey { key, _ -> stripRoutingPrefix(key) }
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
                    "org.apache.kafka.streams.errors.LogAndContinueExceptionHandler",
                ),
                processingExceptionHandler = env(
                    "KAFKA_SECKILL_PROCESSING_EXCEPTION_HANDLER",
                    "org.apache.kafka.streams.errors.LogAndContinueProcessingExceptionHandler",
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
        val request = requestReader.readValue<SeckillBuyIntentRequest>(record.value()).normalized()
        val bucketMetrics = bucketMetricsRegistry.forBucket(request.sku_id, request.bucket_id)
        if (request.attempt == 0) {
            bucketMetrics.incrementPrimaryRequests()
        } else {
            bucketMetrics.incrementRetriedRequests()
        }
        val dedupeKey = request.command.idempotency_key ?: request.command.command_id
        val storedResult = dedupeStore.get(dedupeKey)?.let { decodeStoredResult(it, request) }
        val processedAt = Instant.now().toString()

        if (storedResult != null) {
            bucketMetrics.incrementDedupeHits()
            val duplicateResult = storedResult.copy(
                commandId = request.command.command_id,
                correlationId = request.command.correlation_id,
                duplicate = true,
            )
            forwardFinalOutcome(record, request, duplicateResult, processedAt)
            return
        }

        var state = inventoryStore.get(record.key())
            ?.let { decodeInventoryState(request, it) }
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
        bucketMetrics.updateState(state)

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
                bucketMetrics.updateState(state)
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
                inventoryStore.put(record.key(), encodeInventoryState(state))
                dedupeStore.put(dedupeKey, encodeStoredResult(result))
                bucketMetrics.incrementReserveTotal()
                forwardFinalOutcome(record, request, result, processedAt)
                return
        }

        if (request.attempt + 1 < request.max_probe && request.bucket_count > 1) {
            val nextBucketId = (request.primary_bucket_id + request.attempt + 1) % request.bucket_count
            bucketMetrics.incrementRetryScheduled()
            retryEdgeMetricsRegistry
                .forEdge(
                    skuId = request.sku_id,
                    fromBucketId = request.bucket_id,
                    toBucketId = nextBucketId,
                    nextAttempt = request.attempt + 1,
                )
                .incrementScheduled()
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
        dedupeStore.put(dedupeKey, encodeStoredResult(result))
        bucketMetrics.incrementRejectTotal()
        forwardFinalOutcome(record, request, result, processedAt)
    }

    private fun forwardRetry(record: Record<String, String>, request: SeckillBuyIntentRequest) {
        val processingKey = request.processing_key ?: buildProcessingKey(request.sku_id, request.bucket_id)
        context().forward(
            record
                .withKey("$RETRY_KEY_PREFIX$processingKey")
                .withValue(requestWriter.writeValueAsString(request))
        )
    }

    private fun forwardFinalOutcome(
        record: Record<String, String>,
        request: SeckillBuyIntentRequest,
        result: SeckillCommandResult,
        processedAt: String,
    ) {
        val processingKey = request.processing_key ?: buildProcessingKey(request.sku_id, request.bucket_id)
        bucketMetricsRegistry.forBucket(request.sku_id, request.bucket_id).incrementResultTotal()
        context().forward(
            record
                .withKey("$RESULT_KEY_PREFIX$processingKey")
                .withValue(
                    outcomeWriter.writeValueAsString(
                        SeckillCommandOutcome(
                            request = SeckillCommandOutcomeRequest(
                                commandId = request.command.command_id,
                                correlationId = request.command.correlation_id,
                                buyerId = request.command.buyer_id,
                                items = request.command.items,
                                idempotencyKey = request.command.idempotency_key,
                                metadata = request.command.metadata,
                            ),
                            result = result,
                            processedAt = processedAt,
                        )
                    )
                )
        )
    }
}

interface SeckillBucketMetricsMBean {
    fun getPrimaryRequestsTotal(): Long
    fun getRetriedRequestsTotal(): Long
    fun getRetryScheduledTotal(): Long
    fun getResultTotal(): Long
    fun getReserveTotal(): Long
    fun getRejectTotal(): Long
    fun getDedupeHitsTotal(): Long
    fun getProjectionAvailableRemaining(): Int
    fun getConfiguredStockLimit(): Int
    fun getAcceptedUnits(): Int
    fun getRemaining(): Int
}

interface SeckillRetryEdgeMetricsMBean {
    fun getScheduledTotal(): Long
}

class SeckillBucketMetrics(
    private val skuId: String,
    private val bucketId: Int,
) : SeckillBucketMetricsMBean {
    private val primaryRequestsTotal = AtomicLong()
    private val retriedRequestsTotal = AtomicLong()
    private val retryScheduledTotal = AtomicLong()
    private val resultTotal = AtomicLong()
    private val reserveTotal = AtomicLong()
    private val rejectTotal = AtomicLong()
    private val dedupeHitsTotal = AtomicLong()
    private val projectionAvailableRemaining = AtomicInteger()
    private val configuredStockLimit = AtomicInteger()
    private val acceptedUnits = AtomicInteger()
    private val remaining = AtomicInteger()

    fun register(): SeckillBucketMetrics {
        val server = ManagementFactory.getPlatformMBeanServer()
        val objectName = ObjectName(
            "dev.minishop.seckill:type=BucketMetrics,sku=${ObjectName.quote(skuId)},bucket=${bucketId.toString().padStart(2, '0')}",
        )
        if (!server.isRegistered(objectName)) {
            server.registerMBean(this, objectName)
        }
        return this
    }

    fun incrementPrimaryRequests() {
        primaryRequestsTotal.incrementAndGet()
    }

    fun incrementRetriedRequests() {
        retriedRequestsTotal.incrementAndGet()
    }

    fun incrementRetryScheduled() {
        retryScheduledTotal.incrementAndGet()
    }

    fun incrementResultTotal() {
        resultTotal.incrementAndGet()
    }

    fun incrementReserveTotal() {
        reserveTotal.incrementAndGet()
    }

    fun incrementRejectTotal() {
        rejectTotal.incrementAndGet()
    }

    fun incrementDedupeHits() {
        dedupeHitsTotal.incrementAndGet()
    }

    fun updateState(state: SeckillInventoryState) {
        projectionAvailableRemaining.set(state.projectionAvailableRemaining)
        configuredStockLimit.set(state.configuredStockLimit)
        acceptedUnits.set(state.acceptedUnits)
        remaining.set(
            minOf(
                state.projectionAvailableRemaining,
                (state.configuredStockLimit - state.acceptedUnits).coerceAtLeast(0),
            ),
        )
    }

    override fun getPrimaryRequestsTotal(): Long = primaryRequestsTotal.get()
    override fun getRetriedRequestsTotal(): Long = retriedRequestsTotal.get()
    override fun getRetryScheduledTotal(): Long = retryScheduledTotal.get()
    override fun getResultTotal(): Long = resultTotal.get()
    override fun getReserveTotal(): Long = reserveTotal.get()
    override fun getRejectTotal(): Long = rejectTotal.get()
    override fun getDedupeHitsTotal(): Long = dedupeHitsTotal.get()
    override fun getProjectionAvailableRemaining(): Int = projectionAvailableRemaining.get()
    override fun getConfiguredStockLimit(): Int = configuredStockLimit.get()
    override fun getAcceptedUnits(): Int = acceptedUnits.get()
    override fun getRemaining(): Int = remaining.get()
}

class SeckillRetryEdgeMetrics(
    private val skuId: String,
    private val fromBucketId: Int,
    private val toBucketId: Int,
    private val nextAttempt: Int,
) : SeckillRetryEdgeMetricsMBean {
    private val scheduledTotal = AtomicLong()

    fun register(): SeckillRetryEdgeMetrics {
        val server = ManagementFactory.getPlatformMBeanServer()
        val objectName = ObjectName(
            "dev.minishop.seckill:type=RetryEdgeMetrics,sku=${ObjectName.quote(skuId)},from_bucket=${fromBucketId.toString().padStart(2, '0')},to_bucket=${toBucketId.toString().padStart(2, '0')},attempt=${nextAttempt.toString().padStart(2, '0')}",
        )
        if (!server.isRegistered(objectName)) {
            server.registerMBean(this, objectName)
        }
        return this
    }

    fun incrementScheduled() {
        scheduledTotal.incrementAndGet()
    }

    override fun getScheduledTotal(): Long = scheduledTotal.get()
}

class SeckillBucketMetricsRegistry {
    private val metrics = ConcurrentHashMap<String, SeckillBucketMetrics>()

    fun forBucket(skuId: String, bucketId: Int): SeckillBucketMetrics =
        metrics.computeIfAbsent("$skuId#$bucketId") {
            SeckillBucketMetrics(skuId, bucketId).register()
        }
}

class SeckillRetryEdgeMetricsRegistry {
    private val metrics = ConcurrentHashMap<String, SeckillRetryEdgeMetrics>()

    fun forEdge(
        skuId: String,
        fromBucketId: Int,
        toBucketId: Int,
        nextAttempt: Int,
    ): SeckillRetryEdgeMetrics =
        metrics.computeIfAbsent("$skuId#$fromBucketId#$toBucketId#$nextAttempt") {
            SeckillRetryEdgeMetrics(skuId, fromBucketId, toBucketId, nextAttempt).register()
        }
}

@JsonIgnoreProperties(ignoreUnknown = true)
data class SeckillBuyIntentRequest(
    val sku_id: String,
    val quantity: Int,
    val seckill_stock_limit: Int,
    val bucket_count: Int = 1,
    val primary_bucket_id: Int = 0,
    val bucket_id: Int = 0,
    val attempt: Int = 0,
    val max_probe: Int = 1,
    val processing_key: String? = null,
    val command: BuyIntentCommand,
)

fun SeckillBuyIntentRequest.normalized(): SeckillBuyIntentRequest {
    val normalizedBucketCount = bucket_count.coerceAtLeast(1)
    val normalizedBucketId = bucket_id.coerceIn(0, normalizedBucketCount - 1)
    val normalizedPrimaryBucketId = primary_bucket_id.coerceIn(0, normalizedBucketCount - 1)
    val normalizedAttempt = attempt.coerceAtLeast(0)
    val normalizedMaxProbe = max_probe.coerceAtLeast(1)
    val normalizedProcessingKey = processing_key ?: buildProcessingKey(sku_id, normalizedBucketId)

    return copy(
        bucket_count = normalizedBucketCount,
        primary_bucket_id = normalizedPrimaryBucketId,
        bucket_id = normalizedBucketId,
        attempt = normalizedAttempt,
        max_probe = normalizedMaxProbe,
        processing_key = normalizedProcessingKey,
    )
}

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
    val request: SeckillCommandOutcomeRequest,
    val result: SeckillCommandResult,
    val processedAt: String,
)

data class SeckillCommandOutcomeRequest(
    val commandId: String,
    val correlationId: String,
    val buyerId: String,
    val items: List<CheckoutItem>,
    val idempotencyKey: String? = null,
    val metadata: EventMetadata,
)

private fun buildProcessingKey(skuId: String, bucketId: Int): String =
    "$skuId#${bucketId.toString().padStart(2, '0')}"

private fun stripRoutingPrefix(key: String): String =
    key.substringAfter('|', key)

private fun encodeInventoryState(state: SeckillInventoryState): String =
    "${state.projectionAvailableRemaining}|${state.configuredStockLimit}|${state.acceptedUnits}"

private fun decodeInventoryState(request: SeckillBuyIntentRequest, encoded: String): SeckillInventoryState {
    val parts = encoded.split('|', limit = 3)
    require(parts.size == 3) { "Invalid inventory state encoding" }
    return SeckillInventoryState(
        skuId = request.sku_id,
        bucketId = request.bucket_id,
        projectionAvailableRemaining = parts[0].toInt(),
        configuredStockLimit = parts[1].toInt(),
        acceptedUnits = parts[2].toInt(),
    )
}

private fun encodeStoredResult(result: SeckillCommandResult): String =
    listOf(
        result.skuId,
        result.checkoutIntentId.orEmpty(),
        result.status,
        result.requestedQuantity.toString(),
        result.seckillStockLimit.toString(),
        result.failureReason.orEmpty(),
        result.eventId.orEmpty(),
    ).joinToString("|")

private fun decodeStoredResult(encoded: String, request: SeckillBuyIntentRequest): SeckillCommandResult {
    val parts = encoded.split('|', limit = 7)
    require(parts.size == 7) { "Invalid dedupe result encoding" }
    return SeckillCommandResult(
        commandId = request.command.command_id,
        correlationId = request.command.correlation_id,
        skuId = parts[0],
        checkoutIntentId = parts[1].ifEmpty { null },
        status = parts[2],
        requestedQuantity = parts[3].toInt(),
        seckillStockLimit = parts[4].toInt(),
        failureReason = parts[5].ifEmpty { null },
        eventId = parts[6].ifEmpty { null },
        duplicate = false,
    )
}

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

fun ensureTopics(config: AppConfig) {
    val properties = Properties().apply {
        put(AdminClientConfig.BOOTSTRAP_SERVERS_CONFIG, config.brokers)
    }
    Admin.create(properties).use { admin ->
        val topics = mutableListOf(
            NewTopic(config.requestTopic, 6, 1),
            NewTopic(config.resultTopic, 6, 1),
        )
        if (!config.dlqTopic.isNullOrBlank()) {
            topics.add(NewTopic(config.dlqTopic, 6, 1))
        }
        try {
            admin.createTopics(topics).all().get()
        } catch (error: Exception) {
            val cause = error.cause
            if (cause !is TopicExistsException && error !is TopicExistsException) {
                throw error
            }
        }
    }
}
