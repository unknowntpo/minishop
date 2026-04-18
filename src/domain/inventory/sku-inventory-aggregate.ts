import type {
  DomainEvent,
  InventoryReservationRejected,
  InventoryReservationReleased,
  InventoryReserved,
  OrderConfirmed,
} from "@/src/domain/events/domain-event";
import type {
  ReleaseInventoryReservationCommand,
  ReserveInventoryCommand,
} from "@/src/domain/inventory/commands";

export type ReservationState = {
  checkoutIntentId: string;
  skuId: string;
  quantity: number;
  status: "reserved" | "released" | "sold";
};

export type SkuInventoryState = {
  skuId: string;
  onHand: number;
  reserved: number;
  sold: number;
  available: number;
  aggregateVersion: number;
  reservations: Map<string, ReservationState>;
};

export function createSkuInventoryState({
  skuId,
  onHand,
}: {
  skuId: string;
  onHand: number;
}): SkuInventoryState {
  if (!Number.isInteger(onHand) || onHand < 0) {
    throw new Error("onHand must be a non-negative integer.");
  }

  return {
    skuId,
    onHand,
    reserved: 0,
    sold: 0,
    available: onHand,
    aggregateVersion: 0,
    reservations: new Map(),
  };
}

export function replaySkuInventoryEvents(
  initialState: SkuInventoryState,
  events: DomainEvent[],
): SkuInventoryState {
  return events.reduce(applySkuInventoryEvent, initialState);
}

export function applySkuInventoryEvent(
  state: SkuInventoryState,
  event: DomainEvent,
): SkuInventoryState {
  switch (event.type) {
    case "InventoryReserved":
      return applyInventoryReserved(state, event);
    case "InventoryReservationReleased":
      return applyInventoryReservationReleased(state, event);
    case "OrderConfirmed":
      return applyOrderConfirmed(state, event);
    case "InventoryReservationRejected":
    case "InventoryReservationRequested":
      return nextVersion(state);
    default:
      return state;
  }
}

export function reserveInventory(
  state: SkuInventoryState,
  command: ReserveInventoryCommand,
  expiresAt: Date,
): InventoryReserved | InventoryReservationRejected {
  assertPositiveQuantity(command.quantity);
  assertSkuMatches(state, command.sku_id);

  if (state.reservations.has(command.reservation_id)) {
    return {
      type: "InventoryReservationRejected",
      version: 1,
      payload: {
        checkout_intent_id: command.checkout_intent_id,
        reservation_id: command.reservation_id,
        sku_id: command.sku_id,
        quantity: command.quantity,
        reason: "duplicate_reservation",
      },
    };
  }

  if (state.available < command.quantity) {
    return {
      type: "InventoryReservationRejected",
      version: 1,
      payload: {
        checkout_intent_id: command.checkout_intent_id,
        reservation_id: command.reservation_id,
        sku_id: command.sku_id,
        quantity: command.quantity,
        reason: "insufficient_inventory",
      },
    };
  }

  return {
    type: "InventoryReserved",
    version: 1,
    payload: {
      checkout_intent_id: command.checkout_intent_id,
      reservation_id: command.reservation_id,
      sku_id: command.sku_id,
      quantity: command.quantity,
      expires_at: expiresAt.toISOString(),
    },
  };
}

export function releaseInventoryReservation(
  state: SkuInventoryState,
  command: ReleaseInventoryReservationCommand,
): InventoryReservationReleased | null {
  assertPositiveQuantity(command.quantity);
  assertSkuMatches(state, command.sku_id);

  const reservation = state.reservations.get(command.reservation_id);

  if (!reservation || reservation.status !== "reserved") {
    return null;
  }

  return {
    type: "InventoryReservationReleased",
    version: 1,
    payload: {
      checkout_intent_id: command.checkout_intent_id,
      reservation_id: command.reservation_id,
      sku_id: command.sku_id,
      quantity: command.quantity,
      reason: command.reason,
    },
  };
}

function applyInventoryReserved(
  state: SkuInventoryState,
  event: InventoryReserved,
): SkuInventoryState {
  assertSkuMatches(state, event.payload.sku_id);

  const next = cloneState(state);
  next.reserved += event.payload.quantity;
  next.available -= event.payload.quantity;
  next.aggregateVersion += 1;
  next.reservations.set(event.payload.reservation_id, {
    checkoutIntentId: event.payload.checkout_intent_id,
    skuId: event.payload.sku_id,
    quantity: event.payload.quantity,
    status: "reserved",
  });

  assertInventoryInvariant(next);
  return next;
}

function applyInventoryReservationReleased(
  state: SkuInventoryState,
  event: InventoryReservationReleased,
): SkuInventoryState {
  assertSkuMatches(state, event.payload.sku_id);

  const reservation = state.reservations.get(event.payload.reservation_id);

  if (!reservation || reservation.status !== "reserved") {
    return nextVersion(state);
  }

  const next = cloneState(state);
  next.reserved -= event.payload.quantity;
  next.available += event.payload.quantity;
  next.aggregateVersion += 1;
  next.reservations.set(event.payload.reservation_id, {
    ...reservation,
    status: "released",
  });

  assertInventoryInvariant(next);
  return next;
}

function applyOrderConfirmed(state: SkuInventoryState, event: OrderConfirmed): SkuInventoryState {
  const skuItems = event.payload.items.filter((item) => item.sku_id === state.skuId);

  if (skuItems.length === 0) {
    return state;
  }

  const quantity = skuItems.reduce((sum, item) => sum + item.quantity, 0);
  const next = cloneState(state);
  next.reserved -= quantity;
  next.sold += quantity;
  next.aggregateVersion += 1;

  for (const [reservationId, reservation] of next.reservations) {
    if (reservation.checkoutIntentId === event.payload.checkout_intent_id) {
      next.reservations.set(reservationId, {
        ...reservation,
        status: "sold",
      });
    }
  }

  assertInventoryInvariant(next);
  return next;
}

function nextVersion(state: SkuInventoryState): SkuInventoryState {
  return {
    ...state,
    aggregateVersion: state.aggregateVersion + 1,
    reservations: new Map(state.reservations),
  };
}

function cloneState(state: SkuInventoryState): SkuInventoryState {
  return {
    ...state,
    reservations: new Map(state.reservations),
  };
}

function assertSkuMatches(state: SkuInventoryState, skuId: string) {
  if (state.skuId !== skuId) {
    throw new Error(`Command SKU ${skuId} does not match aggregate ${state.skuId}.`);
  }
}

function assertPositiveQuantity(quantity: number) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("quantity must be a positive integer.");
  }
}

function assertInventoryInvariant(state: SkuInventoryState) {
  if (state.onHand < 0 || state.reserved < 0 || state.sold < 0 || state.available < 0) {
    throw new Error("Inventory counters must never be negative.");
  }

  if (state.available !== state.onHand - state.reserved - state.sold) {
    throw new Error("available must equal on_hand - reserved - sold.");
  }
}
