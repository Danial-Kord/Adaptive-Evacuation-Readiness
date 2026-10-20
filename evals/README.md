# Evals

20 questions the agent's real users would ask, run against the **deployed** agent, each graded two
ways: deterministic checks (tools called, required/forbidden content, latency) and an LLM judge
scoring the answer the way the emergency manager would read it.

```bash
python evals/run_evals.py                  # all cases vs the Cloud Run endpoint
python evals/run_evals.py --only Q K3      # case-id prefixes
python evals/run_evals.py --local          # in-process, for iterating on prompts
```
Reports land in `evals/results/<timestamp>/report.md` with every transcript (good demo material).

## Who we designed the answers for
A county emergency manager in August, writing the pre-season brief. She reads between meetings,
forwards pieces to transit/health/school staff, and must defend every number to her director. So
every answer is:

1. **Bottom line first** — one or two sentences with the key number.
2. **Do this before September** — numbered, assignable actions with counts.
3. **Evidence** — compact tables; every fact tagged `FEMA record (historical)`,
   `Google Maps (live, date)`, `ACS (measured)`, `CDC PLACES (modeled)`, `HHS emPOWER (county-level)`;
   Google Maps sources directly under what they support.
4. **What I could not tell you** — counted, never hidden.

Miles and drive minutes; place names before tract ids; no internal scores; ~300 words by default,
500–700 for the full brief.

## The cases
| Group | What it proves |
|---|---|
| **Q1–Q7** | The seven questions from the challenge brief, answered with the right tool each |
| **T1–T7 (traps)** | Where a confident wrong answer is the failure: blank ≠ "no" (T1), area accessibility questions Maps can't answer (T2), requests to identify individuals (T3), active emergencies → 911 (T4), race as a ranking input (T5), states we haven't loaded (T6), block-level power dependence (T7) |
| **K1–K6** | Live drive times, the equity audit stated plainly, the full brief, another county, honest capacity math, and the shelter-operator interview |

## What the evals caught (and we fixed)
- Brief was 1,858 words → capped at ~700 with one table per segment.
- A drive time routed from one tract was reused for a different tract sharing the shelter → now only shown for its origin.
- A shelter with 0 recorded capacity was marked usable → now flagged "confirm capacity".
- Mislabelled emPOWER field ("home dialysis") → renamed to facility dialysis patients.
- Agent explored schemas before answering (53 s on a refusal) → schema in the prompt; 15 s.
- Operator interview noted "ramp locked after 6pm" without saying it means no unaccompanied access → fixed.
- Accessibility claims from Maps are only accepted when Gemini's grounding metadata cites a Maps source.
