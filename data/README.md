# data/

**This folder is empty, and that is the design.**

Everything this challenge uses is pulled live from its original publisher by
`notebooks/c4_01_load_explore.ipynb` and loaded straight into BigQuery in **your** project. Nothing
is pre-cleaned and handed to you, because the cleaning decisions *are* the teaching—a shipped
table would hide six real defects in federal data that you should see happen.

If a publisher is having a bad morning, `bash scripts/load.sh <STATE>` rebuilds the identical tables
from a Cloud Storage snapshot instead.

## Where the data actually lives

After the notebook or `load.sh` runs, in `<your-project>.evacuation_readiness`:

| Table | Grain | What it holds |
|---|---|---|
| `shelters` | one row per registered facility | capacity, wheelchair access, generator, surge and floodplain exposure, medical-needs designation, county |
| `vulnerability_tracts` | one row per census tract | no-vehicle households, 65+, disability, limited English, group quarters, mobile homes, coordinates |
| `hazard_tracts` | one row per census tract | hurricane and coastal-flood exposure and expected annual loss |
| `care_facilities` | one row per nursing home | coordinates and certified bed count |
| `power_dependent_counties` | one row per county | Medicare beneficiaries relying on electricity for medical equipment |

## If you add your own data

You may, and it earns credit—but the license rules on the challenge card apply to anything you
bring, and they are not a formality. A winning project gets promoted publicly, so an unchecked
share-alike or non-commercial source becomes somebody else's legal problem.

Put small reference files here and commit them. Anything large, or anything pulled live, belongs in
BigQuery rather than in git.
