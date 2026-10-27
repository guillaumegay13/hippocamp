import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { deliver, Send } from "../deliver";
import { Delivery, Store } from "../store";

export type SourceConfig = { secret: string; target: string };
export type Sources = Record<string, SourceConfig>;

export type WebhookResult = { status: number; body: Record<string, unknown> };

export async function handleWebhook(
  source: string,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  sources: Sources,
  store: Store,
  send?: Send,
): Promise<WebhookResult> {
  const config = sources[source];

  if (!config) {
    return { status: 404, body: { error: "unknown source" } };
  }

  const header = headers["x-signature"];
  const signature = Array.isArray(header) ? header[0] : header;
  const expected = createHmac("sha256", config.secret).update(rawBody).digest("hex");

  if (!signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return { status: 401, body: { error: "bad signature" } };
  }

  const delivery: Delivery = {
    id: randomUUID(),
    source,
    target: config.target,
    body: rawBody,
    receivedAt: new Date(),
    status: "pending",
    attempts: 0,
  };

  await store.save(delivery);
  const result = await deliver(delivery, store, send);
  return { status: 202, body: { id: result.id, status: result.status } };
}
