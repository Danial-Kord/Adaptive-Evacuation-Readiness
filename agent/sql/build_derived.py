"""Build the derived tables in derived.sql. Usage: python agent/sql/build_derived.py"""
import os
import pathlib
import re

from google.cloud import bigquery

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "qwiklabs-gcp-04-9708a89bd955")
DATASET = "evacuation_readiness"

sql = (pathlib.Path(__file__).parent / "derived.sql").read_text()
sql = "\n".join(l for l in sql.splitlines() if not l.strip().startswith("--"))
sql = re.sub(r"\$\{DS\}\.(\w+)", rf"`{PROJECT}.{DATASET}.\1`", sql)

client = bigquery.Client(project=PROJECT)
for stmt in sql.split(";"):
    body = stmt.strip()
    if not body:
        continue
    target = re.search(rf"{DATASET}\.(\w+)", body).group(1)
    client.query(body).result()
    print(f"ok  {body.split()[0]:<7} {target}")
