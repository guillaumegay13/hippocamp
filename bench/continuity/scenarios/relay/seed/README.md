# relay

Receives webhooks on `POST /hooks/:source`, checks the HMAC-SHA256 signature, stores the delivery and forwards the body to the source's target URL.

Sources are configured with the `SOURCES` env var, a JSON object:

```json
{ "github": { "secret": "dev-secret", "target": "http://localhost:4000/in" } }
```

```sh
npm install
npm test
SOURCES='{...}' npm start
```
