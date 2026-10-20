"""Run one question through the agent locally. Usage: python run_test.py "question" """
import asyncio, sys, time
from dotenv import load_dotenv
load_dotenv("evac_agent/.env")
from google.adk.runners import InMemoryRunner
from google.genai import types
from evac_agent.agent import root_agent

async def main(q):
    r = InMemoryRunner(agent=root_agent, app_name="t")
    s = await r.session_service.create_session(app_name="t", user_id="u")
    t = time.time()
    async for e in r.run_async(user_id="u", session_id=s.id, new_message=types.Content(role="user", parts=[types.Part(text=q)])):
        for p in (e.content.parts if e.content else []):
            if p.function_call: print(f"[{time.time()-t:5.1f}s] TOOL CALL: {p.function_call.name}({dict(p.function_call.args or {})})")
            elif p.function_response: print(f"[{time.time()-t:5.1f}s] tool returned: {p.function_response.name}")
            elif p.text and not getattr(p, 'thought', False): print(p.text)
        gm = getattr(e, "grounding_metadata", None)
        if gm and gm.grounding_chunks: print("[maps grounding chunks:", len(gm.grounding_chunks), "]")
    print(f"\n[total {time.time()-t:.1f}s]")

asyncio.run(main(sys.argv[1]))
