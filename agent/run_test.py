"""Run one question through the agent locally. Usage: python run_test.py "question" """
import asyncio, json, pathlib, sys, time
from dotenv import load_dotenv

_HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))
load_dotenv(_HERE / "evac_agent" / ".env")
load_dotenv(_HERE.parent / ".env")

from google.adk.runners import InMemoryRunner
from google.genai import types
from evac_agent.agent import root_agent
from evac_agent.schemas import RecommendedAction


def _extract_actions(obj, out: dict[str, RecommendedAction]):
    if isinstance(obj, dict):
        if isinstance(obj.get("recommended_actions"), list):
            for item in obj["recommended_actions"]:
                if isinstance(item, dict) and item.get("action_id"):
                    act = RecommendedAction(**item)
                    out[act.action_id] = act
        if isinstance(obj.get("recommended_action"), dict) and obj["recommended_action"].get("action_id"):
            act = RecommendedAction(**obj["recommended_action"])
            out[act.action_id] = act
        for v in obj.values():
            _extract_actions(v, out)
    elif isinstance(obj, list):
        for item in obj:
            _extract_actions(item, out)


async def main(q: str):
    r = InMemoryRunner(agent=root_agent, app_name="t")
    s = await r.session_service.create_session(app_name="t", user_id="u")
    t = time.time()
    actions: dict[str, RecommendedAction] = {}
    async for e in r.run_async(user_id="u", session_id=s.id, new_message=types.Content(role="user", parts=[types.Part(text=q)])):
        for p in (e.content.parts if e.content else []):
            if p.function_call:
                print(f"[{time.time()-t:5.1f}s] TOOL CALL: {p.function_call.name}({dict(p.function_call.args or {})})")
            elif p.function_response:
                print(f"[{time.time()-t:5.1f}s] tool returned: {p.function_response.name}")
                _extract_actions(p.function_response.response, actions)
            elif p.text and not getattr(p, "thought", False):
                print(p.text)
        if getattr(e, "actions", None) and getattr(e.actions, "state_delta", None):
            _extract_actions(dict(e.actions.state_delta), actions)
        gm = getattr(e, "grounding_metadata", None)
        if gm and gm.grounding_chunks:
            print("[maps grounding chunks:", len(gm.grounding_chunks), "]")

    if actions:
        print(f"\n=== EMITTED PYDANTIC RECOMMENDED ACTIONS ({len(actions)}) ===")
        for act in actions.values():
            loc = act.primary_location
            coords = f"({loc.lat}, {loc.lon})" if loc.lat is not None and loc.lon is not None else "(county-level)"
            print(
                f" • [{act.severity.value}] {act.action_type.value} | mode={act.interaction_mode.value} "
                f"| approval={act.requires_approval} | options={len(act.options)} | loc={loc.label} {coords}"
            )
            print(f"   Title: {act.title}")
            if act.approval:
                print(f"   Approval: [{act.approval.confirm_label}] -> {act.approval.proposed_change}")
            if act.options:
                print(f"   Options ({len(act.options)}): {', '.join(o.label for o in act.options[:3])}")
    print(f"\n[total {time.time()-t:.1f}s]")


if __name__ == "__main__":
    question = sys.argv[1] if len(sys.argv) > 1 else "Which tracts should Lee County prioritize first, and why?"
    asyncio.run(main(question))
