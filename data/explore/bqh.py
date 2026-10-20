import pandas as pd, warnings
from google.cloud import bigquery
warnings.filterwarnings("ignore")
pd.set_option("display.width", 220); pd.set_option("display.max_columns", 40); pd.set_option("display.max_colwidth", 42)
P = "qwiklabs-gcp-04-9708a89bd955"
bq = bigquery.Client(project=P)
def q(title, sql):
    sql = sql.replace("D.", f"`{P}.evacuation_readiness.").replace("$", "`")
    print(f"\n### {title}")
    print(bq.query(sql).to_dataframe().to_string(index=False))
