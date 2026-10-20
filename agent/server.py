"""FastAPI server wrapping the ADK Runner and extracting Google Maps grounding metadata."""

import os
from typing import List
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from evacuation_agent.agent import root_agent
from evacuation_agent.schemas import ChatRequest, ChatResponse, MapsGroundingChunk

load_dotenv()

app = FastAPI(
    title="Adaptive Evacuation Readiness ADK API",
    description="Backend API for Challenge 4: ADK Agent + BigQuery + Grounding with Google Maps",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

APP_NAME = "evacuation_readiness_app"
session_service = InMemorySessionService()
runner = Runner(agent=root_agent, app_name=APP_NAME, session_service=session_service)


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "agent": root_agent.name,
        "model": root_agent.model,
        "project": os.environ.get("GOOGLE_CLOUD_PROJECT", "(unset)"),
        "state": os.environ.get("STATE", "FL"),
    }


@app.post("/api/chat", response_model=ChatResponse)
async def chat_endpoint(req: ChatRequest) -> ChatResponse:
    """Run a turn against the ADK agent and return both text and Google Maps grounding chunks."""
    user_id = "emergency-manager"
    session_id = req.session_id or "default-session"

    session = await session_service.get_session(
        app_name=APP_NAME, user_id=user_id, session_id=session_id
    )
    if session is None:
        session = await session_service.create_session(
            app_name=APP_NAME, user_id=user_id, session_id=session_id
        )

    contextual_prompt = f"[Context: State={req.state}, County={req.county}] {req.message}"
    new_message = types.Content(
        role="user", parts=[types.Part.from_text(text=contextual_prompt)]
    )

    reply_parts: List[str] = []
    grounding_chunks: List[MapsGroundingChunk] = []
    seen_uris = set()

    try:
        async for event in runner.run_async(
            user_id=user_id, session_id=session.id, new_message=new_message
        ):
            if event.content and event.content.parts:
                for part in event.content.parts:
                    if part.text and event.is_final_response():
                        reply_parts.append(part.text)

            # Extract Google Maps grounding chunks for required UI attribution
            gm = getattr(event, "grounding_metadata", None)
            if gm and getattr(gm, "grounding_chunks", None):
                for ch in gm.grounding_chunks:
                    maps_obj = getattr(ch, "maps", None)
                    if maps_obj and getattr(maps_obj, "uri", None):
                        if maps_obj.uri not in seen_uris:
                            seen_uris.add(maps_obj.uri)
                            grounding_chunks.append(
                                MapsGroundingChunk(
                                    place_id=getattr(maps_obj, "place_id", None),
                                    title=getattr(maps_obj, "title", "Google Maps Place"),
                                    uri=maps_obj.uri,
                                )
                            )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return ChatResponse(
        reply="\n".join(reply_parts).strip() or "No response generated.",
        county=req.county or "Miami-Dade",
        state=req.state or "FL",
        grounding_chunks=grounding_chunks,
    )
