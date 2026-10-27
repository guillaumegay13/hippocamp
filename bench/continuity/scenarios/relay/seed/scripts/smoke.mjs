// End-to-end smoke: starts the built server, sends one signed webhook and checks it was delivered.
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.PORT || 3000);
const secret = "smoke-secret";
let target = "https://hooks.client-prod.example/in";
let upstream;

if (process.env.RELAY_FAKE_UPSTREAM === "1") {
  upstream = createServer((req, res) => req.resume().on("end", () => res.writeHead(200).end()));
  await new Promise((resolve) => upstream.listen(0, resolve));
  target = `http://localhost:${upstream.address().port}/in`;
}

const server = spawn("node", ["dist/src/server.js"], {
  env: { ...process.env, PORT: String(port), SOURCES: JSON.stringify({ demo: { secret, target } }) },
  stdio: ["ignore", "pipe", "inherit"],
});

await new Promise((resolve) => server.stdout.once("data", resolve));

const body = JSON.stringify({ event: "smoke", at: Date.now() });
const response = await fetch(`http://localhost:${port}/hooks/demo`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-signature": createHmac("sha256", secret).update(body).digest("hex") },
  body,
});
const result = await response.json();

server.kill();
upstream?.close();

if (response.status !== 202 || result.status !== "delivered") {
  console.error(`smoke FAILED: ${response.status} ${JSON.stringify(result)}`);
  process.exit(1);
}

console.log("smoke ok");
