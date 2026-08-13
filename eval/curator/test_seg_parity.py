"""Pin SEG_H1 on the shared `SEG_H1 ↔ SEG_V1` parity fixture.

The gold re-annotation under `gold_sid/` ran on the HARNESS segmenter
(`sid.py`, `SEGMENTER_HARNESS_VERSION = 1`). The product ships a different
implementation, the Rust `SEG_V1`. Until the shared fixture at
`src-tauri/tests/fixtures/curator/seg_parity/` existed, nothing pinned the two
together, and `MANIFEST-V1.md` carried that as a standing caveat: a SID-level
comparison across the two was unverified.

The fixture closes it from both ends. The Rust side pins `expected_seg_v1.json`
and `expected_render.txt` (`curator_seg_parity.rs`). This file is the Python
half the fixture's README asks for: it pins `expected_seg_h1.json` — the table
`sid.enumerate_unit()` produces over the SAME sanitized bytes, in the SAME
document — so neither segmenter can move without a golden changing.

WHAT A GREEN RUN HERE PROVES, AND WHAT IT DOES NOT
  Proves    SEG_H1 is frozen. Every sid, offset, role, `cite_ok`, and opaque
            flag on this document is what it was when the gold set was
            annotated, and every cited sentence still materializes to the same
            characters.
  Does NOT  that a `gold_sid` ID equals a product-run ID. It does not: the two
            tables genuinely disagree on this document (10 sentences vs 12),
            and the disagreements are the fixture's documented mapping rule,
            not a bug list. `the_documented_divergences_hold_from_the_python_side`
            asserts the half of that rule this side can see, so a change that
            quietly makes the two agree — or disagree differently — fails here
            as loudly as a regression would.

If the fixture is not on disk, every test SKIPS with a visible reason rather
than passing vacuously.

Usage:
    python3 eval/curator/test_seg_parity.py       # all tests
    python3 eval/curator/test_seg_parity.py -v

Stdlib only. No model, no Ollama, no network.
"""

from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
import sid as sidmod  # noqa: E402

VERBOSE = "-v" in sys.argv or "--verbose" in sys.argv

FIXTURE = (Path(__file__).resolve().parents[2]
           / "src-tauri" / "tests" / "fixtures" / "curator" / "seg_parity")
UNIT_PATH = FIXTURE / "unit.txt"
SEG_H1_PATH = FIXTURE / "expected_seg_h1.json"
SEG_V1_PATH = FIXTURE / "expected_seg_v1.json"


class Skip(Exception):
    """Raised instead of failing when the shared fixture is absent."""


def _fixture() -> tuple[str, dict[str, Any]]:
    missing = [p for p in (UNIT_PATH, SEG_H1_PATH) if not p.exists()]
    if missing:
        raise Skip(
            "the shared SEG_H1/SEG_V1 parity fixture is not on disk — "
            + ", ".join(str(p) for p in missing)
            + ". It is Wave 4b-R's artifact; this file pins the Python half "
              "of it and can prove nothing without it.")
    return (UNIT_PATH.read_text(encoding="utf-8"),
            json.loads(SEG_H1_PATH.read_text(encoding="utf-8")))


# ==========================================================================
# the pin
# ==========================================================================

def test_seg_h1_table_is_pinned() -> None:
    """Every field of every sentence, exactly as the fixture recorded it.

    Whole-list equality on purpose. Comparing counts, or spot-checking a few
    sids, would let an offset shift by one character and take every
    `gold_sid/` citation with it while the test stayed green.
    """
    text, want = _fixture()
    got = sidmod.enumerate_unit(text)

    assert got["segmenter_harness_version"] == want["segmenter_harness_version"], (
        f"SEGMENTER_HARNESS_VERSION moved "
        f"{want['segmenter_harness_version']} -> "
        f"{got['segmenter_harness_version']} without the golden being "
        f"regenerated. A version bump re-points every gold_sid ID; it is a "
        f"deliberate migration, never a side effect.")
    assert got["n_records"] == want["n_records"], (got["n_records"], want["n_records"])
    assert got["dropped_over_cap"] == want["dropped_over_cap"]

    if got["sentences"] != want["sentences"]:
        diffs = []
        for i in range(max(len(got["sentences"]), len(want["sentences"]))):
            g = got["sentences"][i] if i < len(got["sentences"]) else None
            w = want["sentences"][i] if i < len(want["sentences"]) else None
            if g != w:
                diffs.append(f"  [{i}] got {g}\n      want {w}")
        raise AssertionError(
            f"SEG_H1 table drifted ({len(got['sentences'])} sentences vs "
            f"{len(want['sentences'])} pinned):\n" + "\n".join(diffs[:6]))


def test_every_pinned_sentence_still_materializes_to_the_same_text() -> None:
    """The table is only worth what its slices resolve to.

    Offsets are into the ORIGINAL unit text, which is what makes a
    materialized sentence a verbatim substring — the property verify.py's G1
    and its role attribution both rest on.
    """
    text, want = _fixture()
    got = sidmod.enumerate_unit(text)
    materialized = {str(s["sid"]): text[s["start"]:s["end"]]
                    for s in got["sentences"]}
    assert materialized == want["materialized"], {
        k: (materialized.get(k), v)
        for k, v in want["materialized"].items()
        if materialized.get(k) != v
    }


def test_render_v1_over_the_pinned_table_is_stable() -> None:
    """RENDER_V1 is what the model sees. Byte-identical across replays, and
    byte-identical to the table it came from."""
    text, want = _fixture()
    table = sidmod.enumerate_unit(text)
    once = sidmod.render_unit(text, table)
    twice = sidmod.render_unit(text, sidmod.enumerate_unit(text))
    assert once == twice, "RENDER_V1 is not deterministic"

    lines_by_sid = {}
    for line in once.split("\n"):
        if line.startswith("S") and "]: " in line:
            head, _, _ = line.partition("]: ")
            lines_by_sid[head.split(" ")[0][1:]] = line
    for sid_str, body in want["materialized"].items():
        first = body.split("\n")[0]
        assert lines_by_sid[sid_str].endswith(first), (sid_str, lines_by_sid[sid_str])


# ==========================================================================
# the mapping rule, from the side that can see it
# ==========================================================================

def test_the_documented_divergences_hold_from_the_python_side() -> None:
    """The fixture README's divergence table, asserted where Python can.

    This is the mapping rule between `gold_sid/` and a product run. It is
    asserted rather than described so that a change in EITHER direction — one
    that widens the gap, and equally one that quietly closes it — fails.
    """
    text, want = _fixture()
    got = sidmod.enumerate_unit(text)
    sents = got["sentences"]

    # Row 2: SEG_H1 sees 10 sentences here; SEG_V1 sees 12. The whole gap is
    # row 1 (redaction), so a gold_sid ID after the credential is off by two.
    assert len(sents) == 10, len(sents)
    if SEG_V1_PATH.exists():
        v1 = json.loads(SEG_V1_PATH.read_text(encoding="utf-8"))
        v1_sentences = v1.get("sentences") if isinstance(v1, dict) else v1
        if isinstance(v1_sentences, list):
            assert len(v1_sentences) != len(sents), (
                "SEG_V1 and SEG_H1 now agree on the sentence count for this "
                "document. That may be correct, but it changes the mapping "
                "rule the benchmark is read through — regenerate the fixture "
                "and update its README rather than deleting this assertion.")

    # Row 1: no redactor here. `build_units.py` already replaced the
    # credential, and SEG_H1 marks the whole CONTAINING SENTENCE uncitable
    # instead of splitting the placeholder out as SEG_V1 does.
    uncitable = [s for s in sents if not s["cite_ok"]]
    assert len(uncitable) == 1, uncitable
    redacted_text = text[uncitable[0]["start"]:uncitable[0]["end"]]
    assert "[REDACTED:" in redacted_text
    assert redacted_text.startswith("Here is the mirror token"), redacted_text
    assert redacted_text.endswith("for staging."), redacted_text

    # Row 3: SEG_H1's boundary regex is `[.!?]+["')\]]*[ \t]+`, which never
    # matches the ideographic full stop, so two Japanese sentences are one
    # sid. SEG_V1 reaches the same count by a different route (UAX#29 breaks,
    # then the short-segment merge re-joins) — an agreement of two unrelated
    # rules, not a contract.
    cjk = [s for s in sents if "。" in text[s["start"]:s["end"]]]
    assert len(cjk) == 1, cjk
    assert text[cjk[0]["start"]:cjk[0]["end"]].count("。") == 2

    # Row 5: character offsets into the WHOLE unit, globally monotonic, and
    # they count the `USER: ` / `ASSISTANT: ` markers. SEG_V1's are byte
    # offsets into one record and restart at 0 — so an offset from one side
    # must NEVER be compared to the other's.
    assert sents[0]["start"] == len("USER: "), sents[0]["start"]
    starts = [s["start"] for s in sents]
    assert starts == sorted(starts) and len(set(starts)) == len(starts)
    per_record = {}
    for s in sents:
        per_record.setdefault(s["record_index"], []).append(s["start"])
    assert min(per_record[1]) > max(per_record[0]), "offsets restarted per record"

    # Row 7: the harness is UNCAPPED by default, so a benchmark unit is never
    # shortened relative to the anchor baseline.
    assert sidmod.DEFAULT_MAX_SENTENCES == 0
    assert got["dropped_over_cap"] == 0

    # Row 9: the opaque-block rules ARE deliberately in step — a fenced block
    # and a >=3-line log run each collapse to exactly one sid on both sides.
    opaque = [s for s in sents if s["opaque_block"]]
    assert len(opaque) == 2, opaque
    bodies = [text[s["start"]:s["end"]] for s in opaque]
    assert bodies[0].startswith("```rust") and bodies[0].endswith("```")
    assert bodies[1].count("\n") == 2 and bodies[1].startswith("2026-08-12T")

    # Row 10: `sentence_index` is 0-based within its record — the one
    # coordinate the two tables genuinely share.
    for record_index in sorted(per_record):
        idx = [s["sentence_index"] for s in sents
               if s["record_index"] == record_index]
        assert idx == list(range(len(idx))), (record_index, idx)


def test_a_sid_level_comparison_is_only_safe_on_a_clean_unit() -> None:
    """The consequence the benchmark has to live with, stated as a test.

    Rows 1, 3 and 4 all fire on this document, so NOT ONE of its sids may be
    compared across the two segmenters. Any recall number read at SID level
    inherits that, and `MANIFEST-V1.md` prints the cap beside it.
    """
    text, _ = _fixture()
    sents = sidmod.enumerate_unit(text)["sentences"]
    hazards = {
        "redaction": any(not s["cite_ok"] for s in sents),
        "cjk": any("。" in text[s["start"]:s["end"]] for s in sents),
        "short_segment": any(
            len(text[s["start"]:s["end"]].split()) < 3 for s in sents),
    }
    assert hazards["redaction"] and hazards["cjk"], hazards
    assert any(hazards.values()), (
        "this fixture is supposed to trip the divergence rules; if it stopped, "
        "it stopped being the fixture that documents them")


# --------------------------------------------------------------------------

def main() -> int:
    tests = [(n, o) for n, o in sorted(globals().items())
             if n.startswith("test_") and callable(o)]
    failures = skipped = 0
    for name, fn in tests:
        try:
            fn()
        except Skip as exc:
            skipped += 1
            print(f"SKIP {name}: {exc}")
        except Exception:
            failures += 1
            print(f"FAIL {name}")
            traceback.print_exc()
        else:
            print(f"ok   {name}")
            if VERBOSE:
                print(f"     fixture: {FIXTURE}")
    passed = len(tests) - failures - skipped
    print(f"\n{passed}/{len(tests)} passed"
          + (f", {skipped} SKIPPED (fixture absent)" if skipped else ""))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
