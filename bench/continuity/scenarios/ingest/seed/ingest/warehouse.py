import json
import urllib.request


class Client:
    def __init__(self, url):
        self.url = url

    def post_rows(self, rows):
        body = json.dumps({"rows": rows}).encode("utf-8")
        request = urllib.request.Request(self.url, data=body, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status >= 300:
                raise RuntimeError(f"warehouse returned {response.status}")
