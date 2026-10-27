import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { deliver } from "../src/deliver";
import { handleWebhook } from "../src/routes/webhooks";
import { Delivery, MemoryStore } from "../src/store";

const sources = { github: { secret: "s3cret", target: "http://client.test/in" } };

function sign(body: string): string {
  return createHmac("sha256", "s3cret").update(body).digest("hex");
}

function pending(): Delivery {
  return { id: "d1", source: "github", target: "http://client.test/in", body: "{}", receivedAt: new Date(), status: "pending", attempts: 0 };
}

test("deliver marks a 200 as delivered", async () => {
  const store = new MemoryStore();
  const result = await deliver(pending(), store, async () => ({ ok: true, status: 200 }));

  assert.equal(result.status, "delivered");
  assert.equal(result.attempts, 1);
  assert.equal((await store.get("d1"))?.status, "delivered");
});

test("deliver marks a 500 as failed", async () => {
  const result = await deliver(pending(), new MemoryStore(), async () => ({ ok: false, status: 500 }));

  assert.equal(result.status, "failed");
});

test("webhook with a bad signature is rejected", async () => {
  const result = await handleWebhook("github", "{}", { "x-signature": "nope" }, sources, new MemoryStore());

  assert.equal(result.status, 401);
});

test("signed webhook is stored and forwarded", async () => {
  const store = new MemoryStore();
  const body = JSON.stringify({ action: "opened" });
  const result = await handleWebhook("github", body, { "x-signature": sign(body) }, sources, store, async () => ({ ok: true, status: 200 }));

  assert.equal(result.status, 202);
  assert.equal((await store.list())[0].body, body);
});
