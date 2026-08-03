"""End-to-end smoke test for the curator benchmark harness.

Writes two tiny synthetic ExperienceUnits and their gold files, then runs the
whole pipeline -- run_bench -> verify -> score -- against a live local Ollama
and prints the metrics table.

This is a harness test, not a model test. Two units cannot say anything about
whether a model is good enough to bundle; they only prove the plumbing is
connected and that the gates and metrics compute. It exists so that a real
sweep never fails on unit 1 of 200.

Fixtures live in `eval/curator/smoke/` and are rewritten on every run, so they
stay in sync with the schema. Results land in `eval/curator/results/_smoke_<model>/`.

Usage:
    python eval/curator/smoke_test.py                    # qwen3:1.7b
    python eval/curator/smoke_test.py --model nuextract  # any installed model
    python eval/curator/smoke_test.py --force            # ignore cached results

Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import run_bench  # noqa: E402
import score as score_mod  # noqa: E402
import verify as verify_mod  # noqa: E402

HERE = Path(__file__).parent
SMOKE = HERE / "smoke"
UNITS = SMOKE / "units"
GOLD = SMOKE / "gold"

# --- unit 001: gold-POSITIVE. Two durable items (a fact with a number, and a
# --- standing preference), wrapped in enough chatter that a model which just
# --- echoes every line will fail precision.
UNIT_POS = """user: Quick note before I forget - the Postgres instance for NeuroVault runs on port 5433, not the default.
assistant: Noted. Do you want me to update the connection string in the config?
user: Yes please. And from now on I always want migrations reviewed by a second person before they land.
assistant: Got it, I'll add that to the release checklist.
user: thanks, that's all for now
"""

# --- unit 002: gold-NEGATIVE. Real content, zero durability: a transient
# --- status check. Numbers are present on purpose, to bait extraction.
UNIT_NEG = """user: morning! did the nightly build finish?
assistant: Yes, it completed at 03:12 and all 412 tests passed.
user: nice, thanks
assistant: Anything else you need?
user: nope, that's it
"""

GOLD_POS = {
    "gold_proposals": [
        {
            "statement": "The NeuroVault Postgres instance runs on port 5433.",
            "must_match_terms": ["5433"],
        },
        {
            "statement": "Migrations must be reviewed by a second person before landing.",
            "must_match_terms": ["migration", "review"],
        },
    ],
    "nothing_durable": False,
}

GOLD_NEG = {"gold_proposals": [], "nothing_durable": True}


def write_fixtures() -> None:
    UNITS.mkdir(parents=True, exist_ok=True)
    GOLD.mkdir(parents=True, exist_ok=True)
    (UNITS / "unit_001.txt").write_text(UNIT_POS, encoding="utf-8")
    (UNITS / "unit_002.txt").write_text(UNIT_NEG, encoding="utf-8")
    (GOLD / "unit_001.gold.json").write_text(json.dumps(GOLD_POS, indent=2), encoding="utf-8")
    (GOLD / "unit_002.gold.json").write_text(json.dumps(GOLD_NEG, indent=2), encoding="utf-8")


def ollama_up(host: str) -> str | None:
    try:
        with urllib.request.urlopen(f"{host}/api/version", timeout=5) as r:
            return json.loads(r.read()).get("version")
    except Exception:
        return None


def model_installed(host: str, model: str) -> bool:
    try:
        with urllib.request.urlopen(f"{host}/api/tags", timeout=10) as r:
            tags = json.loads(r.read()).get("models", [])
    except Exception:
        return False
    names = {m.get("name", "") for m in tags}
    return model in names or any(n.split(":")[0] == model for n in names)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Smoke-test the curator harness.")
    ap.add_argument("--model", default="qwen3:1.7b")
    ap.add_argument("--host", default=run_bench.DEFAULT_HOST)
    ap.add_argument("--think", choices=["auto", "true", "false", "omit"], default="auto")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--timeout", type=int, default=120)
    args = ap.parse_args(argv)

    print("=" * 72)
    print(f"CURATOR HARNESS SMOKE TEST  model={args.model}")
    print("=" * 72)

    version = ollama_up(args.host)
    if not version:
        print(f"FAIL: no Ollama at {args.host}. Start it with `ollama serve`.", file=sys.stderr)
        return 1
    print(f"[1/6] Ollama {version} reachable at {args.host}")

    if not model_installed(args.host, args.model):
        print(f"FAIL: model '{args.model}' is not installed. `ollama pull {args.model}`",
              file=sys.stderr)
        return 1
    print(f"[2/6] model '{args.model}' installed")

    write_fixtures()
    print(f"[3/6] fixtures written: 2 units (1 positive, 1 negative) + gold -> {SMOKE}")

    out = HERE / "results" / f"_smoke_{args.model.replace(':', '-').replace('/', '_')}"
    print(f"[4/6] running benchmark -> {out}")
    rc = run_bench.main([
        "--model", args.model,
        "--units-dir", str(UNITS),
        "--out", str(out),
        "--think", args.think,
        "--timeout", str(args.timeout),
        "--host", args.host,
    ] + (["--force"] if args.force else []))
    if rc != 0:
        print("FAIL: run_bench returned non-zero", file=sys.stderr)
        return rc

    print("[5/6] verifying")
    rc = verify_mod.main(["--results-dir", str(out), "--units-dir", str(UNITS)])
    if rc != 0:
        print("FAIL: verify returned non-zero", file=sys.stderr)
        return rc

    print("[6/6] scoring\n")
    rc = score_mod.main([
        "--results-dir", str(out),
        "--gold-dir", str(GOLD),
        "--units-dir", str(UNITS),
    ])
    if rc != 0:
        print("FAIL: score returned non-zero", file=sys.stderr)
        return rc

    # --- raw model output, so a human can eyeball whether the extractions are
    # --- real or whether the metrics are being satisfied by an empty shell.
    print("\n" + "-" * 72)
    print("RAW MODEL OUTPUT")
    print("-" * 72)
    for path in sorted((out / "units").glob("unit_*.json")):
        row = json.loads(path.read_text(encoding="utf-8"))
        print(f"\n[{row['unit_id']}] status={row['status']} "
              f"parse={row.get('parse_status')} {row['wall_seconds']}s "
              f"think={row.get('think')} thinking_chars={row.get('thinking_chars')}")
        print("  " + (row.get("content") or "<none>").strip()[:900])

    verify_report = json.loads((out / "verify.json").read_text(encoding="utf-8"))
    print("\n" + "-" * 72)
    print("GAUNTLET VERDICTS")
    print("-" * 72)
    for u in verify_report["units"]:
        print(f"\n[{u['unit_id']}] n={u['n_proposals']} {u['counts']}"
              + ("  INCOHERENT_ABSTENTION" if u.get("incoherent_abstention") else ""))
        for p in u["proposals"]:
            print(f"  {p['verdict']:12s} {str(p.get('statement'))[:80]}")
            g1 = p.get("g1") or {}
            g2 = p.get("g2") or {}
            print(f"               G1={g1.get('match')} "
                  f"G2 quote={g2.get('in_quote')} unit_only={g2.get('unit_only')} "
                  f"missing={g2.get('missing')}")

    metrics = json.loads((out / "metrics.json").read_text(encoding="utf-8"))
    degenerate = metrics.get("degenerate_rate")
    print("\n" + "=" * 72)
    if degenerate and degenerate > 0:
        print("RESULT: harness OK, but the model produced DEGENERATE output on a "
              "gold-positive unit.")
    else:
        print("RESULT: harness OK, model produced real extractions.")
    print("=" * 72)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
