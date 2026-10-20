# Future work

## Voice / phone assessments with Gemini Live — closing the "unrecorded" gap at scale

**Problem it solves.** 88% of Florida shelters (93 of 100 in Lee County) have no recorded wheelchair
answer. Our agent already interviews shelter operators by text and writes structured answers to
`evacuation_readiness.shelter_assessments`. The next step is to have that same conversation by voice,
including outbound phone calls, so a county can assess every shelter before the season.

**How it would work.**
```
Telephony provider (e.g. Twilio) ──call──▶ shelter operator
      │  audio stream (WebSocket)
      ▼
Bridge service on Cloud Run (phone 8 kHz audio ↔ Gemini 16 kHz audio)
      │
Gemini Live (real-time voice) + ADK live streaming
      │  same operator-interview instructions, same tool: record_shelter_assessment
      ▼
BigQuery shelter_assessments  ──▶  verification agent uses it as a new, dated source
```
Stepping stone: the operator talks to the agent by voice in the browser (ADK web's microphone button
with a Gemini Live model). No phone network, same tools, same BigQuery writes.

**Constraints we would design for.**
- **Phone numbers:** FEMA's shelter file deliberately excludes contact columns (they name individuals).
  Google Maps can provide a building's public phone number at runtime but it may not be stored, so
  numbers would come from the county's own shelter agreements.
- **Consent and disclosure:** Florida requires all-party consent to record calls, and US rules treat
  AI-generated voices on calls as artificial. The agent opens by saying it is an AI calling on behalf
  of the county and asks for consent; only the structured answers are kept, never audio.
- **Data labelling:** answers are stored as `source = "operator phone interview"` with a timestamp and
  consent flag, and shown as operator-reported (dated), distinct from 🕰️ FEMA and 🟢 Google Maps.
- **Planning only:** calls happen before the season, never during an active emergency.

## Other next steps
- Load more states (`scripts/load.sh <STATE>`); swap FEMA NRI hazard columns for wildfire (California).
- Add the 65+-living-alone layer (ACS B11007) — the best proxy for "nobody will notice if they don't leave".
- Replace straight-line walk distance with walking routes from Google Maps.
- Connect the custom map front end so Google Maps attribution is rendered with `translate="no"`.
