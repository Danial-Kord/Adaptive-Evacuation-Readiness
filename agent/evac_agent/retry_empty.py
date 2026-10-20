"""Gemini occasionally ends a turn with an empty reply right after a tool result. For the manager that
is a blank screen, so the coordinator re-asks once when its final reply has no text."""
from __future__ import annotations

from google import genai
from google.adk.models.llm_response import LlmResponse

from .config import PROJECT

_last_request: dict[str, object] = {}


def remember_request(callback_context, llm_request):
    _last_request[callback_context.invocation_id] = llm_request
    return None


def retry_if_empty(callback_context, llm_response: LlmResponse):
    req = _last_request.pop(callback_context.invocation_id, None)
    parts = (llm_response.content.parts if llm_response.content else None) or []
    has_output = any(p.function_call or (p.text and not p.thought) for p in parts)
    if has_output or llm_response.partial or req is None or llm_response.error_code:
        return None
    client = genai.Client(vertexai=True, project=PROJECT, location="global")
    try:
        resp = client.models.generate_content(model=req.model, contents=req.contents, config=req.config)
        return LlmResponse.create(resp)
    except Exception:
        return None
