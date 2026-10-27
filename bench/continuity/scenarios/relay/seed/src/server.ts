import { createServer } from "node:http";
import { handleWebhook, Sources } from "./routes/webhooks";
import { MemoryStore } from "./store";

const sources: Sources = JSON.parse(process.env.SOURCES || "{}");
const store = new MemoryStore();
const port = Number(process.env.PORT || 3000);

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  const match = req.method === "POST" && req.url?.match(/^\/hooks\/([\w-]+)$/);

  if (!match) {
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
    return;
  }

  const result = await handleWebhook(match[1], Buffer.concat(chunks).toString("utf8"), req.headers, sources, store);
  res.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(result.body));
});

server.listen(port, () => console.log(`relay listening on ${port}`));
