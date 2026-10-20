# Challenge 4—Adaptive Evacuation Readiness & Vulnerable Community Planning

**Agents for Impact 2026**

---

## Why this one matters

When a hurricane is forecast, most people leave. They put the dog in the car, they drive to a
relative's house two hundred miles inland, and they come back in a week.

The people who die are the ones for whom none of that is available. No car. No relative inland. An
oxygen concentrator that needs mains power. A third-floor apartment and a hip replacement. A
daughter who calls every day but lives in Ohio.

After Hurricane Ian, the median age of the dead was in the seventies. That is not a coincidence and
it is not bad luck. It is what happens when a plan quietly assumes a level of mobility that a large
minority of the population does not have.

Here is the part that should bother you, and the part that makes this a data problem rather than a
tragedy: **those people are findable in advance.** Not by name, and not by knocking on doors in a
storm, but by census tract, by facility, by county, months ahead, from public federal data anybody
can download today.

**Your job today is to build the thing that finds them while there is still time to do something
about it**—and that is honest about the large parts of the picture nobody ever wrote down.

You will build it for **one state**, in **August**, for a storm that has not formed yet. Nobody is
being rescued in real time in this challenge. That is not a simplification; it is the only window in
which most of these decisions can actually be made.

And you are going to find something uncomfortable while you do it. We will not spoil it
here—[it is in the data section](#what-the-data-actually-says), and it is worth arriving at
honestly.

---

## How to read this

**This is a reference for your whole afternoon, not something to read end to end now.** Here is
what each of you needs in the first fifteen minutes.

| If you are… | Read now | Come back for |
|---|---|---|
| **Everyone, together** | [The four things](#the-four-things-youre-working-with) · [Three tracks](#three-tracks-one-architecture) · [What you're building](#what-youre-building) · [Pick your state](#now-pick-your-state) | Decide these before anyone opens a keyboard |
| **Team lead** | [Step 0](#step-0organize-your-team) · [How you'll be judged](#how-youll-be-judged) | [Going further](#going-further)—read it *before* you write code, not before you demo |
| **Data lane** | [Step 4, load the data](#step-4load-the-data) · [What you'll have](#what-youll-have) | [The data, and why we chose it](#the-data-and-why-we-chose-it) · Section 12 of the notebook |
| **Agent lane** | [What you're building](#what-youre-building) · [The technology](#the-technology-youll-use) | [`agent/README.md`](agent/) · [Reference](#reference) |
| **Front end lane** | [Front end lane](#front-end-lane2-people) | [Your output artifact](#your-output-artifact-the-readiness-brief) · the attribution rules, which shape your UI |
| **Story lane** | [What the data actually says](#what-the-data-actually-says) | [Your output artifact](#your-output-artifact-the-readiness-brief) · [The data](#the-data-and-why-we-chose-it)—what is measured and what is merely recorded, because judges check |

**Three things everybody should know by the end of hour one**, whatever lane you are in:

1. **Grounding with Google Maps cannot answer the question this challenge is about—at least not the
   way you will first ask it.** Ask which shelters in a county take a wheelchair and it cannot help.
   Section 2 of the notebook shows you that in a few minutes, and the whole design follows
   from it. There is a way to get considerably more out of it, and finding it is worth real credit.
2. **Your agent must genuinely call Maps grounding and act on what comes back.** Naming it on a
   slide, or calling it once for decoration in a flow that would give the same answer without it, is
   the most common way to miss the point while appearing to hit it.
3. **For most shelters the accessibility field is blank—and blank does not mean "no".** It means
   nobody wrote it down. An agent that conflates those two is confidently wrong about the thing that
   matters most, and a judge will find it.

---

## The four things you're working with

Small vocabulary, used consistently everywhere from here on. Worth thirty seconds now.

| Term | What it means |
|---|---|
| **Census tract** | A Census Bureau area of roughly 4,000 people. Small enough to act on, large enough that nobody in it is identifiable. Our unit for everything about **people** |
| **Grounding** | Connecting a model to a live external source so its answer is anchored in something real rather than recalled. Your differentiator is one of these |
| **Unrecorded** | A field nobody filled in. Distinct from a field that says "no", and **that distinction carries most of the meaning in this challenge** |
| **EVAC / POST** | A shelter designated for use *before* landfall versus one for *after* impact. Different buildings, different job, and the federal file tells you which—it is the `usage` column in `shelters` |

The whole challenge is: **a county, a season, and a plan that does not assume everyone can drive.**

---

## Three tracks, one architecture

Every team shares the same spine: one state, five tables, one agent that calls Grounding with Google
Maps and knows when not to, one readiness brief. **What changes between tracks is which question the
emergency manager hands you first, not the machinery.**

**These are suggestions, not a menu you are confined to.** Pick one, combine two, or invent your
own—if you can see an evacuation-readiness problem in the same vein that these three miss, that is
exactly the kind of judgment this challenge rewards. Just be ready to say why yours is worth solving.

| Track | The situation | Who your user is | What makes it hard |
|---|---|---|---|
| 🏚️ **Shelter readiness** | The state's shelter list is on file. Which of them can take the people who will actually arrive, and which are themselves in the surge zone? | The county emergency manager, writing the August brief | For most shelters the accessibility field is blank, and the federal record may describe a building demolished in 2023 |
| 🚌 **Getting people out** | The plan on file assumes everyone can drive. Where are the households that cannot, and how far are they from a shelter that could take them? | The same manager, or the transit coordinator she calls | You have straight-line distance, not drive time, and owning no car is not the same as having no ride |
| 🏥 **The medically dependent** | Nursing homes, dialysis, oxygen concentrators. Where are the concentrations, where is the power dependence, and which shelters are designated for medical needs? | A hospital or health-department emergency planner | Power dependence is published per county, not per tract, and medical-needs shelters are rare—South Carolina has two |

### What a strong version of each looks like

**🏚️ Shelter readiness** starts from `shelters`—`evacuation_capacity`, `wheelchair_accessible`,
`generator_onsite`, `in_surge_slosh_area`—with `hazard_tracts` for the exposure of the ground each
one stands on. The strong version treats *unrecorded* as its own category and never as "no," then
spends Grounding with Google Maps on the one question the federal file cannot answer: is this
building still there, and what is it now? Output: a ranked list of shelters to verify before the
season, with a reason per row.

One thing we did not pre-build: `shelters` carry a county but no tract id. To put a shelter on a
hazard tract, either take the nearest `vulnerability_tracts` centroid by `ST_DISTANCE` (simple,
approximate) or spatially join against the 2010-vintage geometry table and accept that a third of
2020 tract ids will not match. Say which you did.

**🚌 Getting people out** starts from `vulnerability_tracts`—`households_no_vehicle`,
`pct_no_vehicle`, `pct_age_65_plus`, `pct_disability`, `mobile_homes`—and a spatial query against
`shelters`, which for most teams is the first time they write `ST_DISTANCE`. Maps grounding earns its
place here twice: finding what is *near* a tract, and—with `routing` added to `grounding_types`
alongside `places`—returning the drive time to it, which is exactly the add-on that turns our
straight-line distance into something a planner can use (see
[the questions that need more](#questions-that-need-more-than-we-gave-you)). The strong version says
plainly which transport measure it is quoting, because the two in the table measure different
things. Output: the tracts where a pickup point or a para-transit run would do the most good, and why.

**🏥 The medically dependent** starts from `care_facilities` and `power_dependent_counties`, and from
`shelters.is_medical`. The strong version is honest about scale—county-level power dependence cannot
be assigned to a block—and uses Maps grounding to confirm the facilities still operate. Output: the
facilities and counties where a generator, a transfer agreement or a medical-needs designation should
exist before September and does not.

**Can you do more than one?** A real readiness brief would, and the three share every table. But
three shallow tracks lose to one that is genuinely good, and you have four and a half hours.

---

## What you're building

**Not a lookup with a chat box. A capability.**

An agent a county emergency manager can hand a question to in August and get an answer from that is
specific enough to act on in September—assembled from data she does not have time to pull together
herself, and honest about which of its answers are solid and which are guesses.

Picture a single afternoon:

> **Mid-August, Tuesday.** The seasonal forecast was revised upward last week. The county emergency
> manager has been asked for a readiness brief by the end of the month. She has a shelter list from
> the state, a spreadsheet of nursing homes, and a strong suspicion that the plan on file assumes
> everybody can drive. She is not in an emergency. She has three weeks—which is exactly the point,
> because **everything that can be decided in advance should be**, and the alternative is deciding
> it at 3am with the power out.

Here is what she asks between now and the end of the month, and what answers each:

| What she asks | What answers it |
|---|---|
| *"Which neighborhoods in my county would struggle most to self-evacuate?"* | `vulnerability_tracts`—no-vehicle households, over-65 share, disability prevalence, mobile homes |
| *"How many people here depend on electricity for medical equipment?"* | `power_dependent_counties`—and note it is county-level, so you can say how many but not which block |
| *"Where would I send them, and how far is it?"* | `shelters` plus `vulnerability_tracts`—a spatial query, not a lookup |
| *"Which of those shelters can actually take a wheelchair?"* | `shelters.wheelchair_accessible`—**and the honest answer is mostly "nobody recorded it"** |
| *"Is that shelter still there? Is it open? What is it now?"* | **Grounding with Google Maps.** Nothing in our data can tell you this |
| *"Which of my shelters is itself in the surge zone?"* | `shelters.in_surge_slosh_area` and `hazard_tracts` |
| *"What should I fix before the season?"* | Your agent's judgment. This is the deliverable |

Notice these need **different things**. Some of those questions require the differentiator and some
of them cannot use it at all, and working out which is which *is* the design problem—an agent that
calls Maps grounding for everything gives confident nonsense about accessibility, and one that never
calls it is quoting a federal record that may describe a building demolished in 2023.

**That range is the challenge.** An agent that only answers the first question is a dashboard with a
chat box. An agent that handles all seven is something a county emergency manager would keep open
all season.

### Questions that need more than we gave you

Be aware of the edges—and treat them as opportunity, because closing one is exactly what separates a
team. Say these out loud in your demo too: naming a limitation you cannot fix reads as competence,
and having a judge find it reads as the opposite.

| The question | What you'd need to add |
|---|---|
| *"How long does it take to drive there?"* | Our tables carry straight-line distance only. Grounding with Google Maps closes it: add `routing` to `grounding_types` alongside `places` and the grounded call returns drive times and directions ([Routing—Find Directions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/grounding/grounding-with-google-maps#routing-find-directions)). Maps Grounding Lite's `compute_routes` is the alternative. See [Going further](#going-further) |
| *"Which assisted living facilities are in my county?"* | **No national public list exists.** Assisted living is state-regulated, so there is no federal roster—a real gap affecting exactly this population. Your state's licensing database, if it publishes one |
| *"Where are the mobile home parks?"* | The national layer was decommissioned in 2025. We load ACS mobile-home counts per tract—density, not locations |
| *"Which specific people need help?"* | Nothing. Individual-level data is prohibited at this event, and rightly. This is a line, not an obstacle |
| *"Is this shelter open right now, during the storm?"* | FEMA's own file says in capitals that it must not be used for operational status. Live county feeds—which are empty in October, when you are planning |
| *"How many people in this tract use a wheelchair?"* | Nothing better exists publicly. CDC PLACES gives modeled prevalence, not counts—use it and say it is modeled |
| *"Can a person in a wheelchair actually get into this building?"* | For two thirds of shelters, **somebody has to go and ask.** See [the add-on we'd build](#the-add-on-wed-build-if-we-had-another-four-hours) |

---

## Now pick your state

Evacuation is run by states and counties, not by metro areas, so this challenge is scoped to a
state. Change one line at the top of the notebook and everything follows.

**You do not have to pick the state you are sitting in.** Pick the one that makes your story.

**And the state is not the only thing that is yours to choose.** [Your track](#three-tracks-one-architecture)
is the other, and each of the three names a user—but those are suggestions, not a cage. A
different user with the same data is a legitimate move: a utility deciding which substations to
harden, a nonprofit deciding where to pre-position supplies. **If you can see a readiness problem
in the same vein that ours miss, take it.** Just be ready to say why yours is worth solving.

These come from the run that produced the snapshots in Cloud Storage, so you are choosing with your
eyes open. **Read the "unrecorded" column, not the "yes" column.** "Wheelchair YES" is the count
recorded as yes; the "no" answers are a few dozen per state; and the unrecorded share is the number
that should actually decide what you build.

| State | Shelters | Total capacity | Wheelchair **YES** | Unrecorded | Medical-needs | Notes |
|---|---:|---:|---:|---:|---:|---|
| **FL** | 2,793 | 848,784 | 247 | **88%** | **155** | The default. Right hazard, second-most medical-needs shelters of the eight, and the worst accessibility reporting of any of them. **No `pct_lacktrpt`**—see below |
| TX | 3,633 | 772,337 | 699 | 78% | 33 | Biggest coastal exposure after Florida. **No `pct_lacktrpt`**—see below |
| GA | 1,792 | 1,138,056 | 385 | 75% | 14 | Inland receiving state as well as coastal. **Read defect 6 before you quote that capacity**—two rows carry 43% of it |
| NC | 1,565 | 445,627 | 356 | 75% | 18 | Inland flooding as much as surge |
| LA | 1,326 | 355,010 | 140 | **85%** | 14 | The evacuation-planning literature is mostly about here, and the reporting is the second-worst of the eight |
| SC | 843 | 328,746 | 189 | 76% | **2** | **Cautionary.** Two medical-needs shelters in the whole state |
| NY | 4,542 | 1,639,805 | 1,122 | 74% | 14 | Surge risk with almost no medical designation—0.3% |
| CA | 6,873 | 6,554,178 | 1,161 | 81% | **209** | Wildfire rather than hurricane. Works, different story, and the most medical-needs shelters here |

Any state works, including ones not listed—you just have not seen their numbers, and neither have
we. Run the notebook and read its section 10 before you build a narrative on one.

**South Carolina is the worked example of getting this wrong.** 843 shelters, 328,746 spaces, and
exactly two with a medical designation. If your entire demo is medical-needs matching, SC will not
carry it, and you will find that out at minute 200.

**One column is not published everywhere, and it happens to hit the default state.** CDC PLACES does
not report `LACKTRPT`—lack of reliable transportation—for **Florida or Texas**. Every state's table
carries the `pct_lacktrpt` column, but for those two it is empty, and the validation section says so
in a WARN. Neither state is blind to transport either way: `pct_no_vehicle` from CDC SVI and
`households_no_vehicle` from ACS both survive. They measure vehicle *ownership*, which is not the
same as being able to get a ride, so know which one you are quoting.

> **Why hurricanes, and what else would this work for?**
>
> Three of your five tables do not know what a hurricane is. `vulnerability_tracts` describes who
> cannot get themselves out of a building; `shelters` and `care_facilities` describe where they
> could go. Those are the same questions in a wildfire evacuation, an ice storm, a chemical release
> or a multi-day grid failure. **`power_dependent_counties` is arguably not a hurricane layer at
> all**—HHS built emPOWER for power outages, whatever causes them.
>
> Only `hazard_tracts` is hurricane-specific, and only because we asked for it that way: we pull
> FEMA's National Risk Index hurricane (`HRCN_*`) and coastal-flooding (`CFLD_*`) columns and leave
> its other hazards behind. The notebook prints the full field list the service offers before it
> chooses, so **swapping the prefix is a one-line change**—and if you pick California, doing exactly
> that is the most defensible half hour you could spend.
>
> We lead with hurricanes because it is the scenario with the clearest deadline, the best-documented
> failure mode, and a real seasonal calendar to plan against. It is a lead, not a limit.

Then make the scenario your own:

> **Our agent helps a ______ in ______ decide ______ before ______.**

Write it down before you write code. Every design argument you have this afternoon resolves faster
against a specific situation than a general one, and it is the sentence your demo opens with.

---

## The technology you'll use

Every team, every challenge, uses the same core stack:

| | |
|---|---|
| **ADK** (Agent Development Kit) | You build your agent in Python with ADK. This is the frame everything hangs on |
| **Gemini** | The reasoning model—use the **3.x line**, and see below, because on this challenge the model generation changes your architecture |
| **BigQuery** | All the data lives here, and your agent queries it |
| **A managed MCP server** | Consume at least one—don't author your own. See below |
| **At least one tool you built** | A Python function tool, or one you defined in MCP Toolbox |
| **Deployed to Google Cloud** | Agent Runtime or Cloud Run, your choice. It has to actually run somewhere |

**Also already set up for you, and worth ten seconds now rather than later: Antigravity.** Your
Google Skills lab environment has a button that launches the **Antigravity IDE**, and the
**Antigravity CLI** is one word away in Cloud Shell—type `agy`. Not required, and nothing here
depends on either, but we strongly recommend you use one: every lane has tedious work a coding
agent will happily absorb. [Details in Step 3](#strongly-recommended-antigravity-the-ide-and-the-cli).

### Choosing your MCP server

- **BigQuery's built-in MCP server**—quickest path if all you need is to query your tables.
- **[MCP Toolbox for Databases](https://github.com/googleapis/mcp-toolbox)**—Google's open source
  MCP server for databases. Prebuilt tools plus a framework for defining your own.
- **Maps Grounding Lite**—a Google-hosted MCP server at `https://mapstools.googleapis.com/mcp`
  carrying `search_places`, `lookup_weather` and `compute_routes`. It is one of two routes to a real
  travel time in this challenge (the other is `routing` in Grounding with Google Maps itself), and
  it satisfies this requirement on its own.

**The Toolbox is generally more flexible.** If you want your agent's database access shaped to your
own tools rather than generic queries, start there.

> **Hint worth taking:** run the Toolbox as a container on **Cloud Run with minimum instances set
> to 1**. Cloud Run scales to zero by default, so the first request after an idle period pays a
> cold start—and the first request after an idle period is the one you make on stage.

### And one required differentiator: **Grounding with Google Maps**

Each of the five challenges has one required technology. Yours is Grounding with Google Maps, and
here is why it belongs in this problem rather than being bolted on.

FEMA's shelter file is a **historical registry**. Every facility ever registered as a shelter, one
row each, some entered during a hurricane years ago. FEMA's own layer description says in capital
letters that it must not be used to determine whether a facility is operational. So you have a
list of buildings and no way to know, from the list, whether any of them is still a building.

We measured how bad that actually is rather than assuming: **we took fifteen Florida shelters and
asked Google Maps about each. Fourteen still exist. One had been renamed**—First Presbyterian Church
of Maitland is now Maitland Presbyterian Church, same building, different name, and a lookup
matching on name alone would have missed it.

So the honest case for the differentiator is not "the file is full of demolished buildings". It is
that **a static file cannot tell you which ones moved, renamed or closed, and it cannot tell you
what a place is *now*.** Note what that sample is made of, too: mostly public schools, which
persist. A registry of churches and storefront community centers would age faster.

**Our data is the memory. Maps is the eyes. Neither does the other's job.**

Setup is one API—`aiplatform.googleapis.com` plus billing. No Maps Platform key, no separate Maps
Grounding API, no allowlist form:

```python
from google.adk.tools import google_maps_grounding
```

```
GOOGLE_CLOUD_PROJECT      = <your project>
GOOGLE_CLOUD_LOCATION     = global
GOOGLE_GENAI_USE_VERTEXAI = True
```

**Your agent must genuinely ground.** It has to call Maps and *act* on what comes back—change a
ranking, drop a candidate, flag a discrepancy. Naming it in a slide does not count, and neither does
calling it once for decoration in a flow that would produce the same answer without it.

**But the grounding is not the answer, and this is what most teams will miss.** Confirming that a
building exists is the easy half. The hard half is what your agent does when the federal record and
the live world disagree, and what it says about the two thirds of buildings where the record is
simply blank. Maps makes a discrepancy **visible**. Deciding what that discrepancy means for a
person with no car is where your agent earns its score.

#### Your model choice decides your architecture—read this before you write code

**On Gemini 2.5 and older**, a built-in tool cannot sit in the same agent as a function tool of your
own. The request is rejected outright:

```
400 INVALID_ARGUMENT—"Unable to submit request because Multiple tools are supported
only when they are all search tools."
```

**On Gemini 3.x it works.** We put `google_maps_grounding` and a BigQuery function tool in one ADK
agent, ran it, and both fired in a single turn—it queried the shelters table *and* grounded against
Maps. Verified 2026-08-09 on `gemini-3.6-flash`. **The same code, the same ADK version, the same
agent, pointed at `gemini-2.5-flash`, still returns the 400.** This is a model-side constraint on
what a request may contain, not an ADK behavior—so upgrading your ADK version will not fix it and
downgrading will not reintroduce it.

**Use a 3.x model and keep one agent.** If you pin an older one you need two, and it is a perfectly
good architecture either way:

- a **maps agent** holding `google_maps_grounding` and nothing else
- your **root agent** holding your own function tools, an MCP server, and the maps agent wrapped in
  `AgentTool`

`GoogleMapsGroundingTool` takes no constructor arguments and does not accept
`bypass_multi_tools_limit`, so on an older model the sub-agent is the only route. `google_maps` and
`google_search` coexist on any model.

**A warning you will see and should ignore:** `Tools at indices [0] are not compatible with
automatic function calling (AFC). AFC is disabled.` That is the client declining to run the
function-calling loop for you. ADK runs its own. It is noise.

#### What it will and will not do

| Will | Will not |
|---|---|
| Find places, addresses, ratings, hours | Give you a drive time unless `routing` is in `grounding_types` |
| Tell you whether somewhere is open **right now** | Know anything in our tables—who lives nearby, wheelchair flags, generators |
| Tell you a place has closed, or been renamed | Answer anything but English |
| Say honestly when it does not know | Answer an *area* question about accessibility |

**On accessibility, the shape of the question decides the answer.** *"Which shelters in this county
take a wheelchair"* gets you nothing. **One named building at one address** got a definite answer 5
times out of 8 in our testing, agreeing with FEMA's record 4 times out of 5 where both had a view.
Iterating over your candidate shelters one at a time is slow, it is real, and almost nobody will
try it.

Five to eight seconds per grounded call is normal, not a bug. Routing and Search Along Route are
part of Grounding with Google Maps too—add `routing` to `grounding_types` and the same call returns
drive times and directions ([Routing—Find Directions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/grounding/grounding-with-google-maps#routing-find-directions)).
It is newer than the rest of the feature, so if you build on it, test it at minute ten rather than
minute two hundred.

#### Attribution is a requirement, not a nicety

Display the Google Maps sources **immediately after** the content they support, viewable within one
user interaction. The words "Google Maps" must not be re-capitalized, restyled, wrapped across lines
or translated—set `translate="no"`.

The response gives you `groundingChunks[].maps` with `place_id`, `title` and `uri`, and
`groundingSupports` mapping each sentence to its sources. Two practical notes: `segment.start_index`
is `None` on the first segment, so treat it as 0, and `confidence_scores` is never populated.

**What you may keep:** `place_id` and `review_id`. Not the rest. Which points at the right design
anyway—store the pointer against your shelter row, re-ground at runtime, and you have a system that
is both compliant and current.

---

## Getting started

You have **4.5 hours** and there are **8–10 of you**. That is too many people for one keyboard,
and the biggest risk to your team is the first hour disappearing into setup. Spend twenty minutes
on Step 0. It pays for itself twice over.

### Step 0—Organize your team

**Pick a team lead.** One person who makes the call when you are behind—and you *will* be behind.

**Pick a repo owner.** Can be the same person. They create the team's repository and add everyone.
Everything lands in one repo, not eight forks.

**Everyone else: create a free [GitHub](https://github.com) account now** if you don't have one,
and **send your username to the repo owner** while they're setting up.

**Agree your state, your track, and your scenario** (see above). Five minutes. Write it where everyone can see
it.

**Then spend ten more on [Going further](#going-further).** It sits near the bottom because it only
makes sense once you know what you are building—but it is the section that decides whether your demo
looks like everyone else's, so read it before you write code rather than after.

**Split into four lanes.** All four start immediately, in parallel.

#### Data lane—2 to 3 people

Running the notebook takes a few minutes (the diagnostic cell at the bottom prints the exact figure)
and rather longer to read, so that is emphatically *not* the job. This lane owns everything between
raw tables and a readiness query the agent can call:

- **Get the shelters-to-tracts distance query working, and hand it to the agent lane early.** They
  need the exact SQL their tool will wrap, and they are blocked until it exists. This is the
  equivalent of training a model in other challenges: an *input* to the agent, not a step 4.
- **Decide what "reachable" means** and encode it. Ten kilometers is nothing with a car and
  impassable without one. This is a modeling decision, it is yours, and judges look for it.
- **Keep unrecorded separate from "no" all the way through.** If it collapses anywhere in your
  pipeline it will collapse in your agent's answers too.
- **Read the WARN rows** the validation section prints. They are real defects in federal data and at
  least one of them is worth a slide.
- **The equity audit** ([explained below](#what-auditing-the-outcome-actually-means)).
- **Decide whether to bring extra data**, and if so, source it and check the license.

#### Agent lane—2 to 3 people

- **Prompt engineering.** Expect this to be the hardest part. Your system instruction has to teach
  the agent who it is talking to, when to reach for which tool, and—importantly—**when to refuse.**
  An agent that confidently reports "no accessible shelters nearby" is worse than one that says
  *"eleven of these I can speak to; sixty-four nobody has assessed."*
- **At least one tool you built.** Required. The obvious one wraps a shelter query. The more
  valuable one holds the logic that is not a single query—turning a list of tracts into a ranked
  brief with a recommendation attached.
- **Decide what goes through MCP and what needs a custom tool.** Generic "query my tables" fits the
  managed server. The readiness logic, with its judgment calls, usually wants a purpose-built tool.
  **This is your main coordination point with the data lane.**
- **Deploy early, not at the end.** The front end is blocked on a live endpoint, and deployment
  always takes longer than you think.
- **Test with the real questions.** Take the seven questions above and ask them.
- **Decide what failure looks like.** What does your agent say when Maps and FEMA disagree about a
  building? When the field is blank? Those two answers are most of your score.

#### Front end lane—2 people

Three routes. **Pick deliberately and be ready to say why**—the choice tells judges who you think
the user is.

| Option | Strength | Trade-off |
|---|---|---|
| **`adk web`** | Fastest. Built in. Works immediately, and where you should start | Obviously a developer tool. Fine while building, weak as a product story |
| **Gemini Enterprise** | Polished, almost no front-end code. An agent on Agent Runtime can be surfaced through it | Serves **internal** users, not the public |
| **Custom web UI** | Full control. A map of a county with the gaps marked beats a chat log | The most work by far. Scope it small |

**Everybody starts on `adk web`, and you should too.** The question is whether you *finish* there.
Shipping it as your demo is a choice you will have to defend, and "it was already there" is the
weakest version of that answer.

The Gemini Enterprise trade-off is worth thinking about rather than working around. Your user *is*
internal—an emergency manager at a county, not a member of the public. **Say that on purpose.**

- **Attribution is a front-end requirement, and it is on you.** Google Maps sources must appear
  immediately after the content they support, within one user interaction, with the words "Google
  Maps" unmodified and `translate="no"`. Design for it early; retrofitting it is miserable.
- **Do not wait for a working agent.** Mock the response, build against it, swap later.
- **Whatever you build, the demo runs on it.** Test it on the machine you will present from.

#### Story lane—1 to 2 people, starting at minute zero

Not "make slides at the end." This lane owns whether anyone understands what you built.

**What you hand in.** Four things, uploaded to the submission portal at
https://portal.angelhack.com/a4i-console before the deadline your facilitator gives you:

1. your GitHub repo link
2. your Google Skills project link (the Qwiklabs environment you built in)
3. your pitch deck
4. a **pitch video**: a screen-share walkthrough, one of you talking the judges through what you
   built while running it

**Judges score those four things after the event. Nobody comes to your table and there is no
Q&A.** Every question in [How you'll be judged](#how-youll-be-judged) has to be answered in the
deck or the video, or it counts as unanswered.

**What you're preparing: a short pitch deck, a quick demo, and the recording of it.** Presentation time at this event is
tight—your facilitator will give you the number, but plan for short. **A crisp pitch with one
moment that lands beats a thorough walkthrough nobody has time to hear.**

- **The pitch deck.** Short. The problem, your scenario, what your agent does, what you found, what
  you'd do next. Front-load it—assume you get cut off before your last slide.
- **The demo.** Pick one or two questions that best show what your agent can do, and **rehearse
  it.** Have a screenshot ready in case the live version misbehaves.
  Once it works, **record it as your pitch video**: a screen-share with one of you narrating. That
  recording, not the live demo, is what the judges watch.
- **The Readiness Brief**—your output artifact (see below). Something an emergency manager would
  actually receive.
- **The honest limitations.** Judges explicitly reward this. One line in the deck is enough.
- **Know which of your numbers measure the world and which measure the paperwork.** You will be
  asked. The answer is in the notebook and it is a good one—make sure whoever presents can give it.

Time the whole thing out loud at least once. Teams almost always run long.

### Your output artifact: the Readiness Brief

Three segments. Show them in a demo, not a document.

- **Who cannot leave.** The tracts and facilities in the county holding people who cannot
  self-evacuate, ranked, with the reason for each. Not a heat map—a short list she could act on,
  with numbers attached.
- **Where they would go, and whether that holds up.** For each candidate destination: capacity, what
  the record says about accessibility and generators, whether it sits in a surge zone—and **verified
  live** against Google Maps that it exists, is what it claims to be, and is open.
- **What to fix before the season.** The gaps. Zones with no accessible destination within a
  reasonable distance. Facilities with no generator near a power-dependent population. Shelters that
  are themselves in the flood zone. **This is the segment that makes the agent worth building**, and
  it is the one nobody will have time to do well, which is exactly why it separates teams.
- **What we could not tell you.** Named, counted, and not hidden. In this challenge that is not a
  disclaimer—it is a finding.

### Step 1—Create the team repository

**Repo owner only.**

1. At the top of this page, click the green **Use this template** button → **Create a new
   repository**. *(No button? Use **Fork** and tell a coach.)*
2. Name it after your team, choose **Public**, click **Create repository**.
3. **Settings → Collaborators** → add every teammate's GitHub username.
4. Paste the repo URL where everyone can see it.

### Step 2—Get into your Google Cloud project

**Your facilitator will tell you how to access your project. Follow those instructions**—they vary
by venue and they're the fastest path.

**There is one project per team.** You all share it, which is the point—you can all see the same
BigQuery tables. It also means you can overwrite each other. Agree on who creates what.

You have Owner. You don't need to create a project, set up billing, or download a key file.

### Step 3—Everyone: get into Cloud Shell

**Cloud Shell is where you'll work.** It has `gcloud`, `bq`, Python, Node, git, Docker, and the
Antigravity CLI already installed. Nothing to set up on your laptop, no admin rights needed.
(The Antigravity IDE launches from a button in your Skills lab environment; see below.)

1. In the Cloud console, click the **`>_`** terminal icon, top right.
2. `git clone <your team repo URL>`, then `cd` into the folder it makes (your repo's name).
3. `cloudshell workspace .` opens the editor on it.

New to any of this?
[Using Cloud Shell](https://docs.cloud.google.com/shell/docs/using-cloud-shell)
·
[Cloud Shell Editor overview](https://docs.cloud.google.com/shell/docs/editor-overview)

**While you are here, enable the two APIs in one command.** The console will otherwise prompt you
for them **twice**—once when Colab Enterprise first opens and again from a separate button on its
home page—and that second prompt is the single most common way to lose ten minutes this morning:

```bash
gcloud services enable aiplatform.googleapis.com bigquery.googleapis.com
```

`aiplatform.googleapis.com` is not only for your agent. **Section 2 of the notebook spends a live
Maps grounding call**, so the data lane needs it too, at minute ten rather than minute two hundred.

One thing worth knowing: your `$HOME` directory persists between sessions. Anything outside it
does not—so keep your work in the cloned repo.

**One repo, one branch per lane.** You are four lanes working in parallel in a single repository,
and if everyone commits to `main` you will spend part of your afternoon resolving conflicts instead
of building:

```bash
git checkout -b agent      # or data, frontend, story
```

#### Strongly recommended: Antigravity, the IDE and the CLI

Antigravity is Google's agentic coding environment, and **it is already set up for you in two
forms**. Neither is a requirement, and nothing in this challenge depends on either—so don't lose
time fighting one if it isn't helping. But we strongly recommend you use at least one, because every
lane has tedious work it will happily absorb, and the fastest teams at events like this are the ones
that let a coding agent do the typing while they do the thinking.

**The Antigravity IDE.** Your Google Skills lab environment includes a button that launches it. A
full editor with an agent in it: it reads your repo, proposes edits you review before accepting,
runs code in the terminal, and can drive a browser. If you'd normally open an editor, open this one.

**The Antigravity CLI (`agy`).** Already installed in Cloud Shell. You run zero setup commands—just
type it:

```bash
agy
```

`/diff` shows pending changes before you accept them, `/permissions` controls what it can do on its
own. Review before you accept.

[Antigravity: getting started](https://antigravity.google/docs/getting-started)
·
[IDE overview](https://antigravity.google/docs/ide/overview/)
·
[CLI install and auth](https://antigravity.google/docs/cli/install)
·
[CLI hands-on codelab](https://codelabs.developers.google.com/antigravity-cli-hands-on)

### Step 4—Load the data

**Data lane's job.** One person runs it; nobody else waits.

1. In the Google Cloud console, search for **Colab Enterprise** and open it.
2. **You'll be asked to enable some APIs. Say yes.** Then the Colab Enterprise home page shows
   *another* **Enable APIs** button at the top. Click that too. Two prompts is expected—it isn't an
   error and you haven't done anything wrong. (If you ran the `gcloud` command in Step 3, both are
   already done.)
3. **My Notebooks** → **Import** → source **URL**, and paste this:

   ```
   https://raw.githubusercontent.com/haggman/A4I2026-challenge-4-evacuation/main/notebooks/c4_01_load_explore.ipynb
   ```

4. Click **Import**, open the notebook, set `STATE` at the top, and run the cells top to bottom. It
   takes a few minutes to run (the diagnostic cell at the bottom prints the exact figure) and rather
   longer to read.

**Read the text between the cells.** Several explanations will save you time later, and one of
them—section 2, where the differentiator fails on purpose—is something judges look for in your deck
and video.

**If the notebook won't run**, or a federal data server starts refusing the room (150 people hitting
one endpoint in ten minutes looks like an attack to some of them), there's a headless fallback. The
snapshot already has everything the notebook pulls. From the repo root in Cloud Shell:

```bash
bash scripts/load.sh FL
```

```bash
bash scripts/load.sh --list       # every state we've published
```

One asymmetry worth knowing. The notebook pulls live from seven public sources and teaches as it
goes; `load.sh` restores the identical tables from a Cloud Storage snapshot and teaches nothing.
Use the notebook if you can.

Invoke it with `bash` rather than `./scripts/load.sh`—that way it doesn't matter whether the file
arrived with its executable bit set.

It's safe to run more than once. Every table is fully replaced rather than appended to.

### What you'll have

Five tables in your project, in a dataset called `evacuation_readiness`. **Three describe people,
two describe places**, and that division is the shape of the whole problem:

| Table | Role | What it is |
|---|---|---|
| `vulnerability_tracts` | People | One row per census tract—no-vehicle households, over-65 population, disability and mobility prevalence, mobile homes, group quarters |
| `power_dependent_counties` | People | One row per county—residents relying on electricity for medical equipment, dialysis, oxygen |
| `care_facilities` | People | Nursing homes with coordinates and certified bed counts—concentrations of people who cannot self-evacuate |
| `shelters` | Places | Every registered shelter in your state that carries coordinates, with capacity, accessibility, generator and surge flags, and the county we derived from its coordinates |
| `hazard_tracts` | Places | Hurricane and coastal-flood exposure and expected annual loss, per tract |

---

## The data, and why we chose it

Five tables, in `<your-project>.evacuation_readiness`.

| Table | Rows (FL) | Source | License |
|---|---:|---|---|
| `shelters` | 2,793 | FEMA ESF#6 National Shelter System | US Government work. FEMA and American Red Cross co-attributed |
| `vulnerability_tracts` | 5,160 | Census ACS + CDC SVI 2022 + CDC PLACES 2025 | ACS public domain · SVI *"no constraints or limitations"* · PLACES *"Public Domain"* |
| `hazard_tracts` | 5,114 | FEMA National Risk Index | FEMA terms of use, attribution required, *"planning purposes only"* |
| `care_facilities` | 694 | CMS Nursing Home Provider Information | US Government work |
| `power_dependent_counties` | 67 | HHS emPOWER | US Government work, with a purpose-of-use condition |

**On emPOWER specifically**, because it is the sharpest signal here and it comes with a string
attached: *"Use of this tool and data signifies your agreement to use it for the specified purposes
and to make no attempt to identify any individual in this data."* The specified purpose is emergency
preparedness. That is what you are doing. Do not use it for anything else.

### What the data actually says

Run the notebook and you get these for your own state. Here is Florida, so the story lane can start
writing before the data lane finishes.

**2,793 shelters. 848,784 spaces. And this:**

| Wheelchair access | Shelters |
|---|---:|
| Recorded as **yes** | 247 |
| Recorded as **no** | 83 |
| **Nobody recorded either way** | **2,463—88%** |

Nationally it is roughly two thirds. **For most of America's shelters, nobody has written down
whether a person in a wheelchair can get in.**

And Grounding with Google Maps will not fill that gap from an *area* question. Five places, five
different types, zero definite answers—you will watch it happen in section 2 of the notebook. Ask
about one named building at one address and it answers roughly five times in eight, which is a
different and much more useful fact.

**The second number is scarcity.** Nationally only **2%** of shelters carry any medical-needs
designation. Their median capacity is 200—identical to the median for all shelters, so they are not
larger, merely designated. Florida has 155. South Carolina has two.

**The third is distance.** Median distance from a Florida census tract to any shelter: **under
2 km**. To one recorded as wheelchair accessible: **just over 7 km**. Nearly four times further. And
**493,461 Floridians** live more than ten kilometers from any shelter at all—which for a household
with no vehicle is not a distance, it is a wall.

#### The warning that comes with those numbers

California reports 209 medical-needs shelters. Texas reports 33. New York reports 14.

New York is not one-fifteenth as ready as California. **California fills in the form.**

This file measures what states recorded, not what exists. **Any team that ranks states, counties or
neighborhoods on these counts has measured bureaucracy and called it risk.** That is the same trap
as using a demographic proxy for a physical cause, and judges look for it. The defensible
move is to treat *unrecorded* as its own category—visible, counted, and never silently folded into
"no".

### Six defects you will meet, and why we show them to you

The notebook does not hand you a cleaned table, because these are the teaching:

1. **2,205 Wisconsin shelters have latitude and longitude swapped.** Every value is a well-formed
   float in a plausible range. A national range check passes because 97% of the file is fine.
   The single-row version of the same problem: one shelter registered to **Texas** carries
   coordinates in **Sonoma County, California**, 2,400 km away. `state` and the coordinates
   disagree, and in a spatial join the coordinates win silently.
2. **A blank string is not a null.** `ada_compliant IS NOT NULL` matches 49,356 rows nationally;
   46,338 of them contain a single space.
3. **`ada_compliant` is a decoy.** It is the obvious name, sits beside the real field, and has 63
   `YES` rows in the entire United States. `wheelchair_accessible` has 11,954.
4. **The flags are `YES`/`NO`, not `Y`/`N`**—and the same table uses whole words elsewhere. A
   filter returning zero looks exactly like a feature that does not exist.
5. **Census tract boundaries changed in 2020.** The BigQuery geometry table is 2010 vintage;
   everything else is 2020. Anchoring on the wrong one silently discards a fifth of the state.
6. **Three shelters record impossible capacities, and one state's headline number depends on two
   of them.** Commerce High School and Commerce Primary School, both in Commerce, Georgia, report
   **270,135** and **225,112** evacuation spaces. Commerce has a population of about seven thousand.
   Those two rows are **43% of Georgia's entire reported state capacity**—take them out and Georgia
   drops from first of these eight states to fourth. California's is gentler and more revealing:
   *"St. Anthony Retreat, 10 Buildings"* reports 135,036 spaces with a post-impact capacity of
   exactly half that, which is what a units error looks like from the outside. The notebook flags
   all three and prints them rather than dropping them—the number is FEMA's, and quietly overwriting
   a federal record is not ours to do.

**This is why the notebook's validation section has three verdicts, not two.** A **FAIL** means our
load is broken and you should stop. A **WARN** means the source data is untidy right there, and the
offending rows are printed underneath so you can look at them. Do look at them—defect 6 shows up as
a WARN, and it is the kind of thing that ends up on a slide.

### What we deliberately excluded, and why this challenge is different

| Left out | Why |
|---|---|
| `org_poc_name` and the other contact columns | 47,006 rows nationally contain a named individual. Individual-level personal data is an automatic rejection here |
| CDC SVI **Theme 3** and `RPL_THEMES` | Theme 3 is racial and ethnic minority status. See below |
| FEMA NRI `RISK_SCORE` and every `*_RISKS` column | Composites that multiply hazard by social vulnerability. Using them while also ranking on vulnerability double-counts |
| Real-time storm feeds | Empty in October. This is a planning tool |
| Google geocoding for the address-only files | Maps Platform forbids storing geocoded coordinates beyond 30 days, so they cannot underpin a table you keep |

**What makes this challenge different from the other four:** the excluded column that matters most
is not one we removed. It is one nobody ever filled in. Two thirds of the accessibility field is
blank at source, and no amount of cleaning, joining or grounding creates a record that does not
exist. Every other challenge asks you to be careful with the data you have. This one asks you to be
honest about data that is not there.

### What "auditing the outcome" actually means

Three steps, about twenty minutes, and most teams will skip it.

1. **Produce your ranked list**—whichever tracts your agent says to prioritize.
2. **Join it back to the demographic columns** in `vulnerability_tracts`, including the ones you
   were not allowed to use as inputs.
3. **Compare to the state as a whole.** Is the distribution of your recommendations different from
   the distribution of the population?

Then say the answer out loud: **did the plan land where people cannot leave, or where somebody
happened to fill in the form?**

That is not a rhetorical question on this challenge. Reporting quality varies by state by an order
of magnitude, and a ranking built on recorded accessibility will systematically favor the places
with good clerical practice. Report what you find, including if the answer is "no difference"—both
answers are worth having, and the team that checked is doing something the team that assumed is not.

### Race is not a model input here. It is an audit of your output.

This is a rule for the whole event, and the reasoning matters more than the rule:

- Race genuinely **does** correlate with these outcomes. Do not claim otherwise—anyone who knows the
  literature will correct you.
- But it is a **proxy**. The causal variables are physical and structural—vehicle access, building
  type, medical dependency, distance—and we can measure those directly.
- **Removing the column does not remove the bias.** Correlated proxies survive. This is "fairness
  through unawareness" and it does not work.

The remedy is auditing what your agent recommends, not deleting an input. This is consistent with
Google's own published responsible-AI guidance.

---

## Going further

Everything above is what your agent has to do. Everything below is optional, and it is where the
difference between two teams actually shows up.

### What will set yours apart

Every team in this room starts from the identical five tables, the same state list, the same
technology. **The core is not where you win.** Spend fifteen minutes deciding what *your* version
does that nobody else's will:

- **Treat "unrecorded" as its own category, visibly.** The single highest-value thing you can do,
  and most teams will not. Your agent should be able to say *"eleven of these I can speak to;
  sixty-four nobody has assessed"* rather than silently filtering to the eleven.
- **Ground one building at a time.** An area question about accessibility answers nothing; a named
  building at a named address answers five times in eight. It is slow, it is real, and almost nobody
  will try it.
- **Say which claims are fresh and which are historical.** A shelter record from a 2022 hurricane
  and a Maps lookup from nine seconds ago are different kinds of fact. An agent that labels them is
  more useful than one that blends them into confident prose.
- **Make distance mean something.** Twelve kilometers is not far. It is impassable for a household
  with no vehicle and merely inconvenient for one with two. An agent that knows the difference is
  doing the actual job.
- **Get real travel times back.** Our tables carry straight-line distance only. The direct route is
  Grounding with Google Maps itself: include `routing` in `grounding_types` alongside `places` and
  the same grounded call returns drive times and directions—exactly the add-on that turns a
  straight-line distance into something a planner can use. See
  [Routing—Find Directions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/grounding/grounding-with-google-maps#routing-find-directions)
  in the docs. The alternative is Maps Grounding Lite's `compute_routes`, which returns distance
  *and* duration, needs an API key (the [Maps Demo Key](https://developers.google.com/maps/demo-key)
  covers it with no billing account and no credit card), and also satisfies your managed-MCP
  requirement.
- **Change the hazard.** We pull FEMA NRI's hurricane and coastal-flood columns. The service
  publishes others. Swapping the prefix turns this into a wildfire or an ice-storm tool, and if you
  picked California you should.
- **Add the elderly-living-alone layer.** ACS table `B11007_003E` is exactly *"households with one
  or more people 65 years and over: 1-person household"*—the best single proxy for "nobody will
  notice if they don't leave". Needs a
  [free Census API key](https://api.census.gov/data/key_signup.html).
- **Take the equity audit seriously** instead of as a footnote. The reporting bias described above
  is probably in your output right now.
- **Bring a dataset nobody else has**—your state's assisted-living license roster, county evacuation
  zone polygons, transit fleet accessibility. (See below—check the license first.)

Read [how you'll be judged](#how-youll-be-judged) *before* you decide. It's at the bottom, it takes
two minutes, and it will change what you build.

### The add-on we'd build if we had another four hours

The data section admits something: **for roughly two thirds of American shelters, nobody has
recorded whether a person in a wheelchair can get in.** Not hidden, not hard to query—never written
down. We looked. It does not exist.

So build the thing that asks.

**An assessment agent.** A shelter operator talks to it, and it produces the record. Not a
form—a conversation. Because a form gets you *"yes, accessible,"* and an agent hears *"there's a
ramp at the side door but it's chained outside school hours, and the lift's been out since March"*
and asks the follow-up that matters: **can somebody in a wheelchair get in, unaccompanied, today?**
That single distinction changes half the recommendations in this challenge, and no dropdown will
ever capture it.

Why this is worth your time rather than just worthy:

- **It closes the loop on our stated limitation.** We told you the data doesn't exist. You went and
  got it. That is a very strong thing to say in a demo.
- **Its output feeds your differentiator directly.** Maps grounding can confirm a building is there
  and open. It cannot tell you the ramp is chained. The two together are a complete answer and
  neither is on its own.
- **It is cheaper than it looks.** A handful of writes with nobody competing for the same row, so
  appending to BigQuery is fine—and you already have the shelter list to walk.

---

## Bringing your own data

**You're not limited to what we provide.** If your team knows a dataset that would make this better,
bring it. Thoughtful sourcing is exactly the judgment this challenge rewards.

**Augment, don't replace.** Get the core working first. "Let's find better data" is one of the most
reliable ways to lose ninety minutes and have nothing to demo.

**Check the license before you load it.** This is a publicly branded event and winning projects get
promoted. Anything you bring has to clear the same bar we applied to ourselves:

| | |
|---|---|
| ❌ No **NonCommercial** (NC) | Winners are promoted commercially |
| ❌ No **NoDerivatives** (ND) | Building on the data is the whole point |
| ❌ No **share-alike** (ODbL, CC BY-SA) | It would encumber what *you* build |
| ❌ No **individual-level personal data** | Aggregate public statistics only |
| ❌ No **unstated license** | No license means no rights granted |
| ✅ Public domain, CC0, US Government works | Safe |

**The trap most likely to catch you on this challenge:** an ArcGIS Online item called
*"Open Shelters in Harris County, Texas"* looks perfect and is **fabricated Esri training data**,
licensed for demonstration only. Its own description says so. Read the license on anything you find
on ArcGIS Online, because a great deal of it is coursework that looks like government data.

**And one that's specific to you:** the strongest datasets in this domain are the ones that name
people—patient registries, special-needs shelter sign-up lists, transport-assistance rosters. Several
counties publish something that looks like an aggregate and is not. If a row could be one person,
it is an automatic rejection, however useful it would have been.

---

## What's in this repository

```
README.md                             this file
notebooks/
  c4_01_load_explore.ipynb            The main artifact. Run this first
  c4_90_publish_snapshot.ipynb        ROI maintainers only. You do not need it
scripts/
  load.sh                             Headless fallback if Colab is unavailable
data/                                 Empty. Everything lives in BigQuery, in your project
agent/                                Your agent goes here. README.md restates the requirements
```

`c4_90_publish_snapshot.ipynb` is for ROI maintainers: it regenerates the Cloud Storage snapshot
that `scripts/load.sh` reads from. If you run it you will get a permissions error, because you do not
have write access to our bucket. That is expected, and you never need it.

`agent/` is empty on purpose. We built the on-ramp—every registered shelter in your state, the
tracts around them, the counties where people depend on electricity to stay alive, the hazard
exposure, the licenses checked, and a validation suite that tells you plainly what is wrong with all
of it. We didn't build the vehicle. [`agent/README.md`](agent/) restates what yours has to do.

---

## How you'll be judged

**"Finished" is not the goalpost.** Almost nobody completes everything they set out to do in 4.5
hours—that's the design, not a failure. A team that gets three quarters of the way with clear
reasoning and honest limitations will beat a team that demos something polished and hollow.

**You are judged against the track you chose**, not against a fixed idea of the right answer. A
shelter-readiness team is expected to hand over a list of buildings to verify before the season; a
medically-dependent team is expected to hand over the facilities and counties where a generator or
a transfer agreement should exist and does not. Neither is marked down for not looking like the
other. Say which track you took, and which state, early.

**Judges score your submission, not a conversation.** They work from your repo, your Skills
project, your deck and your pitch video, after the event, with no follow-up questions. The
questions below are what they are looking for; put the answers in the deck or the video, in those
words, rather than waiting to be asked.

| Dimension | Weight | The question judges are asking |
|---|---:|---|
| **Impact & insight** | 30 | Would an emergency manager actually use this? Is the brief specific enough to act on? |
| **Technical execution** | 30 | Does it work, and is Maps grounding genuinely called and acted on rather than name-checked? |
| **Rigor & judgment** | 25 | Can you defend the decisions you made along the way? |
| **Craft & communication** | 15 | Does the short pitch land, does the quick demo work, can you justify your interface? |
| **Bonus—range** | **+10** | Technology breadth and ambition that *serves* the solution |

Bonus sits **on top** of the 100, so ambition can't cannibalize the core. Nail the fundamentals and
add nothing, and you can still win. Wire up five services with no coherent readiness brief, and you
can't win on breadth alone.

### What "Rigor & judgment" actually means

This is the one teams under-invest in, because it's least visible in a demo. It's a quarter of your
score and the easiest place to stand out. Four concrete things:

**Data decisions you can defend.** What does "reachable" mean in your agent, and why that number?
Which of your figures measure the world and which measure the paperwork? If you brought your own
dataset, do you know its license?

**Validation.** Did you check your tables before building, or assume no error meant no problem? The
notebook ships a validation section—using it, and saying what it told you, counts. It reports three
verdicts rather than two, and the WARNs are real defects in federal data that will otherwise end up
in your totals.

**Bias handling.** Did you run the [equity audit](#what-auditing-the-outcome-actually-means)? Did
you find the reporting bias we warned you about? Bring the numbers, not the intention.

**Knowing what your system can't do.** Two thirds of the accessibility field is blank. Our tables
carry straight-line distance, not drive time. emPOWER is county-level, so you can say how many but
never which block. A team that volunteers its limitations shows more skill than one that
oversells—and judges are told to reward it.

One warning worth internalizing: **an agent that reports "no accessible shelters nearby" when it
means "nobody has assessed them" has stated a fact about paperwork as a fact about buildings.** That
is a confident, plausible, wrong answer about vulnerable people, which is the worst output this
domain can produce. A judge who asks "what does your agent say when the field is blank?" should get
a good answer.

### A note on decisions generally

Several places in this challenge ask you to choose rather than follow instructions—which state,
which hazard, what "reachable" means, how to weigh an unrecorded flag against a recorded one, what
to cut when you're behind. **None of those have a single right answer, and judges are not checking
them against a key.** They're asking whether you made the choice on purpose and can say why.

---

## Reference

**Your differentiator**
[Grounding with Google Maps](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/grounding/grounding-with-google-maps)
·
[Attribution requirements](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/grounding/grounding-with-google-maps#google-maps-attribution-guidelines)
·
[Maps Grounding Lite MCP server](https://developers.google.com/maps/ai/grounding-lite)
·
[Maps Demo Key](https://developers.google.com/maps/demo-key)

**The rest of the stack**
[ADK](https://adk.dev/)
·
[Agent Runtime](https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/runtime)
·
[MCP Toolbox for Databases](https://github.com/googleapis/mcp-toolbox)
·
[BigQuery geospatial functions](https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/geography_functions)
·
[Antigravity](https://antigravity.google/docs/getting-started)—IDE and CLI

**Our data sources, if you want to check our work**
[FEMA National Shelter System](https://gis.fema.gov/arcgis/rest/services/NSS/FEMA_NSS/FeatureServer)
·
[FEMA National Risk Index](https://hazards.fema.gov/nri/)
·
[CDC/ATSDR Social Vulnerability Index](https://www.atsdr.cdc.gov/place-health/php/svi/)
·
[CDC PLACES](https://www.cdc.gov/places/)
·
[HHS emPOWER](https://empowerprogram.hhs.gov/)
·
[CMS Nursing Home Provider Information](https://data.cms.gov/provider-data/dataset/4pq5-n9py)

> ⚠️ **Grounding with Google Maps must not be used for emergency response.** Google's terms are
> explicit: *"You won't use Grounding with Google Maps for high risk activities including emergency
> response services."* This challenge is preparedness planning done weeks ahead, which is why it is
> permitted. In our testing the model enforced the line itself—prompted to dispatch help during an
> active event, it refused and said to call 911. Do not rely on that; keep your framing on the right
> side of the boundary and you will never meet it.

---

## Getting help

Ask your table captain first. Every table has one: not a judge, a consultant who sits with you for
the day. Then the ROI facilitator on the floor, and the event's Discord channel, which the organizers
use for direct questions during the day. Whatever you're stuck on has probably already been solved at
another table.

To report a problem with the data or the notebook, run the **diagnostic cell** at the bottom of the
notebook and share what it prints. One block, everything a coach needs, beats a screenshot every
time.

Two failures common enough to name:

**`400 INVALID_ARGUMENT` about multiple tools** means you are on a Gemini 2.5 model with a built-in
tool and a function tool in the same agent. Move to 3.x, or split the maps tool into a sub-agent.
[The technology you'll use](#the-technology-youll-use) has both.

**A query returning zero rows** is usually a field that is blank rather than false. That is defects
2 and 4 above, and it accounts for most of the confusion this challenge generates.
