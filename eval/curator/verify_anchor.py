"""Deterministic verification gauntlet for the ANCHOR contract.

Sibling of verify.py. Same three gates, one changed premise: the model no
longer ships the evidence, it ships a *pointer* to the evidence. The model
emits `anchor` -- the first few words of the supporting sentence -- and this
verifier plays the role the product plays: it locates the anchor in the
transcript and expands the span itself. The expanded span, not the model's
string, is the evidence a memory is grounded on.

Why the contract change is legitimate: the product already resolves evidence
server-side (it holds the transcript). Asking a 2B model to transcribe 40
words verbatim tests handwriting, not judgement. Asking for 6 words tests
whether it can point.

Gates
  G1a locate      `anchor` must be 4-12 words (the schema asks for 5-8; the
                  band is the tolerance) and must occur in the unit text.
                  Checked raw first, then whitespace-normalized, then
                  case-insensitively -- we record which, because the ladder
                  is the same quality signal verify.py's G1 records.
                  An anchor outside the word band is `not_an_anchor`: the
                  model answered a different question (it quoted), so it
                  fails the contract even if the text is genuinely present.
  G1b expand      From the located anchor, the span runs to the first of:
                  next newline, next sentence terminator after the anchor,
                  or anchor_start + 300 chars. That span is THE SYSTEM'S
                  EVIDENCE from here on.
  G2  containment identical to verify.py, but the haystack is the expanded
                  span, with the whole unit as a fallback that is recorded
                  (`unit_only`) rather than rejected. A token in neither is
                  an invention and rejects the proposal.
  G3  polarity    identical to verify.py, run against the expanded span.

Verdicts: pass | reject(G1) | reject(G2) | flag(G3), precedence G1 > G2 > G3
-- the same ladder verify.py uses, so the two contracts are comparable.

HOW score.py SEES THIS
  score.py does not read verify.json; it imports `verify_unit` from verify.py
  and re-derives verdicts from `parsed.proposals[].grounding_quote`. So for
  the anchor runs to score at all, the *resolved* evidence has to exist in
  the result rows. This verifier therefore writes it back (disable with
  --no-inject):

    located, valid band -> grounding_quote = the expanded span. It is a
                           literal substring of the unit, so verify.py reports
                           g1.match = "exact" and rejects nothing. Honest: the
                           system really did produce verbatim evidence.
    located case-insensitively only
                        -> grounding_quote = the raw anchor, so verify.py
                           reports g1.match = "case_insensitive" and rejects
                           it, exactly as the quote contract rejects a
                           case-drifted quote. Same strictness, both contracts.
    not located         -> grounding_quote = the raw anchor -> "none" -> reject.
    not_an_anchor /
    missing anchor      -> grounding_quote = a sentinel that cannot occur in
                           any transcript -> "none" -> reject. A sentinel is
                           required here because a too-long "anchor" may well
                           be verbatim, and verify.py would pass it; the
                           anchor contract must not get credit for a quote.

  The model's raw output is never destroyed: `content` keeps the verbatim
  response body and `parsed.proposals[].anchor` keeps the model's string.
  Injected rows are stamped `_anchor_resolution` so nobody mistakes an
  anchor run for a quote run.

Usage:
    python eval/curator/verify_anchor.py \
        --results-dir eval/curator/results/qwen3.5-2b-anchor \
        --units-dir eval/curator/units

Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from run_bench import load_units  # noqa: E402  (shared unit loader)
from verify import content_tokens, normalize_ws, polarity_flag, _fold  # noqa: E402

# Contract band. The schema asks for 5-8 words; 4-12 is the tolerance we
# accept as "this is a pointer, not a transcription". Pre-registered.
MIN_ANCHOR_WORDS = 4
MAX_ANCHOR_WORDS = 12

# Hard ceiling on a resolved span, measured from the anchor's first char.
MAX_SPAN_CHARS = 300

# Cannot occur in a transcript, so verify.py's G1 always reports "none".
SENTINEL = "␟<anchor-unresolved:{reason}>"

_TERMINATOR = re.compile(r"[.!?]")


# --------------------------------------------------------------------------
# G1a: locate
# --------------------------------------------------------------------------

def build_norm(text: str) -> tuple[str, list[int]]:
    """Whitespace-normalize `text` and keep a map back to original offsets.

    The output is character-for-character what normalize_ws() produces, so a
    hit in the normalized string is a real hit; `idx[i]` is the offset in
    `text` of normalized character `i`, which is what lets us expand the span
    in the ORIGINAL text rather than in a reflowed copy.
    """
    out: list[str] = []
    idx: list[int] = []
    prev_space = True  # seeded True so leading whitespace is dropped
    for i, ch in enumerate(text):
        if ch.isspace():
            if prev_space:
                continue
            out.append(" ")
            idx.append(i)
            prev_space = True
        else:
            out.append(ch)
            idx.append(i)
            prev_space = False
    while out and out[-1] == " ":
        out.pop()
        idx.pop()
    return "".join(out), idx


def locate(anchor: str, text: str, norm: tuple[str, list[int]]) -> dict[str, Any] | None:
    """Find `anchor` in `text`. Returns {start, end, match} or None.

    Ladder mirrors verify.py's G1: exact -> normalized -> case_insensitive.
    Offsets are always into the ORIGINAL text.
    """
    a = anchor.strip()
    if not a:
        return None

    pos = text.find(a)
    if pos != -1:
        return {"start": pos, "end": pos + len(a), "match": "exact"}

    ntext, idx = norm
    na = normalize_ws(a)
    if not na:
        return None

    pos = ntext.find(na)
    kind = "normalized"
    if pos == -1:
        low_t, low_a = ntext.lower(), na.lower()
        # str.lower() is length-preserving for everything we expect; bail out
        # rather than corrupt the offset map if some codepoint disagrees.
        if len(low_t) == len(ntext) and len(low_a) == len(na):
            pos = low_t.find(low_a)
            kind = "case_insensitive"
    if pos == -1:
        return None

    return {"start": idx[pos], "end": idx[pos + len(na) - 1] + 1, "match": kind}


# --------------------------------------------------------------------------
# G1b: server-side span expansion
# --------------------------------------------------------------------------

def expand_span(text: str, a_start: int, a_end: int) -> dict[str, Any]:
    """Expand the anchor to the end of its line/sentence.

    end = min(next newline, next sentence terminator after the anchor,
              a_start + MAX_SPAN_CHARS), never before the anchor ends.
    """
    n = len(text)
    hard = min(n, a_start + MAX_SPAN_CHARS)

    nl = text.find("\n", a_end)
    if nl == -1:
        nl = n

    term = n
    for m in _TERMINATOR.finditer(text, a_end):
        i = m.start()
        nxt = text[i + 1] if i + 1 < n else " "
        # A terminator only ends a sentence if what follows is whitespace or a
        # closing mark; this keeps "v2.1", "e.g" and "..." from cutting early.
        if nxt.isspace() or nxt in "\"')]}":
            term = i + 1
            break

    end = min(nl, term, hard)
    end = max(end, a_end)
    end = min(end, n)

    if end == nl:
        why = "newline"
    elif end == term:
        why = "sentence"
    elif end == hard:
        why = "char_cap"
    else:
        why = "anchor_end"

    return {"span": text[a_start:end].strip(), "end": end, "end_by": why}


# --------------------------------------------------------------------------
# gauntlet
# --------------------------------------------------------------------------

def verify_proposal(
    proposal: dict,
    unit_text: str,
    norm: tuple[str, list[int]],
    band: tuple[int, int] = (MIN_ANCHOR_WORDS, MAX_ANCHOR_WORDS),
) -> dict[str, Any]:
    anchor = proposal.get("anchor")
    statement = proposal.get("statement")

    out: dict[str, Any] = {
        "statement": statement,
        "anchor": anchor,
        "grounding_quote": None,       # filled with the RESOLVED span
        "type": proposal.get("type"),
        "source_role": proposal.get("source_role"),
    }

    if not isinstance(statement, str) or not statement.strip():
        out.update(verdict="reject(G1)",
                   g1={"match": "none", "reason": "missing_statement"},
                   resolved=SENTINEL.format(reason="missing_statement"))
        return out
    if not isinstance(anchor, str) or not anchor.strip():
        out.update(verdict="reject(G1)",
                   g1={"match": "none", "reason": "missing_anchor"},
                   resolved=SENTINEL.format(reason="missing_anchor"))
        return out

    words = len(normalize_ws(anchor).split())
    hit = locate(anchor, unit_text, norm)
    lo, hi = band

    g1: dict[str, Any] = {
        "anchor_chars": len(anchor),
        "anchor_words": words,
        "located": bool(hit),
        "located_match": hit["match"] if hit else "none",
    }

    # --- G1a: contract band --------------------------------------------
    if words < lo or words > hi:
        g1["match"] = "not_an_anchor"
        g1["reason"] = "too_short" if words < lo else "too_long"
        # Diagnostic only: a quote that IS present but breaks the contract.
        g1["would_have_located"] = bool(hit) and hit["match"] in ("exact", "normalized")
        out["g1"] = g1
        out["verdict"] = "reject(G1)"
        out["resolved"] = SENTINEL.format(reason=g1["reason"])
        out["g2"] = None
        out["g3"] = None
        return out

    if hit is None:
        g1["match"] = "none"
        g1["reason"] = "anchor_not_found"
        out["g1"] = g1
        out["verdict"] = "reject(G1)"
        out["resolved"] = anchor          # verify.py -> "none" -> reject
        out["g2"] = None
        out["g3"] = None
        return out

    g1["match"] = hit["match"]

    # --- G1b: expand ----------------------------------------------------
    exp = expand_span(unit_text, hit["start"], hit["end"])
    span = exp["span"]
    g1["span_chars"] = len(span)
    g1["span_end_by"] = exp["end_by"]
    g1["quote_chars"] = len(span)          # verify.py-compatible field name
    out["g1"] = g1
    out["grounding_quote"] = span

    # Case drift is not verbatim. The quote contract rejects it at G1; so
    # does this one, so the two runs are strictness-matched.
    if hit["match"] == "case_insensitive":
        out["verdict"] = "reject(G1)"
        out["resolved"] = anchor           # verify.py -> "case_insensitive"
        out["g2"] = None
        out["g3"] = None
        return out

    out["resolved"] = span                 # verify.py -> "exact" -> passes G1

    # --- G2: containment against the EXPANDED SPAN ----------------------
    tokens = content_tokens(statement)
    fold_span, fold_unit = _fold(span), _fold(unit_text)
    in_quote, unit_only, missing = [], [], []
    for t in tokens:
        low = t["token"].lower()
        if low in fold_span:
            in_quote.append(t["token"])
        elif low in fold_unit:
            unit_only.append(t["token"])
        else:
            missing.append(t["token"])

    out["g2"] = {
        "checked": [t["token"] for t in tokens],
        "in_quote": in_quote,
        "unit_only": unit_only,
        "missing": missing,
        "fell_back_to_unit": bool(unit_only),
    }

    # --- G3: polarity, against the expanded span ------------------------
    out["g3"] = polarity_flag(statement, span)

    if missing:
        out["verdict"] = "reject(G2)"
    elif out["g3"]:
        out["verdict"] = "flag(G3)"
    else:
        out["verdict"] = "pass"
    return out


def verify_unit(
    row: dict,
    unit_text: str,
    band: tuple[int, int] = (MIN_ANCHOR_WORDS, MAX_ANCHOR_WORDS),
) -> dict[str, Any]:
    parsed = row.get("parsed") or {}
    proposals = parsed.get("proposals") if isinstance(parsed, dict) else None
    if not isinstance(proposals, list):
        proposals = []

    norm = build_norm(unit_text)
    checked = []
    for p in proposals:
        if isinstance(p, dict):
            checked.append(verify_proposal(p, unit_text, norm, band))
        else:
            checked.append({
                "verdict": "reject(G1)",
                "g1": {"match": "none", "reason": "not_an_object"},
                "resolved": SENTINEL.format(reason="not_an_object"),
            })

    return {
        "unit_id": row.get("unit_id"),
        "status": row.get("status"),
        "parse_status": row.get("parse_status"),
        "nothing_durable": row.get("nothing_durable"),
        "incoherent_abstention": row.get("incoherent_abstention", False),
        "wall_seconds": row.get("wall_seconds"),
        "n_proposals": len(checked),
        "proposals": checked,
        "counts": {
            "pass": sum(1 for c in checked if c["verdict"] == "pass"),
            "flag_g3": sum(1 for c in checked if c["verdict"] == "flag(G3)"),
            "reject_g1": sum(1 for c in checked if c["verdict"] == "reject(G1)"),
            "reject_g2": sum(1 for c in checked if c["verdict"] == "reject(G2)"),
        },
    }


# --------------------------------------------------------------------------
# write-back so score.py (which re-verifies via verify.py) works unchanged
# --------------------------------------------------------------------------

def inject(row_path: Path, row: dict, checked: dict) -> None:
    parsed = row.get("parsed") or {}
    proposals = parsed.get("proposals") if isinstance(parsed, dict) else None
    if not isinstance(proposals, list):
        return
    notes = []
    for p, c in zip(proposals, checked["proposals"]):
        if not isinstance(p, dict):
            continue
        p["grounding_quote"] = c.get("resolved")
        notes.append({
            "anchor": p.get("anchor"),
            "match": (c.get("g1") or {}).get("match"),
            "words": (c.get("g1") or {}).get("anchor_words"),
            "span_end_by": (c.get("g1") or {}).get("span_end_by"),
            "verdict": c.get("verdict"),
        })
    row["_anchor_resolution"] = {
        "contract": "anchor",
        "note": ("grounding_quote is NOT model output. It is the span this "
                 "system resolved from the model's `anchor`, or a sentinel "
                 "when the anchor could not be resolved. Raw model output is "
                 "in `content` and in each proposal's `anchor`."),
        "proposals": notes,
    }
    row_path.write_text(json.dumps(row, indent=2), encoding="utf-8")


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Verify anchor-contract curator proposals.")
    ap.add_argument("--results-dir", required=True, type=Path, help="results/<model>-anchor/")
    ap.add_argument("--units-dir", required=True, type=Path)
    ap.add_argument("--out", type=Path, default=None,
                    help="default: <results-dir>/verify_anchor.json")
    ap.add_argument("--min-anchor-words", type=int, default=MIN_ANCHOR_WORDS,
                    help=f"contract band lower bound (pre-registered: {MIN_ANCHOR_WORDS}); "
                         "change only for a labelled sensitivity run")
    ap.add_argument("--max-anchor-words", type=int, default=MAX_ANCHOR_WORDS,
                    help=f"contract band upper bound (pre-registered: {MAX_ANCHOR_WORDS}); "
                         "change only for a labelled sensitivity run")
    ap.add_argument("--no-inject", action="store_true",
                    help="do not write resolved grounding_quote back into the result rows "
                         "(score.py will then reject everything)")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    band = (args.min_anchor_words, args.max_anchor_words)

    units = {u["id"]: u["text"] for u in load_units(args.units_dir)}
    if not units:
        print(f"FATAL: no units in {args.units_dir}", file=sys.stderr)
        return 2

    units_out = args.results_dir / "units"
    if not units_out.is_dir():
        print(f"FATAL: no results in {units_out}", file=sys.stderr)
        return 2

    verified: list[dict[str, Any]] = []
    anchor_stats: dict[str, int] = {
        "exact": 0, "normalized": 0, "case_insensitive": 0,
        "not_found": 0, "not_an_anchor_too_long": 0, "not_an_anchor_too_short": 0,
        "missing_anchor": 0, "missing_statement": 0, "not_an_object": 0,
        "not_an_anchor_but_verbatim": 0, "g2_fell_back_to_unit": 0,
    }
    word_counts: list[int] = []
    span_chars: list[int] = []
    end_by: dict[str, int] = {}

    for path in sorted(units_out.glob("unit_*.json")):
        try:
            row = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"  ! unreadable result {path.name}: {exc}", file=sys.stderr)
            continue
        uid = row.get("unit_id")
        text = units.get(uid)
        if text is None:
            print(f"  ! no unit text for '{uid}', skipped", file=sys.stderr)
            continue

        checked = verify_unit(row, text, band)
        verified.append(checked)

        for c in checked["proposals"]:
            g1 = c.get("g1") or {}
            m, reason = g1.get("match"), g1.get("reason")
            if m == "not_an_anchor":
                key = f"not_an_anchor_{reason}"
                anchor_stats[key] = anchor_stats.get(key, 0) + 1
                if g1.get("would_have_located"):
                    anchor_stats["not_an_anchor_but_verbatim"] += 1
            elif m in ("exact", "normalized", "case_insensitive"):
                anchor_stats[m] += 1
            elif reason in ("missing_anchor", "missing_statement", "not_an_object"):
                anchor_stats[reason] += 1
            else:
                anchor_stats["not_found"] += 1
            if isinstance(g1.get("anchor_words"), int):
                word_counts.append(g1["anchor_words"])
            if isinstance(g1.get("span_chars"), int):
                span_chars.append(g1["span_chars"])
            if g1.get("span_end_by"):
                end_by[g1["span_end_by"]] = end_by.get(g1["span_end_by"], 0) + 1
            if (c.get("g2") or {}).get("fell_back_to_unit"):
                anchor_stats["g2_fell_back_to_unit"] += 1

        if not args.no_inject:
            inject(path, row, checked)

    totals = {"pass": 0, "flag_g3": 0, "reject_g1": 0, "reject_g2": 0}
    for v in verified:
        for k in totals:
            totals[k] += v["counts"][k]
    n_props = sum(totals.values())

    located = anchor_stats["exact"] + anchor_stats["normalized"] + anchor_stats["case_insensitive"]

    def mean(xs: list[int]) -> float | None:
        return round(sum(xs) / len(xs), 2) if xs else None

    report = {
        "results_dir": str(args.results_dir),
        "contract": "anchor",
        "anchor_band_words": list(band),
        "anchor_band_is_preregistered": band == (MIN_ANCHOR_WORDS, MAX_ANCHOR_WORDS),
        "max_span_chars": MAX_SPAN_CHARS,
        "n_units": len(verified),
        "n_proposals": n_props,
        "totals": totals,
        "rates": {
            "pass_rate": round(totals["pass"] / n_props, 4) if n_props else 0.0,
            "g1_reject_rate": round(totals["reject_g1"] / n_props, 4) if n_props else 0.0,
            "g2_reject_rate": round(totals["reject_g2"] / n_props, 4) if n_props else 0.0,
            "g3_flag_rate": round(totals["flag_g3"] / n_props, 4) if n_props else 0.0,
            "anchor_located_rate": round(located / n_props, 4) if n_props else 0.0,
            "anchor_located_verbatim_rate": (
                round((anchor_stats["exact"] + anchor_stats["normalized"]) / n_props, 4)
                if n_props else 0.0
            ),
        },
        "anchor_stats": anchor_stats,
        "anchor_words_mean": mean(word_counts),
        "span_chars_mean": mean(span_chars),
        "span_end_by": end_by,
        "injected_into_results": not args.no_inject,
        "units": verified,
    }

    dest = args.out or (args.results_dir / "verify_anchor.json")
    dest.write_text(json.dumps(report, indent=2), encoding="utf-8")
    if not args.quiet:
        print(f"verified {len(verified)} units / {n_props} proposals -> {dest}")
        print(f"  pass={totals['pass']} flag(G3)={totals['flag_g3']} "
              f"reject(G1)={totals['reject_g1']} reject(G2)={totals['reject_g2']}")
        print(f"  anchors: exact={anchor_stats['exact']} "
              f"normalized={anchor_stats['normalized']} "
              f"case_insensitive={anchor_stats['case_insensitive']} "
              f"not_found={anchor_stats['not_found']} "
              f"too_long={anchor_stats['not_an_anchor_too_long']} "
              f"too_short={anchor_stats['not_an_anchor_too_short']}")
        if not args.no_inject:
            print("  resolved spans written back into units/*.json for score.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
