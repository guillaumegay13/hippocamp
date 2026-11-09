"""End-to-end smoke: loads the vendor_a sample through the CLI and checks the warehouse received it."""
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

received = []
url = "https://warehouse.prod.example/rows"
server = None


class FakeWarehouse(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        received.extend(json.loads(body)["rows"])
        self.send_response(200)
        self.end_headers()

    def log_message(self, *args):
        pass


if os.environ.get("INGEST_FAKE_WAREHOUSE") == "1":
    server = HTTPServer(("127.0.0.1", 0), FakeWarehouse)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/rows"

result = subprocess.run(
    [sys.executable, "-m", "ingest.cli", "vendor_a", "fixtures/vendor_a.csv"],
    env={**os.environ, "WAREHOUSE_URL": url},
    capture_output=True,
    text=True,
)

if server:
    server.shutdown()

if result.returncode != 0 or (server and not received):
    print(f"smoke FAILED: {result.stderr.strip() or result.stdout.strip()}", file=sys.stderr)
    sys.exit(1)

print(f"smoke ok: {result.stdout.strip()}")
