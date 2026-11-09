import hashlib
import json

from ingest.reader import read


def row_hash(row):
    return hashlib.sha256(json.dumps(row, sort_keys=True).encode("utf-8")).hexdigest()


def dedupe(rows):
    """Keep the first occurrence of each (vendor, order_id), in file order."""
    seen = set()
    kept = []
    for row in rows:
        key = (row["vendor"], row["order_id"])
        if key in seen:
            continue
        seen.add(key)
        kept.append({**row, "row_hash": row_hash(row)})
    return kept


def load_file(vendor, path, client):
    rows = dedupe(read(vendor, path))
    client.post_rows(rows)
    return len(rows)
