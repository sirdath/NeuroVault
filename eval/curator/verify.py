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

Flags (v2, additive -- they never change a verdict)
  role_mismatch    `source_role` claims "user" but the grounding quote sits
                   under an ASSISTANT marker, or vice versa. Attribution is
                   derived deterministically: locate the quote in the unit,
                   walk back to the nearest role-marker line, compare. A quote
                   whose home is a TOOL_RESULT (or that cannot be located at
                   all) is *ungradable*, not a mismatch -- the schema offers no
                   "tool" value, so there is no right answer to grade against.
  g2 span_pass /   whether G2 was satisfied by the grounding span alone
  g2 unit_fallback (span_pass) or only by falling back to the whole unit
                   (unit_fallback). Both survive the gate -- the distinction is
                   reported, not enforced -- because "the number appears
                   somewhere in 3,000 tokens" is much weaker evidence than "the
                   number appears in the quote the model chose".

Report schema version 2 adds those fields. Every v1 field is retained
unchanged, so an old consumer keeps working.

Usage:
    python eval/curator/verify.py --results-dir eval/curator/results/qwen3-1.7b \
        --units-dir eval/curator/units

Stdlib only.
"""

from __future__ import annotations

import argparse
import functools
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from run_bench import load_units  # noqa: E402  (shared unit loader)

VERIFY_SCHEMA_VERSION = 2


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
# source_role attribution  (v2)
# --------------------------------------------------------------------------

# The unit renderer (build_units.py) emits exactly four line shapes:
#   USER: ...
#   ASSISTANT: ...
#   ASSISTANT [tool:Bash] npm run tauri dev     <- still the assistant speaking
#   TOOL_RESULT: ...                            <- neither party spoke this
# SYSTEM is accepted defensively in case the renderer ever grows one.
_ROLE_MARKER_RE = re.compile(r"^(USER|ASSISTANT|TOOL_RESULT|SYSTEM)\b")

MARKER_ROLE = {
    "USER": "user",
    "ASSISTANT": "assistant",
    "TOOL_RESULT": "tool_result",
    "SYSTEM": "system",
}

# Roles the schema lets a model claim. Anything else is ungradable rather than
# wrong: punishing a model for a value it is forbidden to emit measures the
# schema, not the model.
GRADABLE_ROLES = ("user", "assistant")


@functools.lru_cache(maxsize=256)
def _role_spans(unit_text: str) -> tuple[tuple[int, str], ...]:
    """[(char offset of a role-marker line, role)] in document order."""
    spans: list[tuple[int, str]] = []
    offset = 0
    for line in unit_text.split("\n"):
        m = _ROLE_MARKER_RE.match(line)
        if m:
            spans.append((offset, MARKER_ROLE[m.group(1)]))
        offset += len(line) + 1
    return tuple(spans)


@functools.lru_cache(maxsize=256)
def _norm_index(unit_text: str) -> tuple[str, tuple[int, ...]]:
    """Whitespace-collapsed text plus a map back to original offsets."""
    chars: list[str] = []
    idx: list[int] = []
    prev_space = False
    for i, ch in enumerate(unit_text):
        if ch.isspace():
            if prev_space:
                continue
            chars.append(" ")
            idx.append(i)
            prev_space = True
        else:
            chars.append(ch)
            idx.append(i)
            prev_space = False
    return "".join(chars), tuple(idx)


def locate_quote(unit_text: str, quote: str) -> tuple[int | None, str]:
    """Character offset of `quote` inside `unit_text`, and how it was found.

    Mirrors G1's ladder (exact -> whitespace-normalized -> case-folded) so a
    quote G1 accepts is always locatable, and a quote G1 only *nearly* accepts
    can still be attributed for the role check.
    """
    if not isinstance(quote, str) or not quote.strip():
        return None, "none"
    pos = unit_text.find(quote)
    if pos >= 0:
        return pos, "exact"

    norm_text, idx = _norm_index(unit_text)
    norm_quote = normalize_ws(quote)
    pos = norm_text.find(norm_quote)
    if pos >= 0:
        return idx[pos], "normalized"
    pos = norm_text.lower().find(norm_quote.lower())
    if pos >= 0:
        return idx[pos], "case_insensitive"
    return None, "none"


def derive_source_role(unit_text: str, quote: str) -> dict[str, Any]:
    """Who actually said `quote`, per the transcript's own role markers.

    Deterministic and model-free: find the quote, walk back to the nearest
    preceding role-marker line, read the role off it.
    """
    pos, how = locate_quote(unit_text, quote)
    if pos is None:
        return {"derived_role": None, "located": how, "offset": None}
    role = None
    for start, r in _role_spans(unit_text):
        if start <= pos:
            role = r
        else:
            break
    return {"derived_role": role, "located": how, "offset": pos}


def role_check(claimed: Any, unit_text: str, quote: str) -> dict[str, Any]:
    """Compare the claimed `source_role` against the derived one.

    `gradable` is False when the quote cannot be located, when it lives in a
    TOOL_RESULT block (no schema value can be right), or when the model claimed
    nothing. `mismatch` is only ever True for a gradable comparison, and it is
    a FLAG: it never changes a verdict.
    """
    derived = derive_source_role(unit_text, quote)
    role = derived["derived_role"]
    claimed_norm = claimed.strip().lower() if isinstance(claimed, str) else None

    gradable = role in GRADABLE_ROLES and claimed_norm in GRADABLE_ROLES
    out = {
        "claimed": claimed_norm,
        "derived": role,
        "located": derived["located"],
        "offset": derived["offset"],
        "gradable": gradable,
        "mismatch": bool(gradable and claimed_norm != role),
    }
    if not gradable:
        out["ungradable_reason"] = (
            "unlocatable_quote" if role is None
            else "non_speaker_source" if role not in GRADABLE_ROLES
            else "no_claimed_role"
        )
    return out


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

    # A malformed proposal is ungradable for role too -- keep the key present
    # so every checked proposal has the same shape.
    role_stub = {
        "claimed": None, "derived": None, "located": "none", "offset": None,
        "gradable": False, "mismatch": False, "ungradable_reason": "malformed_proposal",
    }
    if not isinstance(statement, str) or not statement.strip():
        out.update(verdict="reject(G1)", g1={"match": "none", "reason": "missing_statement"},
                   role=role_stub, role_mismatch=False)
        return out
    if not isinstance(quote, str) or not quote.strip():
        out.update(verdict="reject(G1)", g1={"match": "none", "reason": "missing_quote"},
                   role=role_stub, role_mismatch=False)
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

    g2_ok = not missing
    out["g2"] = {
        "checked": [t["token"] for t in tokens],
        "in_quote": in_quote,
        "unit_only": unit_only,
        "missing": missing,
        # v2: how G2 was satisfied, so the scorer can separate real span
        # grounding from the lenient whole-unit fallback. Gated on g1_ok as
        # well: token containment against a FABRICATED quote says nothing, so
        # G1 rejects must not vote here. Exactly one of the three is true for
        # a proposal that survives the gauntlet, and none for one that does
        # not -- so the three counts partition the survivors.
        "n_tokens": len(tokens),
        "vacuous": g1_ok and g2_ok and not tokens,
        "span_pass": g1_ok and g2_ok and bool(tokens) and not unit_only,
        "unit_fallback": g1_ok and g2_ok and bool(unit_only),
    }

    # --- G3 -------------------------------------------------------------
    pol = polarity_flag(statement, quote)
    out["g3"] = pol

    # --- role attribution (flag only, never a verdict) -------------------
    out["role"] = role_check(proposal.get("source_role"), unit_text, quote)
    out["role_mismatch"] = out["role"]["mismatch"]

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
        else {"verdict": "reject(G1)", "g1": {"match": "none", "reason": "not_an_object"},
              "role": {"gradable": False, "mismatch": False,
                       "ungradable_reason": "not_an_object"},
              "role_mismatch": False}
        for p in proposals
    ]

    def _g2(c: dict, key: str) -> bool:
        return bool((c.get("g2") or {}).get(key))

    return {
        "unit_id": row.get("unit_id"),
        "status": row.get("status"),
        "parse_status": row.get("parse_status"),
        "nothing_durable": row.get("nothing_durable"),
        "incoherent_abstention": row.get("incoherent_abstention", False),
        "wall_seconds": row.get("wall_seconds"),
        "n_proposals": len(checked),
        "proposals": checked,
        # v1 keys: the four verdicts, and only those. Anything summing
        # counts.values() to get "how many proposals" keeps working.
        "counts": {
            "pass": sum(1 for c in checked if c["verdict"] == "pass"),
            "flag_g3": sum(1 for c in checked if c["verdict"] == "flag(G3)"),
            "reject_g1": sum(1 for c in checked if c["verdict"] == "reject(G1)"),
            "reject_g2": sum(1 for c in checked if c["verdict"] == "reject(G2)"),
        },
        # v2 keys: flags, kept in their own dict for exactly that reason.
        "flags": {
            "role_gradable": sum(1 for c in checked if (c.get("role") or {}).get("gradable")),
            "role_mismatch": sum(1 for c in checked if c.get("role_mismatch")),
            "g2_span_pass": sum(1 for c in checked if _g2(c, "span_pass")),
            "g2_unit_fallback": sum(1 for c in checked if _g2(c, "unit_fallback")),
            "g2_vacuous": sum(1 for c in checked if _g2(c, "vacuous")),
        },
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Verify curator proposals against unit text.")
    ap.add_argument("--results-dir", required=True, type=Path, help="results/<model>/")
    ap.add_argument("--units-dir", required=True, type=Path)
    ap.add_argument("--out", type=Path, default=None,
                    help="default: <results-dir>/verify.json. Pass "
                         "<results-dir>/verify_v2.json to keep a v1 report intact.")
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
    flags = {"role_gradable": 0, "role_mismatch": 0,
             "g2_span_pass": 0, "g2_unit_fallback": 0, "g2_vacuous": 0}
    for v in verified:
        for k in totals:
            totals[k] += v["counts"][k]
        for k in flags:
            flags[k] += v["flags"][k]
    n_props = sum(totals.values())
    g2_survived = flags["g2_span_pass"] + flags["g2_unit_fallback"] + flags["g2_vacuous"]

    def _rate(num: int, den: int) -> float:
        return round(num / den, 4) if den else 0.0

    report = {
        "schema_version": VERIFY_SCHEMA_VERSION,
        "results_dir": str(args.results_dir),
        "n_units": len(verified),
        "n_proposals": n_props,
        "totals": totals,
        "flags": flags,
        "rates": {
            "pass_rate": _rate(totals["pass"], n_props),
            "g1_reject_rate": _rate(totals["reject_g1"], n_props),
            "g2_reject_rate": _rate(totals["reject_g2"], n_props),
            "g3_flag_rate": _rate(totals["flag_g3"], n_props),
            # v2: role attribution + how G2 was actually satisfied.
            "role_mismatch_rate": _rate(flags["role_mismatch"], flags["role_gradable"]),
            "source_role_accuracy": _rate(
                flags["role_gradable"] - flags["role_mismatch"], flags["role_gradable"]),
            "g2_span_pass_rate": _rate(flags["g2_span_pass"], g2_survived),
            "g2_unit_fallback_rate": _rate(flags["g2_unit_fallback"], g2_survived),
            "g2_vacuous_rate": _rate(flags["g2_vacuous"], g2_survived),
        },
        "units": verified,
    }

    dest = args.out or (args.results_dir / "verify.json")
    dest.write_text(json.dumps(report, indent=2), encoding="utf-8")
    if not args.quiet:
        print(f"verified {len(verified)} units / {n_props} proposals -> {dest}")
        print(f"  pass={totals['pass']} flag(G3)={totals['flag_g3']} "
              f"reject(G1)={totals['reject_g1']} reject(G2)={totals['reject_g2']}")
        print(f"  role: gradable={flags['role_gradable']} "
              f"mismatch={flags['role_mismatch']} "
              f"(accuracy={report['rates']['source_role_accuracy']})")
        print(f"  G2 survivors: span={flags['g2_span_pass']} "
              f"unit_fallback={flags['g2_unit_fallback']} vacuous={flags['g2_vacuous']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
