"""Deterministic verification gauntlet for curator proposals.

This is the harness mirror of the product-side gates. It is intentionally
dumb, fast and model-free: every verdict here must be reproducible from the
proposal plus the unit text alone, with no LLM in the loop. If a gate cannot
be decided by string math, it does not belong here.

Gates
  G1  grounding    grounding_quote must be a verbatim substring of the unit
                   text. Checked exact first, then after whitespace
                   normalization; we record which one matched, because
                   "needed normalization" is a real quality signal (models
                   that reflow whitespace are one step from paraphrasing).
  G2  containment  every content token in `statement` -- numbers, versions,
                   identifiers, capitalized names -- must appear in the
                   grounding_quote, or failing that somewhere in the unit.
                   Tokens found only in the unit are recorded separately:
                   they are legal but weakly grounded. A token in neither is
                   an invention and rejects the proposal.
  G3  polarity     a statement that asserts a settled preference/decision
                   ("prefers", "always", "decided") on top of a quote that
                   hedges ("might", "maybe", "considering") is flagged, not
                   rejected -- it is a judgement call a human should make.

Verdicts: pass | reject(G1) | reject(G2) | flag(G3), precedence G1 > G2 > G3.

Usage:
    python eval/curator/verify.py --results-dir eval/curator/results/qwen3-1.7b \
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


# --------------------------------------------------------------------------
# G2 token extraction
# --------------------------------------------------------------------------

# Capitalized words that start a sentence, or are simply common English, are
# not evidence of a specific entity. Without this list every "The", "We" and
# "Yeah" would demand grounding and G2 would reject almost everything.
CAP_STOPWORDS = {
    "a", "all", "also", "always", "an", "and", "any", "are", "as", "at", "be",
    "because", "before", "both", "but", "by", "can", "could", "did", "do",
    "does", "for", "from", "get", "had", "has", "have", "he", "her", "his",
    "how", "i", "if", "in", "is", "it", "its", "let", "make", "may", "me",
    "might", "must", "my", "never", "no", "not", "of", "ok", "okay", "on",
    "one", "only", "or", "our", "out", "over", "prefer", "prefers", "she",
    "should", "since", "so", "some", "sure", "than", "that", "the", "their",
    "them", "then", "there", "these", "they", "this", "those", "to", "up",
    "use", "uses", "want", "wants", "was", "we", "were", "what", "when",
    "where", "which", "while", "who", "why", "will", "with", "would", "yeah",
    "yes", "you", "your", "user", "assistant",
}

# Bare cardinals that are almost never the load-bearing detail of a memory.
TRIVIAL_NUMBERS = {"0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"}

_WORD_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/+#-]*")
_HAS_DIGIT = re.compile(r"\d")
_CAMEL = re.compile(r"[a-z][A-Z]")
_SENTENCE_END = re.compile(r"[.!?:;]\s*$")


def normalize_ws(text: str) -> str:
    """Collapse all whitespace runs to a single space and strip."""
    return re.sub(r"\s+", " ", text).strip()


def _fold(text: str) -> str:
    """Case-fold + whitespace-normalize for lenient containment checks."""
    return normalize_ws(text).lower()


def content_tokens(statement: str) -> list[dict[str, str]]:
    """Extract the tokens in `statement` that must be grounded.

    Returns [{token, kind}] where kind is number | identifier | name.
    Deliberately conservative: a false *extra* token causes a spurious G2
    reject, which is worse for the benchmark than missing one, so anything
    ambiguous is dropped.
    """
    found: dict[str, str] = {}

    for m in _WORD_RE.finditer(statement):
        tok = m.group(0).rstrip(".,;:!?")
        if not tok or len(tok) < 2:
            continue

        low = tok.lower()
        kind: str | None = None

        if _HAS_DIGIT.search(tok):
            # Versions, ports, years, "PostgreSQL 16", "v2.1", "8765".
            if tok.strip(".") in TRIVIAL_NUMBERS:
                continue
            kind = "number"
        elif any(c in tok for c in "._/+#-") or _CAMEL.search(tok):
            # snake_case, dotted.paths, kebab-case, camelCase, C++, a/b.
            kind = "identifier"
        elif tok.isupper() and len(tok) >= 2:
            # Acronyms: API, CI, SQL.
            if low in CAP_STOPWORDS:
                continue
            kind = "name"
        elif tok[0].isupper():
            if low in CAP_STOPWORDS:
                continue
            # Sentence-initial capitals are grammar, not entities.
            prefix = statement[: m.start()]
            if not prefix.strip() or _SENTENCE_END.search(prefix):
                continue
            kind = "name"

        if kind:
            found.setdefault(tok, kind)

    return [{"token": t, "kind": k} for t, k in found.items()]


# --------------------------------------------------------------------------
# G3 polarity
# --------------------------------------------------------------------------

ASSERTIVE = (
    "prefers", "prefer ", "always", "never", "decided", "decision", "will ",
    "must ", "requires", "standardiz", "chose", "chosen", "committed",
    "mandat", "policy", "rule is", "going with",
)
HEDGES = (
    "might", "maybe", "perhaps", "considering", "thinking about", "probably",
    "possibly", "could ", "not sure", "unsure", "leaning", "we'll see",
    "may want", "toying with", "on the fence", "tempted", "wondering",
    "what if", "should we", "i guess", "kind of", "sort of",
)


def polarity_flag(statement: str, quote: str) -> dict[str, Any] | None:
    """Flag a settled-sounding statement built on a hedged quote."""
    s, q = statement.lower(), quote.lower()
    hits_a = [w for w in ASSERTIVE if w in s]
    if not hits_a:
        return None
    # If the quote is equally assertive there is nothing to complain about.
    if any(w in q for w in ASSERTIVE):
        return None
    hits_h = [w for w in HEDGES if w in q]
    if not hits_h:
        return None
    return {"assertive_in_statement": hits_a, "hedges_in_quote": hits_h}


# --------------------------------------------------------------------------
# gauntlet
# --------------------------------------------------------------------------

def verify_proposal(proposal: dict, unit_text: str) -> dict[str, Any]:
    quote = proposal.get("grounding_quote")
    statement = proposal.get("statement")

    out: dict[str, Any] = {
        "statement": statement,
        "grounding_quote": quote,
        "type": proposal.get("type"),
        "source_role": proposal.get("source_role"),
    }

    if not isinstance(statement, str) or not statement.strip():
        out.update(verdict="reject(G1)", g1={"match": "none", "reason": "missing_statement"})
        return out
    if not isinstance(quote, str) or not quote.strip():
        out.update(verdict="reject(G1)", g1={"match": "none", "reason": "missing_quote"})
        return out

    # --- G1 -------------------------------------------------------------
    if quote in unit_text:
        g1_match = "exact"
    elif normalize_ws(quote) in normalize_ws(unit_text):
        g1_match = "normalized"
    elif _fold(quote) in _fold(unit_text):
        # Same characters, different case. Still not verbatim -- the product
        # gate demands verbatim -- but worth distinguishing from a fabrication.
        g1_match = "case_insensitive"
    else:
        g1_match = "none"

    out["g1"] = {"match": g1_match, "quote_chars": len(quote)}
    g1_ok = g1_match in ("exact", "normalized")

    # --- G2 -------------------------------------------------------------
    tokens = content_tokens(statement)
    fold_quote, fold_unit = _fold(quote), _fold(unit_text)
    in_quote, unit_only, missing = [], [], []
    for t in tokens:
        low = t["token"].lower()
        if low in fold_quote:
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
    }
    g2_ok = not missing

    # --- G3 -------------------------------------------------------------
    pol = polarity_flag(statement, quote)
    out["g3"] = pol

    # --- verdict, by precedence -----------------------------------------
    if not g1_ok:
        out["verdict"] = "reject(G1)"
    elif not g2_ok:
        out["verdict"] = "reject(G2)"
    elif pol:
        out["verdict"] = "flag(G3)"
    else:
        out["verdict"] = "pass"
    return out


def verify_unit(row: dict, unit_text: str) -> dict[str, Any]:
    parsed = row.get("parsed") or {}
    proposals = parsed.get("proposals") if isinstance(parsed, dict) else None
    if not isinstance(proposals, list):
        proposals = []

    checked = [
        verify_proposal(p, unit_text) if isinstance(p, dict)
        else {"verdict": "reject(G1)", "g1": {"match": "none", "reason": "not_an_object"}}
        for p in proposals
    ]

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


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Verify curator proposals against unit text.")
    ap.add_argument("--results-dir", required=True, type=Path, help="results/<model>/")
    ap.add_argument("--units-dir", required=True, type=Path)
    ap.add_argument("--out", type=Path, default=None, help="default: <results-dir>/verify.json")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    units = {u["id"]: u["text"] for u in load_units(args.units_dir)}
    if not units:
        print(f"FATAL: no units in {args.units_dir}", file=sys.stderr)
        return 2

    units_out = args.results_dir / "units"
    if not units_out.is_dir():
        print(f"FATAL: no results in {units_out}", file=sys.stderr)
        return 2

    verified: list[dict[str, Any]] = []
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
        verified.append(verify_unit(row, text))

    totals = {"pass": 0, "flag_g3": 0, "reject_g1": 0, "reject_g2": 0}
    for v in verified:
        for k in totals:
            totals[k] += v["counts"][k]
    n_props = sum(totals.values())

    report = {
        "results_dir": str(args.results_dir),
        "n_units": len(verified),
        "n_proposals": n_props,
        "totals": totals,
        "rates": {
            "pass_rate": round(totals["pass"] / n_props, 4) if n_props else 0.0,
            "g1_reject_rate": round(totals["reject_g1"] / n_props, 4) if n_props else 0.0,
            "g2_reject_rate": round(totals["reject_g2"] / n_props, 4) if n_props else 0.0,
            "g3_flag_rate": round(totals["flag_g3"] / n_props, 4) if n_props else 0.0,
        },
        "units": verified,
    }

    dest = args.out or (args.results_dir / "verify.json")
    dest.write_text(json.dumps(report, indent=2), encoding="utf-8")
    if not args.quiet:
        print(f"verified {len(verified)} units / {n_props} proposals -> {dest}")
        print(f"  pass={totals['pass']} flag(G3)={totals['flag_g3']} "
              f"reject(G1)={totals['reject_g1']} reject(G2)={totals['reject_g2']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
