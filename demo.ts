import { createOrderService } from "./index";

const orders = createOrderService({
  payment: { authorize: async () => {}, void: async () => {} },
  fulfillment: { complete: async () => {} },
});

const order = orders.create();
const authorized = await order.authorizePayment();
if (!authorized.ok) throw authorized.error;
const completed = await order.complete();
if (!completed.ok) throw completed.error;
console.log(order.get());
