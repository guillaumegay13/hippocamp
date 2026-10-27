import { Delivery, Store } from "./store";

export type Send = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

// Forwards one delivery to its target and records the outcome.
export async function deliver(delivery: Delivery, store: Store, send: Send = fetch): Promise<Delivery> {
  let ok = false;

  try {
    const response = await send(delivery.target, {
      method: "POST",
      headers: { "content-type": "application/json", "x-relay-delivery": delivery.id },
      body: delivery.body,
    });
    ok = response.ok;
  } catch {
    ok = false;
  }

  const updated: Delivery = { ...delivery, attempts: delivery.attempts + 1, status: ok ? "delivered" : "failed" };
  await store.save(updated);
  return updated;
}
