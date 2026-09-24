import { expect, test } from "bun:test";
import { createOrderService, summarizeFulfillment, type OrderItem, type OrderTransitionEvent } from "./index";

const items = [{ id: "book-1", productId: "book" }, { id: "book-2", productId: "book" }];
function setup(complete: (orderId: string, item: OrderItem) => Promise<void> = async () => {}) {
  const attempts: string[] = [];
  const voids: string[] = [];
  const events: OrderTransitionEvent[] = [];
  const service = createOrderService({
    payment: { authorize: async () => {}, void: async id => { voids.push(id); } },
    fulfillment: { complete: async (id, item) => { attempts.push(item.id); await complete(id, item); } },
  }, { eventSink: event => { events.push(event); } });
  return { service, order: service.create({ items }), attempts, voids, events };
}

test("items fulfill independently and snapshots compose without losing progress", async () => {
  const { order, attempts } = setup();
  const initial = order.get();
  await order.authorizePayment();
  const first = await order.completeItem("book-1");
  expect(first.ok).toBe(true);
  if (!first.ok) throw first.error;
  expect(first.value.fulfillment).toEqual({ state: "partial", total: 2, fulfilled: 1, failed: 0, settled: false });
  expect(first.value.state).toBe("payment_authorized");
  expect((await order.complete()).ok).toBe(true);
  expect(attempts).toEqual(["book-1", "book-2"]);
  expect(order.get().state).toBe("complete");
  expect(order.get().fulfillment).toEqual({ state: "fulfilled", total: 2, fulfilled: 2, failed: 0, settled: true });
  expect(initial.items.every(item => item.fulfillment.state === "pending")).toBe(true);
  expect(first.value.fulfillment.fulfilled).toBe(1);
  expect(summarizeFulfillment([...initial.items, ...order.get().items])).toEqual({
    state: "partial", total: 4, fulfilled: 2, failed: 0, settled: false,
  });
});

test.each(["book-1", "book-2"])("mixed outcomes never void the shared payment (failure: %s)", async failingId => {
  const failure = new Error("unavailable");
  const { order, attempts, voids, events } = setup(async (_, item) => { if (item.id === failingId) throw failure; });
  await order.authorizePayment();
  expect(await order.complete()).toEqual({ ok: false, error: {
    type: "partial_fulfillment", orderId: order.id, completionError: failure,
  } });
  expect(attempts).toEqual(["book-1", "book-2"]);
  expect(voids).toEqual([]);
  expect(order.get()).toMatchObject({ state: "needs_attention", reason: "partial_fulfillment",
    fulfillment: { state: "partial", fulfilled: 1, failed: 1, settled: true } });
  expect(events.at(-1)?.reasonCode).toBe("partial_fulfillment");
  expect((await order.complete()).ok).toBe(false);
  expect(attempts).toHaveLength(2);
});

test("failure waits for outstanding items before voiding and preserves every failure", async () => {
  const { order, voids } = setup(async (_, item) => { throw item.id; });
  await order.authorizePayment();
  expect((await order.completeItem("book-1")).ok).toBe(false);
  expect(order.get().state).toBe("payment_authorized");
  expect(order.get().fulfillment.settled).toBe(false);
  expect(voids).toEqual([]);
  await order.complete();
  expect(voids).toEqual([order.id]);
  expect(order.get()).toMatchObject({ state: "cancelled", cause: [
    { itemId: "book-1", cause: "book-1" }, { itemId: "book-2", cause: "book-2" },
  ], fulfillment: { state: "unfulfilled", failed: 2, settled: true } });
});

test("invalid and repeated item requests have no side effects", async () => {
  const { order, attempts } = setup();
  expect((await order.completeItem("book-1")).ok).toBe(false);
  await order.authorizePayment();
  const authorized = order.get();
  expect(await order.completeItem("missing")).toEqual({ ok: false, error: { type: "unknown_item", itemId: "missing" } });
  expect(order.get()).toEqual(authorized);
  await order.completeItem("book-1");
  const partial = order.get();
  expect(await order.completeItem("book-1")).toEqual({ ok: false, error: { type: "item_already_attempted", itemId: "book-1" } });
  expect(order.get()).toEqual(partial);
  expect(attempts).toEqual(["book-1"]);
});

test("in-flight fulfillment is visible and overlapping item operations are rejected", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const { order, attempts } = setup(async () => pending);
  await order.authorizePayment();
  const completing = order.completeItem("book-1");
  try {
    expect(order.get().items[0]!.fulfillment.state).toBe("fulfilling");
    expect(await order.completeItem("book-2")).toEqual({ ok: false, error: { type: "operation_in_progress" } });
    expect(attempts).toEqual(["book-1"]);
  } finally { release(); }
  expect((await completing).ok).toBe(true);
});

test("item inputs and snapshot structures cannot mutate live order data", async () => {
  const { service } = setup();
  const input = items.map(item => ({ ...item }));
  const order = service.create({ items: input });
  input[0]!.id = "changed";
  const edited = order.get();
  edited.items[0]!.fulfillment.state = "fulfilled";
  edited.items[0]!.productId = "changed";
  edited.items.pop();
  edited.fulfillment.fulfilled = 100;
  expect(order.get().items).toEqual(items.map(item => ({ ...item, fulfillment: { state: "pending" } })));
  expect(order.get().fulfillment.fulfilled).toBe(0);
});

test("empty orders and duplicate item IDs are rejected before events or effects", () => {
  const { service, events } = setup();
  const count = events.length;
  expect(() => service.create({ items: [] })).toThrow();
  expect(() => service.create({ items: [items[0]!, items[0]!] })).toThrow();
  expect(events).toHaveLength(count);
  expect(summarizeFulfillment([])).toEqual({ state: "unfulfilled", total: 0, fulfilled: 0, failed: 0, settled: false });
});
