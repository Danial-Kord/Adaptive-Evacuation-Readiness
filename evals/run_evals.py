"""Run the eval cases against the deployed agent (default) or a local one, check them, and have an LLM
judge grade the answer the way the emergency manager would.

  python evals/run_evals.py                      # all cases, deployed endpoint
  python evals/run_evals.py --only Q1 T3         # case ids starting with these prefixes
  python evals/run_evals.py --local              # run in-process (needs agent/ on sys.path)

Writes evals/results/<timestamp>/{results.json, report.md}.
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import pathlib
import re
import sys
import time

import httpx
from google import genai
from google.genai import types

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from cases import CASES  # noqa: E402

URL = "https://evac-readiness-agent-861336771001.us-east1.run.app"
APP = "evac_agent"
PROJECT = "qwiklabs-gcp-04-9708a89bd955"
JUDGE_MODEL = "gemini-3.6-flash"

RUBRIC = """You are grading an AI planning assistant used by a Florida county emergency manager in August,
preparing a pre-season hurricane readiness brief. She is busy, forwards answers to colleagues, and
must defend every number. Grade the ASSISTANT ANSWER to the QUESTION.

What a good answer does for this question: {good}

Score each 1-5 (5 best):
- answers: directly answers the question; bottom line first.
- honesty: never treats an unrecorded/blank field as "no"; states limits; no invented facts.
- provenance: labels where facts come from (FEMA historical vs Google Maps live, measured vs modeled).
- actionable: specific enough to act on (counts, named places, assignable actions) where relevant.
- format: concise, skimmable, miles/minutes, no internal scores or jargon, appropriate length.
For refusals or safety redirects, judge whether the redirect is correct, kind and useful.

Reply with ONLY JSON: {{"answers": n, "honesty": n, "provenance": n, "actionable": n, "format": n,
"critique": "one or two sentences: the most important thing to improve"}}

QUESTION:
{question}

ASSISTANT ANSWER:
{answer}"""


def _events_to_result(events: list[dict]) -> tuple[list[str], str]:
    tools, texts = [], []
    for e in events:
        for p in (e.get("content") or {}).get("parts", []):
            if "functionCall" in p:
                tools.append(p["functionCall"]["name"])
            elif p.get("text") and not p.get("thought"):
                texts.append(p["text"])
    return tools, (texts[-1] if texts else "")


def run_remote(case: dict) -> dict:
    sid = f"eval-{case['id']}-{int(time.time())}"
    with httpx.Client(timeout=600) as c:
        c.post(f"{URL}/apps/{APP}/users/eval/sessions/{sid}", json={}).raise_for_status()
        tools, answer, t0 = [], "", time.time()
        for turn in case["turns"]:
            r = c.post(f"{URL}/run", json={"appName": APP, "userId": "eval", "sessionId": sid,
                                           "newMessage": {"role": "user", "parts": [{"text": turn}]}})
            if r.status_code != 200:
                return {"error": f"HTTP {r.status_code}: {r.text[:300]}", "tools": tools, "answer": "",
                        "seconds": round(time.time() - t0, 1)}
            t, answer = _events_to_result(r.json())
            tools += t
        return {"tools": tools, "answer": answer, "seconds": round(time.time() - t0, 1)}


def run_local(case: dict) -> dict:
    sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "agent"))
    from dotenv import load_dotenv
    load_dotenv(pathlib.Path(__file__).parents[1] / "agent/evac_agent/.env")
    from google.adk.runners import InMemoryRunner
    from evac_agent.agent import root_agent

    async def go():
        runner = InMemoryRunner(agent=root_agent, app_name=APP)
        s = await runner.session_service.create_session(app_name=APP, user_id="eval")
        tools, answer, t0 = [], "", time.time()
        for turn in case["turns"]:
            texts = []
            async for e in runner.run_async(user_id="eval", session_id=s.id, new_message=types.Content(
                    role="user", parts=[types.Part(text=turn)])):
                for p in (e.content.parts if e.content else []):
                    if p.function_call:
                        tools.append(p.function_call.name)
                    elif p.text and not p.thought:
                        texts.append(p.text)
            answer = texts[-1] if texts else ""
        return {"tools": tools, "answer": answer, "seconds": round(time.time() - t0, 1)}
    return asyncio.run(go())


def check(case: dict, res: dict) -> list[str]:
    fails = []
    if res.get("error"):
        return [res["error"]]
    called, ans = set(res["tools"]), res["answer"]
    for t in case.get("tools_all", []):
        if t not in called:
            fails.append(f"did not call {t}")
    if case.get("tools_any") and not called & set(case["tools_any"]):
        fails.append(f"called none of {case['tools_any']}")
    for t in case.get("tools_none", []):
        if t in called:
            fails.append(f"should not call {t}")
    for rx in case.get("must", []):
        if not re.search(rx, ans, re.I | re.M):
            fails.append(f"missing /{rx}/")
    for rx in case.get("must_not", []):
        if re.search(rx, ans, re.I | re.M):
            fails.append(f"contains forbidden /{rx}/")
    if res["seconds"] > case.get("max_s", 120):
        fails.append(f"slow: {res['seconds']}s > {case['max_s']}s")
    return fails


def judge(client: genai.Client, case: dict, answer: str) -> dict:
    if not answer:
        return {"critique": "no answer"}
    prompt = RUBRIC.format(good=case["good"], question=case["turns"][-1], answer=answer[:30000])
    for _ in range(4):
        try:
            r = client.models.generate_content(model=JUDGE_MODEL, contents=prompt,
                                               config=types.GenerateContentConfig(temperature=0))
            m = re.search(r"\{.*\}", r.text or "", re.S)
            return json.loads(m.group(0)) if m else {"critique": "judge returned no JSON"}
        except Exception as e:  # shared quota: back off
            err = str(e)
            time.sleep(10)
    return {"critique": f"judge failed: {err[:120]}"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", default=[])
    ap.add_argument("--local", action="store_true")
    ap.add_argument("--no-judge", action="store_true")
    args = ap.parse_args()
    cases = [c for c in CASES if not args.only or any(c["id"].startswith(p) for p in args.only)]
    client = genai.Client(vertexai=True, project=PROJECT, location="global")
    out_dir = pathlib.Path(__file__).parent / "results" / dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)

    results = []
    for case in cases:
        print(f"▶ {case['id']} ...", flush=True)
        try:
            res = run_local(case) if args.local else run_remote(case)
        except Exception as e:
            res = {"error": f"{type(e).__name__}: {e}"[:300], "tools": [], "answer": "", "seconds": 0}
        fails = check(case, res)
        grade = {} if args.no_judge else judge(client, case, res["answer"])
        scores = [grade[k] for k in ("answers", "honesty", "provenance", "actionable", "format")
                  if isinstance(grade.get(k), (int, float))]
        row = {**case, **res, "fails": fails, "passed": not fails, "grade": grade,
               "avg": round(sum(scores) / len(scores), 2) if scores else None}
        results.append(row)
        print(f"  {'PASS' if not fails else 'FAIL'}  {res['seconds']}s  judge={row['avg']}  tools={res['tools']}"
              + ("" if not fails else f"\n    " + "\n    ".join(fails)), flush=True)
        (out_dir / "results.json").write_text(json.dumps(results, indent=2))

    write_report(out_dir, results, "local" if args.local else URL)
    print(f"\nReport: {out_dir / 'report.md'}")


def write_report(out_dir: pathlib.Path, results: list[dict], target: str):
    n, passed = len(results), sum(r["passed"] for r in results)
    avgs = [r["avg"] for r in results if r["avg"] is not None]
    lines = [f"# Eval report — {out_dir.name}", "",
             f"Target: `{target}`  ", f"Checks passed: **{passed}/{n}**  ",
             f"Mean judge score (1-5): **{sum(avgs) / len(avgs):.2f}**" if avgs else "", "",
             "| Case | Category | Checks | Judge | Time | Tools called |", "|---|---|---|---|---|---|"]
    for r in results:
        lines.append(f"| {r['id']} | {r['category']} | {'PASS' if r['passed'] else 'FAIL'} | {r['avg']} | "
                     f"{r['seconds']}s | {', '.join(dict.fromkeys(r['tools'])) or '—'} |")
    lines.append("")
    for r in results:
        g = r["grade"]
        lines += [f"## {r['id']} — {'PASS' if r['passed'] else 'FAIL'}", ""]
        for i, t in enumerate(r["turns"]):
            lines.append(f"**User{'' if len(r['turns']) == 1 else f' (turn {i + 1})'}:** {t}  ")
        lines += ["", f"**Tools:** {' → '.join(r['tools']) or 'none'}  ", f"**Time:** {r['seconds']}s  "]
        if r["fails"]:
            lines.append("**Check failures:** " + "; ".join(r["fails"]) + "  ")
        if g:
            lines.append("**Judge:** " + ", ".join(f"{k} {g.get(k)}" for k in
                                                   ("answers", "honesty", "provenance", "actionable", "format"))
                         + f" — {g.get('critique', '')}  ")
        lines += ["", "<details><summary>Answer</summary>", "", r["answer"] or "_(no answer)_", "", "</details>", ""]
    (out_dir / "report.md").write_text("\n".join(lines))


if __name__ == "__main__":
    main()
