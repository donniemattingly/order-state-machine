import { expect, test } from "bun:test";
import { createOrderService, type Fulfillment, type Payment, type State } from "./index";

const scenarios = [
  { name: "happy path", decline: false, completionFails: false, voidFails: false, state: "complete", error: undefined },
  { name: "payment decline", decline: true, completionFails: false, voidFails: false, state: "rejected", error: "payment_declined" },
  { name: "completion failure with successful void", decline: false, completionFails: true, voidFails: false, state: "cancelled", error: "completion_failed" },
  { name: "completion failure with failed void", decline: false, completionFails: true, voidFails: true, state: "needs_attention", error: "needs_attention" },
] as const;

for (const scenario of scenarios) {
  test(scenario.name, async () => {
    const calls: { operation: string; id: string }[] = [];
    const declineError = new Error("declined");
    const completionError = new Error("completion failed");
    const voidError = new Error("void failed");
    const operation = (name: string, fails: boolean, error: Error) => async (id: string) => {
      calls.push({ operation: name, id });
      if (fails) throw error;
    };
    const order = createOrderService({
      payment: {
        authorize: operation("authorize", scenario.decline, declineError),
        void: operation("void", scenario.voidFails, voidError),
      },
      fulfillment: { complete: operation("complete", scenario.completionFails, completionError) },
    }).create();
    const before = Date.now();
    expect(order.get().state).toBe("initialized");

    const authorization = await order.authorizePayment();
    expect(authorization.ok).toBe(!scenario.decline);
    expect(order.get().state).toBe(scenario.decline ? "rejected" : "payment_authorized");
    const result = scenario.decline ? authorization : await order.complete();
    expect(result.ok).toBe(scenario.error === undefined);
    if (!result.ok) {
      expect(result.error.type).toBe(scenario.error!);
      if (result.error.type === "needs_attention") {
        expect(result.error.orderId).toBe(order.id);
        expect(result.error.completionError).toBe(completionError);
        expect(result.error.voidError).toBe(voidError);
      } else if ("cause" in result.error) {
        expect(result.error.cause).toBe(scenario.decline ? declineError : completionError);
      }
    } else expect(result.value).toEqual(order.get());

    const snapshot = order.get();
    expect(snapshot.state).toBe(scenario.state);
    const states: State["state"][] = scenario.decline
      ? ["initialized", "rejected"]
      : ["initialized", "payment_authorized", scenario.state];
    expect(snapshot.history.map(entry => entry.state)).toEqual(states);
    if (snapshot.state === "needs_attention") {
      expect(snapshot.completionError).toBe(completionError);
      expect(snapshot.voidError).toBe(voidError);
    } else if (snapshot.state === "rejected" || snapshot.state === "cancelled") {
      expect(snapshot.cause).toBe(scenario.decline ? declineError : completionError);
    }
    const timestamps = snapshot.history.map(entry => entry.at);
    expect(timestamps.slice(1).every(at => at >= before && at <= Date.now())).toBe(true);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    const expectedCalls = scenario.decline ? ["authorize"]
      : scenario.completionFails ? ["authorize", "complete", "void"] : ["authorize", "complete"];
    expect(calls).toEqual(expectedCalls.map(operation => ({ operation, id: order.id })));

    // Every terminal state rejects both actions without additional side effects.
    for (const action of [order.authorizePayment, order.complete]) {
      const terminal = await action();
      expect(terminal.ok).toBe(false);
      if (!terminal.ok) expect(terminal.error.type).toBe("invalid_transition");
    }
    expect(order.get()).toEqual(snapshot);
    expect(calls).toHaveLength(expectedCalls.length);
  });
}

function setup(payment: Partial<Payment> = {}, fulfillment: Partial<Fulfillment> = {}) {
  return createOrderService({
    payment: { authorize: async () => {}, void: async () => {}, ...payment },
    fulfillment: { complete: async () => {}, ...fulfillment },
  });
}

test("out-of-order actions do not call dependencies or change history", async () => {
  let authorizations = 0;
  let completions = 0;
  const order = setup(
    { authorize: async () => { authorizations++; } },
    { complete: async () => { completions++; } },
  ).create();
  const initial = order.get();
  expect(await order.complete()).toEqual({ ok: false, error: {
    type: "invalid_transition", state: "initialized", expected: "payment_authorized",
  } });
  expect(order.get()).toEqual(initial);
  expect(completions).toBe(0);
  await order.authorizePayment();
  const authorized = order.get();
  expect((await order.authorizePayment()).ok).toBe(false);
  expect(order.get()).toEqual(authorized);
  expect(authorizations).toBe(1);
});

test("overlapping actions are rejected while other orders can proceed", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let authorizations = 0;
  const orders = setup({ authorize: async () => {
    authorizations++;
    if (authorizations === 1) await pending;
  } });
  const order = orders.create();
  const first = order.authorizePayment();
  try {
    for (const action of [order.authorizePayment, order.complete]) {
      expect(await action()).toEqual({ ok: false, error: { type: "operation_in_progress" } });
    }
    expect(authorizations).toBe(1);
    const another = orders.create();
    expect(another.id).not.toBe(order.id);
    expect((await another.authorizePayment()).ok).toBe(true);
  } finally { release(); }
  expect((await first).ok).toBe(true);
  expect((await order.complete()).ok).toBe(true);
  expect(order.get().history.map(entry => entry.state)).toEqual(["initialized", "payment_authorized", "complete"]);
});

test("snapshots cannot mutate an order and remain stable after later transitions", async () => {
  const order = setup().create();
  const initial = order.get();
  const edited = order.get();
  edited.state = "complete";
  edited.history[0]!.state = "complete";
  edited.history.push({ state: "cancelled", at: 0 });
  expect(order.get()).toEqual(initial);
  const authorized = await order.authorizePayment();
  expect(initial.history).toHaveLength(1);
  if (!authorized.ok) throw new Error("Expected authorization to succeed");
  authorized.value.history.length = 0;
  expect(order.get().history).toHaveLength(2);
});

test("synchronous throws and non-cloneable failure details are also surfaced", async () => {
  const voidFailure = { message: "void unavailable", retry: () => {} };
  const order = setup(
    { void: () => { throw voidFailure; } },
    { complete: () => { throw "completion unavailable"; } },
  ).create();
  await order.authorizePayment();
  expect(await order.complete()).toEqual({ ok: false, error: {
    type: "needs_attention", orderId: order.id,
    completionError: "completion unavailable", voidError: voidFailure,
  } });
  const snapshot = order.get();
  expect(snapshot.state).toBe("needs_attention");
  if (snapshot.state === "needs_attention") expect(snapshot.voidError).toBe(voidFailure);
});
