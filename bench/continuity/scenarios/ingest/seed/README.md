# ingest

Reads vendor order exports (CSV), normalizes the columns, drops duplicate orders and posts the rows to the warehouse HTTP API at `WAREHOUSE_URL`.

Supported vendors: `vendor_a`.

```sh
python3 -m unittest
WAREHOUSE_URL=http://localhost:8080/rows python3 -m ingest.cli vendor_a fixtures/vendor_a.csv
```
