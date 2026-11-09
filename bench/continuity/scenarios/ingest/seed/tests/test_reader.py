import os
import unittest

from ingest.load import load_file
from ingest.reader import read

FIXTURES = os.path.join(os.path.dirname(__file__), "..", "fixtures")


class FakeClient:
    def __init__(self):
        self.requests = []

    def post_rows(self, rows):
        self.requests.append(rows)


class ReaderTest(unittest.TestCase):
    def test_vendor_a_columns_are_normalized(self):
        rows = read("vendor_a", os.path.join(FIXTURES, "vendor_a.csv"))
        self.assertEqual(rows[0]["order_id"], "A-1001")
        self.assertEqual(rows[0]["amount"], 42.5)
        self.assertEqual(rows[0]["created_at"], "2025-03-04 14:22:10")

    def test_unknown_vendor_is_rejected(self):
        with self.assertRaises(ValueError):
            read("vendor_x", "missing.csv")


class LoadTest(unittest.TestCase):
    def test_duplicate_orders_are_dropped(self):
        client = FakeClient()
        count = load_file("vendor_a", os.path.join(FIXTURES, "vendor_a.csv"), client)
        self.assertEqual(count, 19)
        order_ids = [row["order_id"] for row in client.requests[0]]
        self.assertEqual(len(order_ids), len(set(order_ids)))


if __name__ == "__main__":
    unittest.main()
