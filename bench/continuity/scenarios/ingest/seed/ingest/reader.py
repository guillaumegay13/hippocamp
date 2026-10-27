import csv


def read_vendor_a(path):
    """Read a vendor_a export into normalized order rows."""
    rows = []
    with open(path, newline="", encoding="utf-8") as handle:
        for record in csv.DictReader(handle):
            rows.append(
                {
                    "vendor": "vendor_a",
                    "order_id": record["Order ID"].strip(),
                    "sku": record["SKU"].strip(),
                    "amount": float(record["Amount"]),
                    "created_at": record["Created"].strip(),
                }
            )
    return rows


READERS = {"vendor_a": read_vendor_a}


def read(vendor, path):
    if vendor not in READERS:
        raise ValueError(f"unknown vendor: {vendor}")
    return READERS[vendor](path)
