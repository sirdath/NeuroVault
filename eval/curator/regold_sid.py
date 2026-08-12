"""Re-annotate the gold set's evidence as SENTENCE IDs.

The 58-unit gold set was labelled against the quote/anchor contracts: each
gold proposal carries an `evidence_hint`, a fragment of the transcript sentence
that supports it. Under the sentence-ID contract evidence is an ID list, so the
gold needs the same claim expressed in the new coordinate system.

This script does that mechanically and REFUSES TO GUESS:

  1. enumerate the unit with `sid.py` -- the same table the prompt and
     `verify_sid.py` use, so a gold ID and a model ID mean the same sentence;
  2. locate `evidence_hint` in the unit text (exact -> whitespace-normalized
     -> case-insensitive, the ladder `verify_anchor.py` already uses);
  3. emit every sentence ID whose span overlaps the located range.

Anything that cannot be mapped cleanly is FLAGGED, never invented. The
distinction the report keeps is:

  mapped            hint located exactly (or after whitespace normalization)
                    onto 1-3 adjacent, citable sentences. Machine-clean.
  mapped_with_caveats
                    IDs were derived, but a human should look: the hint only
                    matched case-insensitively, or it straddles more than the
                    3-ID citation ceiling, or its sentences are
                    redaction-touched, or it lands in a TOOL_RESULT block
                    (whose role the output schema cannot express).
  unmapped          no `evidence_hint` at all, or the hint is not in the unit
                    text. `evidence_sids` is written as null with the reason
                    attached; nothing is fabricated.

Originals are never modified. Output goes to a sibling directory (default
`gold_sid/`) with the same filenames, so `--gold-dir gold` keeps scoring the
statements exactly as before while `gold_sid/` carries the evidence contract.

Usage:
    python3 eval/curator/regold_sid.py \
        --gold-dir eval/curator/gold \
        --units-dir eval/curator/units \
        --out-dir eval/curator/gold_sid

Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
import sid as sidmod  # noqa: E402  (THE shared enumeration)
from run_bench import load_units  # noqa: E402
from verify_anchor import build_norm, locate  # noqa: E402  (the locate ladder)

MAX_IDS = 3

# Pre-registered: the shortest hint prefix that may stand in for a whole hint
# under --prefix-fallback. Short enough to rescue a truncated hint, long enough
# that it pins one place in the transcript rather than a common phrase.
MIN_PREFIX_CHARS = 24


def longest_located_prefix(
    hint: str,
    unit_text: str,
    norm: tuple[str, list[int]],
) -> tuple[int, dict[str, Any] | None]:
    """Longest prefix of `hint` that still locates, and its hit.

    Many gold hints are labeler paraphrases or were truncated at ~64 chars mid
    word, so the head is verbatim and the tail is not. Binary search over the
    prefix length finds exactly where the hint stops being transcript text.
    Monotonic in practice and deterministic either way: the same hint and unit
    always give the same answer.
    """
    lo, hi, best = 0, len(hint), None
    while lo < hi:
        mid = (lo + hi + 1) // 2
        hit = locate(hint[:mid], unit_text, norm)
        if hit is not None:
            lo, best = mid, hit
        else:
            hi = mid - 1
    return lo, best


def map_hint(
    hint: str,
    unit_text: str,
    table: dict[str, Any],
    norm: tuple[str, list[int]],
    prefix_fallback: bool = False,
) -> dict[str, Any]:
    """Hint -> sentence IDs. Returns {sids, flags, match, ...}; sids None if unmapped."""
    hit = locate(hint, unit_text, norm)
    prefix_len = None
    if hit is None:
        # Diagnostic first, decision second: always measure how much of the
        # hint IS transcript text, so the report can say whether the misses
        # are truncations (long prefix) or inventions (short prefix).
        prefix_len, prefix_hit = longest_located_prefix(hint, unit_text, norm)
        if not (prefix_fallback and prefix_hit is not None and prefix_len >= MIN_PREFIX_CHARS):
            return {
                "sids": None,
                "flags": ["hint_not_located"],
                "match": "none",
                "located_prefix_chars": prefix_len,
                "prefix_rescuable": bool(prefix_hit is not None
                                         and prefix_len >= MIN_PREFIX_CHARS),
            }
        hit = prefix_hit

    overlapping = [
        s for s in table["sentences"]
        if s["start"] < hit["end"] and s["end"] > hit["start"]
    ]
    if not overlapping:
        # The hint located inside a region that produced no sentence: a role
        # marker line, or whitespace the trim pass dropped.
        return {"sids": None, "flags": ["no_sentence_covers_hint"], "match": hit["match"]}

    sids = [s["sid"] for s in overlapping]
    flags: list[str] = []
    if prefix_len is not None:
        # Rescued under --prefix-fallback: the head of the hint is transcript
        # text, the tail is the labeler's own words. Always flagged.
        flags.append("mapped_from_hint_prefix")
    if hit["match"] == "case_insensitive":
        flags.append("located_case_insensitive")
    if len(sids) > MAX_IDS:
        flags.append(f"spans_{len(sids)}_sentences_over_{MAX_IDS}_id_ceiling")
    if any(b != a + 1 for a, b in zip(sids, sids[1:])):
        flags.append("non_adjacent_sids")
    if any(not s["cite_ok"] for s in overlapping):
        flags.append("redaction_touched_not_citable")
    roles = sorted({s["role"] for s in overlapping})
    if any(r not in sidmod.CLAIMABLE_ROLES for r in roles):
        flags.append("unclaimable_role")
    if len(roles) > 1:
        flags.append("spans_multiple_roles")
    if any(s["opaque_block"] for s in overlapping):
        flags.append("opaque_block")

    return {
        "sids": sids,
        "flags": flags,
        "match": hit["match"],
        "roles": roles,
        "hint_chars": len(hint),
        "located_prefix_chars": prefix_len,
        "covered_chars": sum(s["end"] - s["start"] for s in overlapping),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Re-annotate gold evidence as sentence IDs.")
    ap.add_argument("--gold-dir", required=True, type=Path)
    ap.add_argument("--units-dir", required=True, type=Path)
    ap.add_argument("--out-dir", type=Path, default=None,
                    help="default: <gold-dir>_sid, e.g. gold/ -> gold_sid/")
    ap.add_argument("--max-sentences", type=int, default=sidmod.DEFAULT_MAX_SENTENCES,
                    help="must match the value run_bench.py --render sid used")
    ap.add_argument("--prefix-fallback", action="store_true",
                    help="when a hint is not verbatim (labeler paraphrase, or a hint "
                         f"truncated mid-word), map its longest located prefix if that "
                         f"prefix is >= {MIN_PREFIX_CHARS} chars, flagged "
                         "'mapped_from_hint_prefix'. OFF by default: the strict pass "
                         "reports what genuinely maps, and the report always says how "
                         "many misses this flag WOULD rescue")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    out_dir = args.out_dir or args.gold_dir.parent / f"{args.gold_dir.name}_sid"

    units = {u["id"]: u["text"] for u in load_units(args.units_dir)}
    if not units:
        print(f"FATAL: no units in {args.units_dir}", file=sys.stderr)
        return 2

    gold_files = sorted(args.gold_dir.glob("*.gold.json"))
    if not gold_files:
        print(f"FATAL: no gold files in {args.gold_dir}", file=sys.stderr)
        return 2

    out_dir.mkdir(parents=True, exist_ok=True)

    stats = {
        "gold_files": 0,
        "units_missing_text": 0,
        "negative_units": 0,
        "gold_items": 0,
        "mapped": 0,
        "mapped_with_caveats": 0,
        "unmapped": 0,
        # Diagnostic, reported whether or not --prefix-fallback is on: of the
        # unmapped hints, how many have a >= MIN_PREFIX_CHARS verbatim head
        # (a truncated/paraphrased-tail hint) rather than no transcript
        # grounding at all.
        "unmapped_prefix_rescuable": 0,
    }
    flag_counts: dict[str, int] = {}
    flagged_items: list[dict[str, Any]] = []

    for path in gold_files:
        try:
            gold = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"  ! unreadable gold {path.name}: {exc}", file=sys.stderr)
            continue
        stats["gold_files"] += 1

        # Gold ids come from the filename when the file does not declare one
        # (some early gold files omit unit_id).
        uid = gold.get("unit_id")
        if not uid:
            stem = path.name[: -len(".gold.json")]
            uid = stem[len("unit_"):] if stem.startswith("unit_") else stem
        text = units.get(uid)
        if text is None:
            stats["units_missing_text"] += 1
            print(f"  ! no unit text for '{uid}' ({path.name}), skipped", file=sys.stderr)
            continue

        table = sidmod.enumerate_unit(text, max_sentences=args.max_sentences)
        norm = build_norm(text)

        items = gold.get("gold_proposals") or []
        if not items:
            stats["negative_units"] += 1

        for i, item in enumerate(items):
            stats["gold_items"] += 1
            hint = item.get("evidence_hint")
            if not isinstance(hint, str) or not hint.strip():
                item["evidence_sids"] = None
                item["evidence_sid_flags"] = ["no_evidence_hint"]
                stats["unmapped"] += 1
                flag_counts["no_evidence_hint"] = flag_counts.get("no_evidence_hint", 0) + 1
                flagged_items.append({
                    "unit_id": uid, "index": i, "reason": "no_evidence_hint",
                    "statement": item.get("statement"),
                })
                continue

            got = map_hint(hint, text, table, norm, args.prefix_fallback)
            item["evidence_sids"] = (
                [f"S{n}" for n in got["sids"]] if got["sids"] else None
            )
            item["evidence_sid_flags"] = got["flags"]
            item["evidence_sid_match"] = got["match"]

            for f in got["flags"]:
                flag_counts[f] = flag_counts.get(f, 0) + 1

            if got["sids"] is None:
                stats["unmapped"] += 1
                if got.get("prefix_rescuable"):
                    stats["unmapped_prefix_rescuable"] += 1
                flagged_items.append({
                    "unit_id": uid, "index": i, "reason": got["flags"][0],
                    "statement": item.get("statement"), "hint": hint,
                    "located_prefix_chars": got.get("located_prefix_chars"),
                    "prefix_rescuable": got.get("prefix_rescuable"),
                })
            elif got["flags"]:
                stats["mapped_with_caveats"] += 1
                flagged_items.append({
                    "unit_id": uid, "index": i, "reason": ",".join(got["flags"]),
                    "statement": item.get("statement"), "hint": hint,
                    "sids": item["evidence_sids"],
                })
            else:
                stats["mapped"] += 1

        gold["_sid_regold"] = {
            "contract": "sid",
            "segmenter_harness_version": sidmod.SEGMENTER_HARNESS_VERSION,
            "max_sentences": args.max_sentences,
            "n_sentences": len(table["sentences"]),
            "source_gold": path.name,
            "note": ("evidence_sids are DERIVED from evidence_hint by deterministic "
                     "overlap against the sid.py table. null means the hint could not "
                     "be mapped; nothing here is invented. evidence_sid_flags list "
                     "every caveat a human should check."),
        }
        (out_dir / path.name).write_text(json.dumps(gold, indent=2), encoding="utf-8")

    report = {
        "gold_dir": str(args.gold_dir),
        "out_dir": str(out_dir),
        "units_dir": str(args.units_dir),
        "segmenter_harness_version": sidmod.SEGMENTER_HARNESS_VERSION,
        "max_sentences": args.max_sentences,
        "prefix_fallback": args.prefix_fallback,
        "min_prefix_chars": MIN_PREFIX_CHARS,
        "stats": stats,
        "flag_counts": flag_counts,
        "flagged_items": flagged_items,
    }
    (out_dir / "regold_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    if not args.quiet:
        print(f"re-golded {stats['gold_files']} gold files -> {out_dir}")
        print(f"  gold items: {stats['gold_items']}")
        print(f"    mapped cleanly       : {stats['mapped']}")
        print(f"    mapped with caveats  : {stats['mapped_with_caveats']}")
        print(f"    UNMAPPED (flagged)   : {stats['unmapped']}"
              + (f"  (of which {stats['unmapped_prefix_rescuable']} have a "
                 f">={MIN_PREFIX_CHARS}-char verbatim head: rerun with "
                 "--prefix-fallback to map those, flagged)"
                 if stats["unmapped_prefix_rescuable"] else ""))
        print(f"  gold-negative units: {stats['negative_units']}, "
              f"units with no text: {stats['units_missing_text']}")
        if flag_counts:
            print("  flags:")
            for k, v in sorted(flag_counts.items(), key=lambda kv: -kv[1]):
                print(f"    {v:4d}  {k}")
        print(f"  full detail (incl. every flagged item): {out_dir / 'regold_report.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
