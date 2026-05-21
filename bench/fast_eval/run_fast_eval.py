"""Fast local retrieval eval for NeuroVault.

Recall-only, no LLM grading: for each case, ingest a few small notes into
an isolated brain, run ONE recall, and pass if a top-K hit contains any
`expect_any` substring. Optional `expect_rank_above` checks the current
value outranks a stale one (knowledge-update cases).

Why this exists: LongMemEval is contaminated, sub-noise, and too heavy to
run on the dev laptop. This is the fast gate — ~1-2 min, deterministic,
laptop-safe (small fixtures, no 20k-chunk haystacks, no agent QA). Use it
to check whether a retrieval change helps BEFORE spending on the bench.

Prereq: Rust server running on 127.0.0.1:8765
  (NEUROVAULT_OBSERVATIONS_BRAIN=claude-activity recommended).

Usage:
  server/.venv/Scripts/python.exe bench/fast_eval/run_fast_eval.py
  ...optional flags:
  --rerank            force rerank=true on every recall (A/B the reranker)
  --ablate a,b        pass ablate flags through to recall
  --only <id>         run a single case by id
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8765"
HERE = Path(__file__).resolve().parent


def http(method, path, body=None, params=None):
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        txt = r.read().decode("utf-8")
    return json.loads(txt) if txt else {}


def ensure_clean_brain(name):
    brains = http("GET", "/api/brains")
    bid = next((b["id"] for b in brains if b.get("name") == name), None)
    if bid is None:
        resp = http("POST", "/api/brains", {"name": name, "description": "fast-eval"})
        bid = resp.get("id") or name
    http("POST", f"/api/brains/{bid}/reset", {})
    http("POST", f"/api/brains/{bid}/activate", {})
    return bid


def run_case(case, recall_limit, expect_top, pool, rerank, ablate, post_facts):
    bid = ensure_clean_brain("fasteval-" + case["id"])
    # Seed the realistic distractor crowd FIRST, then the case's own notes.
    # Capture filename -> engram_id so facts can cite their source note.
    id_map = {}
    for note in pool + case["notes"]:
        resp = http("POST", "/api/notes",
                    {"filename": note["file"], "content": note["content"], "brain_id": bid})
        eid = resp.get("engram_id") or resp.get("id") if isinstance(resp, dict) else None
        if eid:
            id_map[note["file"]] = eid
    # Consolidation step (--facts): record the facts an agent would extract.
    # This is the Option-D write-time layer simulated; each fact cites a
    # real source note. Without --facts this is the raw-retrieval baseline.
    if post_facts:
        for f in case.get("facts", []):
            src = id_map.get(f.get("source_file", ""))
            if src:
                http("POST", "/api/facts", {
                    "subject": f["subject"], "attribute": f.get("attribute", ""),
                    "value": f["value"], "source_engram": src, "brain_id": bid,
                })
    # Small debounce so BM25 rebuild fires (5s window) before recall.
    time.sleep(6)
    params = {"q": case["query"], "limit": recall_limit, "brain_id": bid}
    if rerank:
        params["rerank"] = "true"
    if ablate:
        params["ablate"] = ablate
    hits = http("GET", "/api/recall", params=params)
    if not isinstance(hits, list):
        hits = hits.get("hits") or hits.get("results") or []

    def text(h):
        return ((h.get("title") or "") + "\n" + (h.get("content") or "")).lower()

    et = case.get("expect_top", expect_top)
    expect = [e.lower() for e in case["expect_any"]]
    # rank of the answer within the FULL returned list (not pre-truncated),
    # so we can report where it actually landed even if outside expect_top.
    hit_idx = next((i for i, h in enumerate(hits)
                    if any(e in text(h) for e in expect)), None)
    passed = hit_idx is not None and hit_idx < et

    detail = ""
    if passed and case.get("expect_rank_above"):
        loser = case["expect_rank_above"].lower()
        loser_idx = next((i for i, h in enumerate(hits) if loser in text(h)), None)
        if loser_idx is not None and loser_idx < hit_idx:
            passed = False
            detail = f"stale '{case['expect_rank_above']}' ranked above current (#{loser_idx} < #{hit_idx})"
    if not passed and not detail:
        if hit_idx is None:
            got = [(h.get('title') or h.get('content') or '')[:34] for h in hits[:expect_top]]
            detail = f"answer not in {len(hits)} hits; top: {got}"
        else:
            detail = f"answer at rank {hit_idx}, needed top-{et}"
    return passed, (hit_idx if hit_idx is not None else -1), detail


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rerank", action="store_true")
    ap.add_argument("--ablate", default=None)
    ap.add_argument("--only", default=None)
    ap.add_argument("--facts", action="store_true",
                    help="record each case's consolidation facts (Option-D write-time layer)")
    args = ap.parse_args()

    spec = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))
    recall_limit = spec.get("recall_limit", 8)
    expect_top = spec.get("expect_top", 1)
    pool = spec.get("distractor_pool", [])
    cases = spec["cases"]
    if args.only:
        cases = [c for c in cases if c["id"] == args.only]

    print(f"fast-eval: {len(cases)} cases, expect_top={expect_top}, "
          f"distractor_pool={len(pool)}, recall_limit={recall_limit}, "
          f"rerank={'on' if args.rerank else 'default'}, ablate={args.ablate or '-'}, "
          f"facts={'ON (consolidation)' if args.facts else 'off (raw baseline)'}")
    t0 = time.time()
    by_cat = {}
    n_pass = 0
    for c in cases:
        ok, idx, detail = run_case(c, recall_limit, expect_top, pool, args.rerank, args.ablate, args.facts)
        n_pass += ok
        cat = c["category"]
        by_cat.setdefault(cat, [0, 0])
        by_cat[cat][0] += ok
        by_cat[cat][1] += 1
        mark = "PASS" if ok else "FAIL"
        print(f"  [{mark}] {c['id']:30s} ({cat}) rank={idx}  {('' if ok else detail)}")

    print(f"\nper-category:")
    for cat, (p, n) in sorted(by_cat.items()):
        print(f"  {cat:18s} {p}/{n}")
    print(f"\nOVERALL: {n_pass}/{len(cases)} = {100*n_pass/len(cases):.0f}%  "
          f"({time.time()-t0:.0f}s)")
    return 0 if n_pass == len(cases) else 1


if __name__ == "__main__":
    raise SystemExit(main())
