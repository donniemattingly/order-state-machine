
// Using typescript here mainly for its excellent type system
// 
// A state machine to me is an opportunity to let the compiler do as much work as
// possible to avoid errors. If we can model each state well and precisely describe
// how you can transition between states you end up with a composable and testable system
// 
// Pure(ish) and well typed functions make an agent's work easier, since it takes many classes
// of bugs and makes them compiler errors vs runtime ones


// Make errors explicit
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// A union type makes the most sense to me to describe the states of a state machine.
// this allows us to succinctly convey all the states we're handling and what information
// we'll have when we're in each of these states
export type State =
  | { state: "initialized" }
  | { state: "payment_authorized" }
  | { state: "complete" }
  | { state: "rejected"; cause: unknown }
  | { state: "cancelled"; cause: unknown }
  | { state: "needs_attention"; completionError: unknown; voidError: unknown }
  | { state: "needs_attention"; reason: "partial_fulfillment"; completionError: unknown; voidError?: never };

export type OrderTransitionReasonCode =
  | "order_created"
  | "payment_authorized"
  | "payment_declined"
  | "fulfillment_completed"
  | "fulfillment_failed_payment_voided"
  | "fulfillment_and_void_failed"
  | "partial_fulfillment";

export interface OrderTransitionEvent {
  readonly eventId: string;
  readonly eventType: "order.state_changed";
  readonly schemaVersion: 1;
  readonly orderId: string;
  readonly sequence: number;
  readonly fromState: State["state"] | null;
  readonly toState: State["state"];
  /** Unix time in milliseconds. */
  readonly occurredAt: number;
  readonly reasonCode: OrderTransitionReasonCode;
  readonly correlationId?: string;
}

export type OrderEventSink = (event: OrderTransitionEvent) => void;

export interface OrderTransitionContext {
  correlationId?: string;
}

export interface OrderCreateOptions extends OrderTransitionContext {
  items?: readonly OrderItem[];
}

export interface OrderServiceOptions {
  eventSink?: OrderEventSink;
}

/** Writes one JSON event per line to stdout. */
export const stdoutOrderEventSink: OrderEventSink = event => {
  console.log(JSON.stringify(event));
};

// You get this clean history almost for free approaching the problem like this  
export type ItemFulfillment =
  | { state: "pending" }
  | { state: "fulfilling" }
  | { state: "fulfilled" }
  | { state: "failed"; cause: unknown };

export type OrderItem = { id: string; productId: string };
export type OrderItemSnapshot = OrderItem & { fulfillment: ItemFulfillment };

export function summarizeFulfillment(items: readonly OrderItemSnapshot[]) {
  const fulfilled = items.filter(item => item.fulfillment.state === "fulfilled").length;
  const failed = items.filter(item => item.fulfillment.state === "failed").length;
  const total = items.length;
  const state: "unfulfilled" | "partial" | "fulfilled" =
    total > 0 && fulfilled === total ? "fulfilled" : fulfilled > 0 ? "partial" : "unfulfilled";
  return { state, total, fulfilled, failed, settled: total > 0 && fulfilled + failed === total };
}

export type OrderSnapshot = State & {
  items: OrderItemSnapshot[];
  fulfillment: ReturnType<typeof summarizeFulfillment>;
  id: string;
  history: { state: State["state"]; at: number }[];
};

// Same idea as for the `State`. In a glance you can see all the types of errors we've thought about. 
export type OrderError =
  | { type: "operation_in_progress" }
  | { type: "unknown_item"; itemId: string }
  | { type: "item_already_attempted"; itemId: string }
  | { type: "partial_fulfillment"; orderId: string; completionError: unknown }
  | { type: "invalid_transition"; state: State["state"]; expected: State["state"] }
  | { type: "payment_declined"; cause: unknown }
  | { type: "completion_failed"; cause: unknown }
  | { type: "needs_attention"; orderId: string; completionError: unknown; voidError: unknown };

// A huge amount of information is now carried in this type definition, all the possible states, required data, etc
type OrderResult = Result<OrderSnapshot, OrderError>;


// you would have more functions in a real payment service
export interface Payment {
  authorize(id: string): Promise<void>;
  void(id: string): Promise<void>;
}


export interface Fulfillment {
  complete(id: string, item: OrderItem): Promise<void>;
}

// we need a service that can handle payments and one that can fulfill an order
type Dependencies = { payment: Payment; fulfillment: Fulfillment };

// everything you need to know about an order to take the correct next action
type OrderRecord = {
  id: string;
  items: OrderItemSnapshot[];
  current: State;
  busy: boolean;
  history: OrderSnapshot["history"];
};

// we need to hold the compiler's hand to narrow the type
function succeed<T>(value: T): Result<T, never> {
  return { ok: true, value };
}
function fail<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// a boundary between the js world of throwing exceptions and our logic
async function attempt<T>(operation: () => Promise<T>): Promise<Result<T, unknown>> {
  try {
    return succeed(await operation());
  } catch (error) {
    return fail(error);
  }
}

function historyEntry({ state }: State, at: number) {
  return { state, at };
}


// Creation is recorded through the same transition path as later state changes.
function createOrderRecord(
  items: readonly OrderItem[],
  eventSink: OrderEventSink,
  context?: OrderTransitionContext,
): OrderRecord {
  if (items.length === 0 || items.some(item => !item.id || !item.productId) ||
      new Set(items.map(item => item.id)).size !== items.length) {
    throw new Error("Orders require at least one item with a unique, nonempty id and a productId");
  }
  const current: State = { state: "initialized" };
  const order: OrderRecord = {
    id: crypto.randomUUID(),
    items: items.map(({ id, productId }) => ({ id, productId, fulfillment: { state: "pending" } })),
    current,
    busy: false,
    history: [],
  };

  transition(order, current, "order_created", eventSink, context, null);
  return order;
}


// since JSON.parse(JSON.stringify(stuff)) won't work
function snapshot(order: OrderRecord): OrderSnapshot {
  return {
    ...order.current,
    id: order.id,
    items: order.items.map(item => ({ ...item, fulfillment: { ...item.fulfillment } })),
    fulfillment: summarizeFulfillment(order.items),
    history: order.history.map(entry => ({ ...entry })),
  };
}

function createTransitionEvent(
  order: OrderRecord,
  fromState: State["state"] | null,
  toState: State,
  sequence: number,
  occurredAt: number,
  reasonCode: OrderTransitionReasonCode,
  context?: OrderTransitionContext,
): OrderTransitionEvent {
  const event: OrderTransitionEvent = {
    eventId: crypto.randomUUID(),
    eventType: "order.state_changed",
    schemaVersion: 1,
    orderId: order.id,
    sequence,
    fromState,
    toState: toState.state,
    occurredAt,
    reasonCode,
    ...(context?.correlationId === undefined ? {} : { correlationId: context.correlationId }),
  };
  return Object.freeze(event);
}

function emitTransitionEvent(eventSink: OrderEventSink, event: OrderTransitionEvent): void {
  try {
    eventSink(event);
  } catch {
    // Event logging must not turn a committed state change into an operation failure.
    try {
      console.error("order_transition_event_write_failed");
    } catch {
      // Keep logger failures isolated from order processing.
    }
  }
}

// The single state mutation point also records history and emits its transition event.
function transition(
  order: OrderRecord,
  next: State,
  reasonCode: OrderTransitionReasonCode,
  eventSink: OrderEventSink,
  context?: OrderTransitionContext,
  fromState: State["state"] | null = order.current.state,
): OrderSnapshot {
  const occurredAt = Date.now();
  const sequence = order.history.length + 1;
  const event = createTransitionEvent(order, fromState, next, sequence, occurredAt, reasonCode, context);
  order.current = next;
  order.history.push(historyEntry(next, occurredAt));
  emitTransitionEvent(eventSink, event);
  return snapshot(order);
}


function transitionError(order: OrderRecord, expected: State["state"]): OrderError | undefined {
  if (order.busy) return { type: "operation_in_progress" };
  if (order.current.state !== expected) {
    return { type: "invalid_transition", state: order.current.state, expected };
  }
}


// order.busy here acting as a loose semaphore to serialize operations
async function runStep(
  order: OrderRecord,
  expected: State["state"],
  operation: () => Promise<OrderResult>,
): Promise<OrderResult> {

  // again the ergonomics I don't love, since explicitly passing the expected feels like
  // it could happen as defined by the state itself
  const error = transitionError(order, expected);
  if (error) return fail(error);

  // do the thing
  order.busy = true;
  try {
    return await operation();
  } finally {
    order.busy = false;
  }
}

// these are dumb functions that make reading the code much nicer
function rejectOrder(
  order: OrderRecord,
  cause: unknown,
  eventSink: OrderEventSink,
  context?: OrderTransitionContext,
): OrderResult {
  transition(order, { state: "rejected", cause }, "payment_declined", eventSink, context);
  return fail({ type: "payment_declined", cause });
}

function cancelOrder(
  order: OrderRecord,
  cause: unknown,
  eventSink: OrderEventSink,
  context?: OrderTransitionContext,
): OrderResult {
  transition(order, { state: "cancelled", cause }, "fulfillment_failed_payment_voided", eventSink, context);
  return fail({ type: "completion_failed", cause });
}

function markNeedsAttention(
  order: OrderRecord,
  completionError: unknown,
  voidError: unknown,
  eventSink: OrderEventSink,
  context?: OrderTransitionContext,
): OrderResult {
  transition(
    order,
    { state: "needs_attention", completionError, voidError },
    "fulfillment_and_void_failed",
    eventSink,
    context,
  );
  return fail({ type: "needs_attention", orderId: order.id, completionError, voidError });
}


// here we get into the actual business logic. all the ceremony before now lets us (hopefully)
// in addition to accomplishing the primary business logic be expressive with our intent 

// Payment is declined → reject the order. No cleanup needed.
async function authorizePayment(
  order: OrderRecord,
  payment: Payment,
  eventSink: OrderEventSink,
  context?: OrderTransitionContext,
): Promise<OrderResult> {
  const result = await attempt(() => payment.authorize(order.id));
  if (!result.ok) return rejectOrder(order, result.error, eventSink, context);
  return succeed(transition(order, { state: "payment_authorized" }, "payment_authorized", eventSink, context));
}


// Completion fails and the void also fails → move to needs_attention for manual resolution. 
// Don't silently swallow the error.
async function recoverCompletion(
  order: OrderRecord,
  payment: Payment,
  completionError: unknown,
  eventSink: OrderEventSink,
  context?: OrderTransitionContext,
): Promise<OrderResult> {
  const result = await attempt(() => payment.void(order.id));
  if (!result.ok) return markNeedsAttention(order, completionError, result.error, eventSink, context);
  return cancelOrder(order, completionError, eventSink, context);
}

// Void only when every item failed; mixed outcomes require payment reconciliation.
async function completeOrder(
  order: OrderRecord,
  { payment, fulfillment }: Dependencies,
  eventSink: OrderEventSink,
  context?: OrderTransitionContext,
  itemId?: string,
): Promise<OrderResult> {
  const selected = itemId === undefined
    ? order.items.filter(item => item.fulfillment.state === "pending")
    : order.items.filter(item => item.id === itemId);
  if (selected.length === 0 && itemId !== undefined) return fail({ type: "unknown_item", itemId });
  if (selected.some(item => item.fulfillment.state !== "pending")) {
    return fail({ type: "item_already_attempted", itemId: itemId! });
  }
  let failed = false;
  let completionError: unknown;
  for (const item of selected) {
    item.fulfillment = { state: "fulfilling" };
    const result = await attempt(() => fulfillment.complete(order.id, { id: item.id, productId: item.productId }));
    if (result.ok) item.fulfillment = { state: "fulfilled" };
    else {
      item.fulfillment = { state: "failed", cause: result.error };
      failed = true;
      completionError = result.error;
    }
  }
  const summary = summarizeFulfillment(order.items);
  if (summary.state === "fulfilled") return succeed(transition(order, { state: "complete" }, "fulfillment_completed", eventSink, context));
  if (summary.settled) {
    const failures = order.items.flatMap(item => item.fulfillment.state === "failed"
      ? [{ itemId: item.id, cause: item.fulfillment.cause }] : []);
    const cause = failures.length === 1 ? failures[0]!.cause : failures;
    if (summary.fulfilled === 0) return recoverCompletion(order, payment, cause, eventSink, context);
    transition(order, { state: "needs_attention", reason: "partial_fulfillment", completionError: cause }, "partial_fulfillment", eventSink, context);
    return fail({ type: "partial_fulfillment", orderId: order.id, completionError: cause });
  }
  return failed ? fail({ type: "completion_failed", cause: completionError }) : succeed(snapshot(order));
}


// the final interface is simple while clearly coordinating everything that needs to happen
function createOrder(
  dependencies: Dependencies,
  eventSink: OrderEventSink,
  context: OrderCreateOptions = {},
) {
  const order = createOrderRecord(context.items ?? [{ id: "item", productId: "default" }], eventSink, context);
  return {
    id: order.id,
    get: () => snapshot(order),
    authorizePayment: (transitionContext?: OrderTransitionContext) => runStep(
      order,
      "initialized",
      () => authorizePayment(order, dependencies.payment, eventSink, transitionContext),
    ),
    completeItem: (itemId: string, transitionContext?: OrderTransitionContext) => runStep(
      order,
      "payment_authorized",
      () => completeOrder(order, dependencies, eventSink, transitionContext, itemId),
    ),
    complete: (transitionContext?: OrderTransitionContext) => runStep(
      order,
      "payment_authorized",
      () => completeOrder(order, dependencies, eventSink, transitionContext),
    ),
  };
}

export function createOrderService(
  dependencies: Dependencies,
  options: OrderServiceOptions = {},
) {
  const eventSink = options.eventSink ?? stdoutOrderEventSink;
  return {
    create: (context?: OrderCreateOptions) => createOrder(dependencies, eventSink, context),
  };
}

// Run the original example only when this file is executed directly.
if (import.meta.main) {
  // Example Usage
  // import { createOrderService } from "./index";


  // Mock Deps
  const orders = createOrderService({
    payment: {
      async authorize(id) {
        console.log("Authorize payment for", id);
      },
      async void(id) {
        console.log("Void payment for", id);
      },
    },
    fulfillment: {
      async complete(id) {
        console.log("Fulfill order", id);
      },
    },
  });

  const order = orders.create();
  console.log(order.get()); // initialized

  const authorized = await order.authorizePayment();

  if (!authorized.ok) {
    console.error(authorized.error);
  } else {
    const completed = await order.complete();

    if (!completed.ok) {
      console.error(completed.error);
    }
  }

  console.log(order.get()); // current state + timestamped history
}
