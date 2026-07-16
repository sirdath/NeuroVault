# AI Employees on NeuroVault — spec v1 (2026-07-05)

> Status: DRAFT, internal. Tracked in-repo (as is `docs/HANDOFF.md`), but
> internal-facing: it describes an intended design, not shipped behaviour.
> Decision owner: Dath. Engine principle preserved throughout: NeuroVault
> stays a coordination/memory SUBSTRATE; it never runs or schedules agents.
> The runner is a separate companion process.
>
> v1 change (Dath, 2026-07-05): employee #1 is the CURATOR (internal
> knowledge ops + meeting-notes ingestion), not the external Intelligence
> Analyst. The Analyst survives as a later skin of the same archetype.

## Thesis

An "AI employee" is an agent whose value comes from what it REMEMBERS and
KEEPS TRUE, not what a single prompt can do. NeuroVault owns the hard part
(benchmarked recall, provenance, confidence, supersede/temporal, per-agent
brains, handoff/inbox, and a full maintenance tool surface). The missing
20% is a thin runner + runbooks + one ingestion pathway.

## Employee #1: the Curator (knowledge ops)

Whole job: keep the brain well-organized, current, and growing.

1. ORGANIZE (nightly hygiene loop — existing tools):
   find_clutter (merge/archive proposals), check_duplicate on recent
   writes, find_contradictions (triage: resolve or escalate),
   find_orphan_links, list_unnamed_clusters + set_cluster_names,
   bulk_set_kind / bulk_add_tag coherence, add missing [[links]].
2. UPDATE from conversations and changes:
   sweep engrams since last run; where new info replaces old, propose
   supersede_note with provenance; keep core-memory blocks current.
3. MONITOR WORK — consent-first, artifacts only:
   watches what is SHARED INTO the brain (meeting outcomes, decisions,
   updates, commits via graphify), maintains rolling per-project /
   per-person "state of work" notes, produces a weekly digest.
   HARD LINE: never screen/activity surveillance; only artifacts people
   deliberately put in the brain. This is a product-identity rule.
4. INGEST new information: meetings pathway (below) + existing
   drop-folder inbox.

## The meetings ingestion pathway

Input: ALREADY-TRANSCRIBED notes (no capture infra in scope): .md/.txt/
.vtt/.srt exports from Otter/Fireflies/Granola/etc., dropped into a
watched folder (~/.neurovault/brains/<id>/inbox/meetings/ or app
drag-and-drop) or pushed via POST /api/inbox later (the plugin surface).

Two artifacts per meeting, always:
- RAW: stored verbatim, content-addressed, never edited by anyone
  (evidence layer). Engrams cite it.
- DISTILLED (context-aware): before writing, the Curator recalls prior
  meetings on the topic + entities + project context, then produces:
  decisions (with the why), action items, open questions, [[links]] to
  related meetings/notes, supersedes where a decision changed, entity
  stamps. Action items become handoff() items to the right inbox.
- ROLLING COMPILATION: per-project wiki pages updated via the existing
  compile_prepare/compile_submit pipeline — "what we currently believe
  about X", always current.

Storage contract (unchanged): NeuroVault holds conclusions, the archive
holds evidence, tables hold numbers.

## Guardrails (the trust ladder)

Curation is destructive-adjacent. Autonomy is a per-action-class dial:
- Level 0 (v0 default): PROPOSE ONLY — all merge/archive/supersede/
  bulk actions land as an approval queue (handoff to the human's inbox);
  ingest+linking+digest may auto-run (additive, reversible).
- Level 1: auto-apply low-risk classes (dedupe-merge at >=0.95, orphan
  link fixes) with a daily action report; destructive still gated.
- Level 2: full auto with weekly audit (engram_history + tool_audit are
  the trail; supersede is reversible; deletes stay soft/dormant).
Budget cap and action-count cap per run from day one.

## Architecture

```
role preset (role.yaml + seed vault: persona.md, runbook-*.md)
        |
   nv-employee runner (separate daemon; cron/event wake; budget+action caps)
        |                         |
   model API                 watchers/collectors v0:
 (Claude via MCP;             meetings inbox folder, since-last-run
  GPT/Gemini via HTTP          engram sweep, audit_recent feed
  tool bridge later)               |
        v                          v
   employee brain  <->  shared company brain (handoff/inbox between them)
        |
   outputs: approval queue (handoffs), weekly digest note,
   rolling wiki compilations, action audit report
```

## v0 scope (build order)

1. nv-employee runner: wake on cron; loop = gather deltas (new engrams,
   meetings inbox, audit feed) -> run Curator runbooks against the model
   -> write proposals/notes via MCP tools -> digest. Claude-first.
2. Meetings pathway: folder watcher + vtt/srt/txt/md normalization ->
   raw archived -> distill runbook -> distilled note + action-item
   handoffs + supersede proposals.
3. Approval queue UX v0: proposals as handoff items addressed to the
   human; a simple "approve/reject" pass in Claude Code (or the app
   later) executes or discards them.
4. Weekly digest + action report.
5. Dogfood 2 weeks on NeuroVaultBrain1 + Dath's real meeting notes.
   Success = brain measurably tidier (clutter count down, contradictions
   resolved), meetings queryable ("what did we decide about X and when
   did it change?"), zero bad destructive actions.

Deliberately NOT in v0: meeting capture/bots, posting anywhere, fleets,
hosted control plane, billing, non-Claude models.

## Interface architecture (decided 2026-07-06)

Employees get their OWN surface, grown in stages:
1. v2 (now): the Curator panel is a standalone-capable component (talks
   only to /api/employee/*). "Open as window" spawns a dedicated Tauri
   WebviewWindow (?window=employees boot path renders the employee UI
   with no notes chrome). Discovery stays in-app via the Curator tab.
2. At employee #2: that window becomes the Employee Manager (roster
   sidebar, one page per employee); the in-app tab shrinks to a summary
   card + an "Open AI Employee Manager" button.
3. Backend gate before #2: employee state (config/queue/activity/
   proposals/runs) is currently singleton — refactor everything to be
   keyed by employee_id first.
Rationale: ops surface vs deep-work surface; mirrors substrate-vs-
workforce separation; keeps commercial packaging clean; but no cold
separate app while the roster is one (discovery lives in-app).

## The fleet (built 2026-07-06)

The singleton Curator became a ROSTER. Backend: src-tauri/src/memory/
roles.rs (catalog) + employee.rs (per-instance engine keyed by id).
State per employee under ~/.neurovault/employee/instances/<id>/; roster
in employees.json; legacy singleton files migrate to instances/curator/
on first load. Legacy /api/employee/* stays as the Curator's alias so
the original panel keeps working; /api/employees[/:id/...] is the fleet
surface (index+hire, status/config/tick/run/stop/activity/runs/
proposals/meetings).

Catalog (each: name, palette, glyph_seed -> its own line-art character):
- Curator (violet)      knowledge ops     available  sentinel+judge
- Scribe (teal)         meetings desk     available  deep run
- Librarian (amber)     ingest desk       available  deep run (raw inbox)
- Chronicler (green)    daily digest      available  toolless: SQL delta
                                                     -> haiku writes note
- Quartermaster (blue)  todos/handoffs    available  toolless: stale scan
- Scout (cyan)          outside intel     soon       (needs collectors)
- Gatekeeper (rose)     privacy audit     soon       (needs secret scan)

Two loop shapes, both cheap:
1. Sentinel+judge (Curator): free Rust detectors -> batched haiku judge.
2. Toolless writer (Chronicler/Quartermaster): free Rust delta/scan ->
   one haiku call writes a markdown note, filed server-side (zero MCP).
3. Deep run (Scribe/Librarian): full MCP agent session on deep_model,
   per-role --allowedTools whitelist, propose-only.
Per-employee daily_call_budget + wake_minutes; strict empty MCP config
on judge calls so the user's other servers never inflate context.

Interface: the ?window=employees window becomes the Employee Manager
(roster rail + "+" hire menu + per-employee detail; Curator renders the
full mission-control panel, others a lighter view).

## Later skins of the same archetype

- Intelligence Analyst = the Scout role, once collectors land (external
  watch: competitors/market; the v0 spec is in this file's git history).
- Support-knowledge miner; research assistant.

## Monetization sketch (unchanged)

Open-source runner + presets; paid: hosted control plane, team digests,
premium collectors/integrations (Otter/Fireflies/Zoom pull), org-memory
for companies — the regulated/local-first wedge.
