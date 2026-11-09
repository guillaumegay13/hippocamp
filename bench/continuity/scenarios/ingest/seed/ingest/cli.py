import os
import sys

from ingest.load import load_file
from ingest.warehouse import Client


def main(argv):
    if len(argv) != 2:
        print("usage: python3 -m ingest.cli <vendor> <path>", file=sys.stderr)
        return 2
    count = load_file(argv[0], argv[1], Client(os.environ["WAREHOUSE_URL"]))
    print(f"loaded {count} rows")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
