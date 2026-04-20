-- name: ClaimPendingBatch :many
with next_batch as (
  select staging_id
  from staged_buy_intent_command
  where ingest_status = 'pending'
  order by received_at asc
  limit $2
  for update skip locked
)
update staged_buy_intent_command as staging
set
  ingest_status = 'claimed',
  batch_id = $1,
  claimed_at = now()
from next_batch
where staging.staging_id = next_batch.staging_id
returning
  staging.staging_id,
  staging.command_id,
  staging.correlation_id,
  staging.idempotency_key,
  staging.payload_json;

-- name: GetCommandStatus :one
select
  command_id,
  correlation_id,
  status,
  checkout_intent_id,
  event_id,
  is_duplicate,
  failure_code,
  failure_message,
  created_at,
  updated_at
from command_status
where command_id = $1
limit 1;

-- name: MarkCommandProcessing :exec
update command_status
set
  status = case when status = 'accepted' then 'processing' else status end,
  updated_at = now()
where command_id = $1
  and status in ('accepted', 'processing');

-- name: MarkCommandCreated :exec
update command_status
set
  status = 'created',
  checkout_intent_id = $2,
  event_id = $3,
  is_duplicate = $4,
  failure_code = null,
  failure_message = null,
  updated_at = now()
where command_id = $1
  and status in ('accepted', 'processing');

-- name: MarkCommandFailed :exec
update command_status
set
  status = 'failed',
  failure_code = $2,
  failure_message = $3,
  updated_at = now()
where command_id = $1
  and status in ('accepted', 'processing');

-- name: MarkStagingMerged :exec
update staged_buy_intent_command
set
  ingest_status = 'merged',
  processed_at = now(),
  last_error_code = null
where staging_id = $1;

-- name: MarkStagingFailed :exec
update staged_buy_intent_command
set
  ingest_status = $2,
  processed_at = now(),
  last_error_code = $3,
  retry_count = retry_count + 1
where staging_id = $1;

-- name: TouchCommandStatus :exec
update command_status
set updated_at = now()
where command_id = $1;

-- name: InsertCheckoutIntentCreatedEvent :one
insert into event_store (
  event_id,
  event_type,
  event_version,
  aggregate_type,
  aggregate_id,
  aggregate_version,
  payload,
  metadata,
  idempotency_key,
  occurred_at
)
values ($1, 'CheckoutIntentCreated', 1, 'checkout', $2, 1, $3::jsonb, $4::jsonb, $5, $6)
on conflict (idempotency_key)
  where idempotency_key is not null
  do nothing
returning
  id,
  event_id,
  event_type,
  event_version,
  aggregate_type,
  aggregate_id,
  aggregate_version,
  payload,
  metadata,
  idempotency_key,
  occurred_at;

-- name: GetEventByIdempotencyKey :one
select
  id,
  event_id,
  event_type,
  event_version,
  aggregate_type,
  aggregate_id,
  aggregate_version,
  payload,
  metadata,
  idempotency_key,
  occurred_at
from event_store
where idempotency_key = $1
limit 1;
