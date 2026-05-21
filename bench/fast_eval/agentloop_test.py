"""Agent-loop / fact-collision test (Option D).

Ingests a realistic mixed brain (distractor pool + the 3 fact-shaped
cases' notes), then records the facts a careful agent WOULD extract —
including a deliberate collision: two facts share the subject "retrieval
pipeline" (owner=Sarah on the Team note, signals=... on the Pipeline
note). A correct retriever must still answer "who owns the retrieval
pipeline" with the Team note, not let the co-subject signals fact boost
the Pipeline note. This is the case the single-fact fast-eval cannot
catch. Recall-only, laptop-safe.

Prereq: server on :8765. Usage:
    server/.venv/Scripts/python.exe bench/fast_eval/agentloop_test.py
"""
from __future__ import annotations
import json, time, urllib.parse, urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8765"
HERE = Path(__file__).resolve().parent


def http(method, path, body=None, params=None):
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=120) as r:
        t = r.read().decode()
    return json.loads(t) if t else {}


# Facts a careful agent extracts, keyed by the source note's title.
# NOTE the deliberate collision on "retrieval pipeline".
FACTS = [
    ("Team", "retrieval pipeline", "owner", "Sarah"),
    ("Pipeline", "retrieval pipeline", "signals", "semantic BM25 graph RRF"),
    ("Morning routine", "coffee", "preference", "Ethiopian Yirgacheffe espresso no milk"),
    ("Auth debugging", "code search", "tool", "ripgrep"),
    ("Editor setup", "editor", "setup", "Neovim lua telescope treesitter"),
    ("Gym", "gym membership", "plan", "annual"),
    ("Phone", "phone plan", "current", "family tier"),
    ("Tea", "tea", "stash", "genmaicha"),
    ("Learning", "spanish", "study", "daily Duolingo"),
    ("Reminders", "mom birthday", "month", "November"),
    ("Cooking", "sourdough", "method", "long cold proof 18h"),
]
TESTS = [
    ("who owns the retrieval pipeline", ["sarah"]),
    ("what coffee do I like", ["yirgacheffe", "ethiopian"]),
    ("what do I use for code search", ["ripgrep"]),
]


def main():
    spec = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))
    notes = list(spec["distractor_pool"])
    for cid in ("pref-buried-codesearch", "pref-coffee", "entity-owner"):
        notes += next(c for c in spec["cases"] if c["id"] == cid)["notes"]

    bid = "agentloop-test"
    brains = http("GET", "/api/brains")
    if not any(b.get("name") == bid for b in brains):
        http("POST", "/api/brains", {"name": bid, "description": "agent-loop test"})
    http("POST", f"/api/brains/{bid}/reset", {})
    http("POST", f"/api/brains/{bid}/activate", {})
    for n in notes:
        http("POST", "/api/notes", {"filename": n["file"], "content": n["content"], "brain_id": bid})
    time.sleep(6)

    # title -> engram_id from the consolidation queue
    q = http("GET", "/api/consolidate", params={"limit": 50, "brain_id": bid})
    tmap = {n["title"].replace("#", "").strip(): n["engram_id"] for n in q.get("notes", [])}

    recorded = 0
    for title, subj, attr, val in FACTS:
        src = tmap.get(title)
        if not src:
            print("  no source engram for", title); continue
        r = http("POST", "/api/facts", {"subject": subj, "attribute": attr, "value": val,
                                        "source_engram": src, "brain_id": bid})
        recorded += 1 if r.get("ok") else 0
    print(f"recorded {recorded}/{len(FACTS)} agent-extracted facts (incl. 'retrieval pipeline' collision)")

    npass = 0
    for query, exp in TESTS:
        hits = http("GET", "/api/recall", params={"q": query, "limit": 6, "brain_id": bid})
        if not isinstance(hits, list):
            hits = hits.get("hits") or hits.get("results") or []
        rank = next((i for i, h in enumerate(hits)
                     if any(e in ((h.get("title") or "") + (h.get("content") or "")).lower() for e in exp)), None)
        ok = rank == 0
        npass += ok
        print(f"  [{'PASS' if ok else 'FAIL'}] {query}  -> rank {rank}")
    print(f"\nAGENT-LOOP: {npass}/{len(TESTS)} = {100*npass//len(TESTS)}%")
    return 0 if npass == len(TESTS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
