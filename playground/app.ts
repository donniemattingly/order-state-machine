import { createStateScene, type SceneChoice } from "./scene";
import { createOrderService, type State } from "../index";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}
const reset = element<HTMLButtonElement>("reset");
const history = element<HTMLOListElement>("history");
const calls = element<HTMLOListElement>("calls");
const status = element("status");
const result = element("result");
const descriptions: Record<State["state"], string> = {
  initialized: "Choose the payment outcome on the graph.",
  payment_authorized: "Payment is authorized. Fulfill the order, or make fulfillment fail.",
  complete: "Order fulfilled. Start a new order to explore another path.",
  rejected: "Payment declined. No cleanup needed. Start a new order to try again.",
  cancelled: "Payment voided after fulfillment failed. The order is cancelled.",
  needs_attention: "Payment recovery or partial fulfillment needs manual resolution. See the snapshot for details.",
};
let visualization: ReturnType<typeof createStateScene> | undefined;
try {
  visualization = createStateScene(element("scene"));
} catch (error) {
  element("scene").hidden = true;
  element("fallback-actions").hidden = false;
  console.warn("3D visualization unavailable; using accessible action buttons", error);
}
element("home-view").addEventListener("click", () => visualization?.home());
window.addEventListener("pagehide", event => { if (!event.persisted) visualization?.dispose(); });

let busy = false;
let selectedFailure = false;
let decideVoid: ((succeeds: boolean) => void) | undefined;
let order: ReturnType<ReturnType<typeof createOrderService>["create"]>;
function log(message: string) {
  const item = document.createElement("li");
  item.textContent = message;
  calls.append(item);
}
function format(value: unknown) {
  return JSON.stringify(value, (_, item) => item instanceof Error ? { message: item.message } : item, 2);
}
function choices(): SceneChoice[] {
  if (decideVoid) return [
    { target: "cancelled", label: "Void succeeds", choose: () => settleVoid(true) },
    { target: "needs_attention", label: "Void fails", choose: () => settleVoid(false) },
  ];
  if (busy) return [];
  if (order.get().state === "initialized") return [
    { target: "payment_authorized", label: "Authorize payment", choose: () => void run("authorizePayment", false) },
    { target: "rejected", label: "Decline payment", choose: () => void run("authorizePayment", true) },
  ];
  if (order.get().state === "payment_authorized") return [
    { target: "complete", label: "Fulfill order", choose: () => void run("complete", false) },
    { target: "fail_fulfillment", label: "Fail fulfillment", choose: () => void run("complete", true) },
  ];
  return [];
}
function render() {
  const snapshot = order.get();
  element("order-id").textContent = snapshot.id;
  element("current").textContent = snapshot.state;
  status.textContent = decideVoid
    ? "Fulfillment failed. Recovery is waiting: choose whether the payment void succeeds or fails."
    : busy ? "Applying your choice…" : descriptions[snapshot.state];
  element("phase").textContent = decideVoid ? "CHOOSE VOID OUTCOME" : busy ? "TRANSITIONING" : snapshot.state === "initialized" ? "CHOOSE PAYMENT OUTCOME" : snapshot.state === "payment_authorized" ? "CHOOSE FULFILLMENT OUTCOME" : "TERMINAL STATE";
  reset.disabled = busy;
  const available = choices();
  visualization?.update(snapshot, busy, available);
  element("fallback-actions").replaceChildren(...available.map(choice => {
    const button = document.createElement("button");
    button.textContent = choice.label;
    button.onclick = choice.choose;
    return button;
  }));
  history.replaceChildren(...snapshot.history.map((entry, index) => {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = entry.state;
    const time = document.createElement("span");
    time.textContent = `${new Date(entry.at).toLocaleTimeString()} · +${entry.at - snapshot.history[0]!.at} ms`;
    item.append(`${index + 1}. `, title, time);
    return item;
  }));
  element("snapshot").textContent = format(snapshot);
}
async function effect(name: string) {
  log(`${name} → started`);
  if (selectedFailure) {
    log(`${name} → failed`);
    throw new Error(`${name} failed (chosen in playground)`);
  }
  log(`${name} → succeeded`);
}
function settleVoid(succeeds: boolean) {
  const settle = decideVoid;
  decideVoid = undefined;
  render();
  settle?.(succeeds);
}
function newOrder() {
  if (busy) return;
  calls.replaceChildren();
  result.textContent = "Choose a highlighted destination to begin.";
  order = createOrderService({
    payment: {
      authorize: () => effect("Authorize payment"),
      async void() {
        log("Void payment → awaiting your decision");
        const succeeds = await new Promise<boolean>(resolve => {
          decideVoid = resolve;
          render();
        });
        log(`Void payment → ${succeeds ? "succeeded" : "failed"}`);
        if (!succeeds) throw new Error("Void payment failed (chosen in playground)");
      },
    },
    fulfillment: { complete: () => effect("Fulfill order") },
  }).create();
  render();
}
async function run(action: "authorizePayment" | "complete", fails: boolean) {
  if (busy) return;
  selectedFailure = fails;
  busy = true;
  result.textContent = "Operation in progress…";
  render();
  try {
    result.textContent = format(await order[action]());
  } catch (error) {
    result.textContent = format({ unexpectedError: error });
  } finally {
    busy = false;
    render();
  }
}
reset.addEventListener("click", newOrder);
newOrder();
