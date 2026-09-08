
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
  | { state: "needs_attention"; completionError: unknown; voidError: unknown };

// You get this clean history almost for free approaching the problem like this  
export type OrderSnapshot = State & {
  id: string;
  history: { state: State["state"]; at: number }[];
};

// Same idea as for the `State`. In a glance you can see all the types of errors we've thought about. 
export type OrderError =
  | { type: "operation_in_progress" }
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
  complete(id: string): Promise<void>;
}

// we need a service that can handle payments and one that can fulfill an order
type Dependencies = { payment: Payment; fulfillment: Fulfillment };

// everything you need to know about an order to take the correct next action
type OrderRecord = {
  id: string;
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

function historyEntry({ state }: State) {
  return { state, at: Date.now() };
}


// the ergonomics of the history here are admittedly a bit clunky. `move` below on an empty order maybe.
function createOrderRecord(): OrderRecord {
  const current: State = { state: "initialized" };
  return {
    id: crypto.randomUUID(),
    current,
    busy: false,
    history: [historyEntry(current)],
  };
}


// since JSON.parse(JSON.stringify(stuff)) won't work
function snapshot(order: OrderRecord): OrderSnapshot {
  return {
    ...order.current,
    id: order.id,
    history: order.history.map(entry => ({ ...entry })),
  };
}

// convenience function to progress an order. this is bookkeeping as opposed to what actually changes the order
function move(order: OrderRecord, next: State): OrderSnapshot {
  order.current = next;
  order.history.push(historyEntry(next));
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
function rejectOrder(order: OrderRecord, cause: unknown): OrderResult {
  move(order, { state: "rejected", cause });
  return fail({ type: "payment_declined", cause });
}

function cancelOrder(order: OrderRecord, cause: unknown): OrderResult {
  move(order, { state: "cancelled", cause });
  return fail({ type: "completion_failed", cause });
}

function markNeedsAttention(
  order: OrderRecord,
  completionError: unknown,
  voidError: unknown,
): OrderResult {
  move(order, { state: "needs_attention", completionError, voidError });
  return fail({ type: "needs_attention", orderId: order.id, completionError, voidError });
}


// here we get into the actual business logic. all the ceremony before now lets us (hopefully)
// in addition to accomplishing the primary business logic be expressive with our intent 

// Payment is declined → reject the order. No cleanup needed.
async function authorizePayment(order: OrderRecord, payment: Payment): Promise<OrderResult> {
  const result = await attempt(() => payment.authorize(order.id));
  if (!result.ok) return rejectOrder(order, result.error);
  return succeed(move(order, { state: "payment_authorized" }));
}


// Completion fails and the void also fails → move to needs_attention for manual resolution. 
// Don't silently swallow the error.
async function recoverCompletion(
  order: OrderRecord,
  payment: Payment,
  completionError: unknown,
): Promise<OrderResult> {
  const result = await attempt(() => payment.void(order.id));
  if (!result.ok) return markNeedsAttention(order, completionError, result.error);
  return cancelOrder(order, completionError);
}

// Completion fails after payment was authorized → void the payment, then mark the order as cancelled.
async function completeOrder(
  order: OrderRecord,
  { payment, fulfillment }: Dependencies,
): Promise<OrderResult> {
  const result = await attempt(() => fulfillment.complete(order.id));
  if (!result.ok) return recoverCompletion(order, payment, result.error);
  return succeed(move(order, { state: "complete" }));
}


// the final interface is simple while clearly coordinating everything that needs to happen
function createOrder(dependencies: Dependencies) {
  const order = createOrderRecord();
  return {
    id: order.id,
    get: () => snapshot(order),
    authorizePayment: () => runStep(order, "initialized", () => authorizePayment(order, dependencies.payment)),
    complete: () => runStep(order, "payment_authorized", () => completeOrder(order, dependencies)),
  };
}

export function createOrderService(dependencies: Dependencies) {
  return { create: () => createOrder(dependencies) };
}

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
