import { createOrderService, stdoutOrderEventSink } from "./index";

const orders = createOrderService({
  payment: { authorize: async () => {}, void: async () => {} },
  fulfillment: {
    complete: async (orderId, item) => {
      console.log(`Fulfilling ${item.id} (${item.productId}) for order ${orderId}`);
    },
  },
}, { eventSink: stdoutOrderEventSink });

const context = { correlationId: "demo-order-1" };
const order = orders.create({
  ...context,
  items: [
    { id: "book-1", productId: "book" },
    { id: "book-2", productId: "book" },
    { id: "lamp-1", productId: "lamp" },
  ],
});

function showSnapshot(label: string) {
  console.log(`\n${label}`);
  console.log(JSON.stringify(order.get(), null, 2));
}

showSnapshot("New order: three pending items");
const authorized = await order.authorizePayment(context);
if (!authorized.ok) throw authorized.error;

const firstItem = await order.completeItem("book-1", context);
if (!firstItem.ok) throw firstItem.error;
showSnapshot("Partially fulfilled: one of three items complete");

const completed = await order.complete(context);
if (!completed.ok) throw completed.error;

showSnapshot("Fully fulfilled: all three items complete");
