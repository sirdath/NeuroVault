"""Sentence enumeration and RENDER_V1 rendering for the SENTENCE-ID contract.

THE ONE IMPLEMENTATION. `run_bench.py --render sid` builds the prompt from
this module and `verify_sid.py` resolves the model's IDs with this module.
There is deliberately no second copy: two enumerations with one name is the
exact bug the sentence-ID contract exists to prevent (a model points at S12
and the verifier reads a different S12).

    from sid import enumerate_unit, render_unit, resolve

    table = enumerate_unit(unit_text)      # deterministic, pure
    prompt_body = render_unit(unit_text, table)
    sentence = resolve(unit_text, table, 12)

WHAT THIS IS AND IS NOT
  The product's SEG_V1 (spec section 5.2) segments the *sanitized transcript
  records* with a block pass plus a UAX#29 prose pass from Rust's
  `unicode-segmentation`. This harness segments the *already-rendered unit
  text* that `build_units.py` produced, and its prose pass is a rule-based
  splitter, because the harness is stdlib-only (no ICU, no PyICU, no crate).
  Call it SEG_H1 and keep the difference in view when reading a benchmark
  number: SEG_H1 measures whether a model can point at server-enumerated
  sentence IDs, which is the contract under test. It does not measure
  Rust SEG_V1's boundary decisions, which have their own golden-table tests
  on the product side.

  Everything the contract depends on is faithful:
    - one deterministic table per unit, IDs 1..n contiguous, restart per unit;
    - the ID is the ONLY pointer form the model may emit;
    - the server (here: the verifier) materializes cited text by slicing its
      own table, never by searching for model-supplied text;
    - a sentence touched by redaction is enumerated but not citable;
    - code fences and log runs collapse to ONE opaque ID;
    - an over-cap opaque block renders truncated with `… [+N bytes]` while
      keeping its full offsets.

OFFSETS ARE INTO THE ORIGINAL UNIT TEXT. That is what makes a materialized
sentence a verbatim substring of the unit, so `verify.py`'s G1 reports
`exact` and its role attribution (walk back to the nearest role marker) keeps
working unchanged. No normalization, no reflowing, no case folding: bytes in,
same bytes out.

Stdlib only.
"""

from __future__ import annotations

import re
from typing import Any

# Bump when any rule below changes: the harness twin of SEGMENTER_VERSION.
SEGMENTER_HARNESS_VERSION = 1

# Product parity (spec section 5.2 / guide section 2.3).
OPAQUE_RENDER_CAP_BYTES = 2048
PRODUCT_MAX_SENTENCES = 150

# The harness default is UNCAPPED. The product caps a unit at 150 sentences
# and splits the overflow into consecutive sub-units sharing the turn's event
# ids -- a runner concern with no counterpart here, since score.py keys every
# metric on one unit_id. Truncating instead would hand the sid contract a
# shorter transcript than the anchor baseline saw and make the two runs
# incomparable, which is worse than measuring an uncapped table. Pass
# max_sentences=150 for a deliberate parity run; the table then records what
# it dropped.
DEFAULT_MAX_SENTENCES = 0

# build_units.py emits four line shapes (README "What goes into the text"):
#   USER: ...
#   ASSISTANT: ...
#   ASSISTANT [tool:Bash] npm run tauri dev     <- still the assistant
#   TOOL_RESULT: ...                            <- neither party spoke it
# SYSTEM is accepted defensively. verify.py's _ROLE_MARKER_RE matches the same
# four, uppercase-only, and this module agrees with it on real units -- see
# _marker_re() for the lowercase-fixture exception.
_MARKER_NAMES = "USER|ASSISTANT|TOOL_RESULT|SYSTEM"
_MARKER_UPPER = re.compile(rf"^({_MARKER_NAMES})(\s*\[[^\]\n]*\])?\s*:?[ \t]*")
_MARKER_ANY = re.compile(
    rf"^({_MARKER_NAMES})(\s*\[[^\]\n]*\])?\s*:?[ \t]*", re.IGNORECASE
)

# The role each marker denotes. A tool invocation line is the assistant
# speaking (it chose to run the command); a TOOL_RESULT is not.
MARKER_ROLE = {
    "USER": "user",
    "ASSISTANT": "assistant",
    "TOOL_RESULT": "tool",
    "SYSTEM": "system",
}

# Roles the output schema lets a model claim.
CLAIMABLE_ROLES = ("user", "assistant")

# Redaction placeholders build_units.py writes. A sentence containing one is
# enumerated (the model may read it as context) but NOT citable: a durable
# fact sitting next to a credential is exactly the memory we do not want.
_REDACTION_MARK = "[REDACTED:"

# --- prose pass ------------------------------------------------------------

# Candidate boundary: a terminator, optional closing quotes/brackets, then
# whitespace. The trailing-whitespace requirement is what keeps "v2.1" and
# "3.30" intact for free.
_BOUNDARY = re.compile(r"[.!?]+[\"')\]]*[ \t]+")

# Tokens whose trailing period never ends a sentence. Deterministic, closed,
# and versioned with SEGMENTER_HARNESS_VERSION.
_ABBREVIATIONS = {
    "e.g.", "i.e.", "etc.", "vs.", "cf.", "al.", "approx.", "no.", "fig.",
    "eq.", "dr.", "mr.", "mrs.", "ms.", "prof.", "sr.", "jr.", "st.",
    "inc.", "ltd.", "co.", "min.", "max.", "sec.", "ver.", "rev.", "esp.",
    "resp.", "cca.", "ca.", "vol.",
}
_TRAILING_WORD = re.compile(r"[^\s]+$")

# --- block pass ------------------------------------------------------------

_FENCE = re.compile(r"^\s*(```|~~~)")

# "log-shaped": a line that is machine output rather than prose. Three or more
# in a row collapse into one opaque sentence.
_LOG_SHAPES = (
    re.compile(r"^\s*[\[(]?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}"),      # ISO stamp
    re.compile(r"^\s*\d{1,2}:\d{2}:\d{2}"),                          # clock
    re.compile(r"^\s*[{\[]"),                                        # JSON open
    re.compile(r"^\s*\"[^\"]{1,80}\"\s*:"),                          # JSON key
    re.compile(r"^\s*(/|\./|\.\./|~/)\S+"),                          # path
    re.compile(r"^\s*\S+\.(rs|py|ts|tsx|js|jsx|json|toml|yaml|yml|md|log|txt):\d+"),
    re.compile(r"^\s*(at |ERROR|WARN(ING)?|INFO|DEBUG|TRACE|FATAL|PANIC)\b"),
    re.compile(r"^\s*(\+\+\+|---|@@|diff --git)\s"),                 # diff
    re.compile(r"^\s*\d+\s*[|:]\s"),                                 # numbered
    re.compile(r"^\s*(warning|error)(\[[^\]]+\])?:"),                # rustc
    re.compile(r"^\s*(test|running|Compiling|Finished|Running)\s+\S"),  # cargo
)
_MIN_LOG_RUN = 3

# A prose segment shorter than this many words merges into its successor
# (UAX#29 over-splits on abbreviations and initials; the product does the
# same, spec section 5.2 step 3).
_MIN_WORDS = 3


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def _marker_re(unit_text: str) -> re.Pattern[str]:
    """Uppercase markers on real units; lowercase only when that is all there is.

    `build_units.py` writes `USER:` / `ASSISTANT:`, and `verify.py` derives
    role attribution from uppercase markers alone. Matching lowercase
    unconditionally would let a quoted "user:" inside an assistant message
    open a phantom record and desynchronise the two. The synthetic `smoke/`
    fixtures, however, are written lowercase. So: if a unit contains any
    uppercase marker, only uppercase markers count; if it contains none, fall
    back to case-insensitive matching. Decided per unit, so it is
    deterministic for a given unit text.
    """
    for line in unit_text.split("\n"):
        if _MARKER_UPPER.match(line):
            return _MARKER_UPPER
    return _MARKER_ANY


def _lines_with_offsets(text: str, start: int, end: int) -> list[tuple[int, int]]:
    """[(line_start, line_end)] over text[start:end], newline excluded."""
    out: list[tuple[int, int]] = []
    i = start
    while i < end:
        nl = text.find("\n", i, end)
        if nl == -1:
            out.append((i, end))
            break
        out.append((i, nl))
        i = nl + 1
    return out


def _trim(text: str, start: int, end: int) -> tuple[int, int]:
    """Shrink [start, end) past leading/trailing whitespace."""
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return start, end


def _is_log_line(line: str) -> bool:
    if not line.strip():
        return False
    return any(p.match(line) for p in _LOG_SHAPES)


def _split_prose_line(text: str, start: int, end: int) -> list[tuple[int, int]]:
    """Sentence spans within one line. Newlines are already hard boundaries.

    UAX#29 breaks after a line separator, so splitting per line first matches
    the product's boundaries and keeps every rendered sentence on one line --
    which RENDER_V1 requires.
    """
    spans: list[tuple[int, int]] = []
    cursor = start
    for m in _BOUNDARY.finditer(text, start, end):
        boundary = m.end()
        head = text[cursor:m.start() + len(m.group(0).rstrip())]
        word = _TRAILING_WORD.search(head)
        if word and word.group(0).lower() in _ABBREVIATIONS:
            continue  # "e.g. " is not a sentence end
        spans.append((cursor, boundary))
        cursor = boundary
    if cursor < end:
        spans.append((cursor, end))

    # trim, drop empties
    trimmed = [(_trim(text, a, b)) for a, b in spans]
    trimmed = [(a, b) for a, b in trimmed if b > a]

    # merge a <3-word segment into its successor, on this line only (a merge
    # across a newline would produce a sentence that cannot render on one
    # line). The last segment has no successor and stays as it is.
    merged: list[tuple[int, int]] = []
    carry: tuple[int, int] | None = None
    for a, b in trimmed:
        if carry is not None:
            a = carry[0]
            carry = None
        if len(text[a:b].split()) < _MIN_WORDS:
            carry = (a, b)
            continue
        merged.append((a, b))
    if carry is not None:
        merged.append(carry)
    return merged


# --------------------------------------------------------------------------
# records
# --------------------------------------------------------------------------

def split_records(unit_text: str) -> list[dict[str, Any]]:
    """Role-tagged records: [{record_index, role, marker, body_start, body_end}].

    A record opens at a role-marker line and runs to the next one. Text before
    the first marker (or a unit with no markers at all) becomes one record
    attributed to `user` with `role_inferred: True` -- the harness never
    guesses a role from content, and `user` is the only attribution the
    benchmark's own gold assumes for unmarked prose.
    """
    marker = _marker_re(unit_text)
    lines = _lines_with_offsets(unit_text, 0, len(unit_text))

    starts: list[tuple[int, str, int]] = []  # (line_index, role, body_offset)
    for idx, (ls, le) in enumerate(lines):
        m = marker.match(unit_text[ls:le])
        if m:
            role = MARKER_ROLE[m.group(1).upper()]
            starts.append((idx, role, ls + m.end()))

    records: list[dict[str, Any]] = []

    def push(role: str, body_start: int, body_end: int, inferred: bool) -> None:
        s, e = _trim(unit_text, body_start, body_end)
        if e <= s:
            return
        records.append({
            "record_index": len(records),
            "role": role,
            "body_start": s,
            "body_end": e,
            "role_inferred": inferred,
        })

    if not starts:
        push("user", 0, len(unit_text), True)
        return records

    first_line = starts[0][0]
    if first_line > 0:
        preamble_end = lines[first_line][0]
        push("user", 0, preamble_end, True)

    for i, (line_idx, role, body_start) in enumerate(starts):
        if i + 1 < len(starts):
            body_end = lines[starts[i + 1][0]][0]
        else:
            body_end = len(unit_text)
        push(role, body_start, body_end, False)

    return records


# --------------------------------------------------------------------------
# enumeration
# --------------------------------------------------------------------------

def enumerate_unit(
    unit_text: str,
    max_sentences: int = DEFAULT_MAX_SENTENCES,
    opaque_cap_bytes: int = OPAQUE_RENDER_CAP_BYTES,
) -> dict[str, Any]:
    """The sentence table. Pure function of (unit_text, the rules above).

    Returns
      {segmenter_harness_version, sentences: [Sentence], dropped_over_cap,
       n_records}
    where a Sentence is
      {sid, record_index, sentence_index, start, end, role, role_inferred,
       cite_ok, opaque_block, over_cap}
    and `start`/`end` are character offsets into `unit_text`.
    """
    records = split_records(unit_text)
    sentences: list[dict[str, Any]] = []

    for rec in records:
        spans: list[tuple[int, int, bool]] = []  # (start, end, opaque)
        lines = _lines_with_offsets(unit_text, rec["body_start"], rec["body_end"])

        i = 0
        while i < len(lines):
            ls, le = lines[i]
            line = unit_text[ls:le]

            # 1a. fenced block -> one opaque sentence
            if _FENCE.match(line):
                j = i + 1
                while j < len(lines):
                    if _FENCE.match(unit_text[lines[j][0]:lines[j][1]]):
                        break
                    j += 1
                end = lines[min(j, len(lines) - 1)][1]
                spans.append((ls, end, True))
                i = j + 1
                continue

            # 1b. run of >= _MIN_LOG_RUN log-shaped lines -> one opaque sentence
            if _is_log_line(line):
                j = i
                while j < len(lines) and _is_log_line(
                    unit_text[lines[j][0]:lines[j][1]]
                ):
                    j += 1
                if j - i >= _MIN_LOG_RUN:
                    spans.append((ls, lines[j - 1][1], True))
                    i = j
                    continue

            # 2. prose
            spans.extend((a, b, False) for a, b in _split_prose_line(unit_text, ls, le))
            i += 1

        for k, (a, b, opaque) in enumerate(spans):
            a, b = _trim(unit_text, a, b)
            if b <= a:
                continue
            body = unit_text[a:b]
            over_cap = opaque and len(body.encode("utf-8")) > opaque_cap_bytes
            sentences.append({
                "sid": 0,  # assigned below
                "record_index": rec["record_index"],
                "sentence_index": k,
                "start": a,
                "end": b,
                "role": rec["role"],
                "role_inferred": rec["role_inferred"],
                # Redaction-touched sentences are readable context but not
                # citable (guide section 2.2 / G02).
                "cite_ok": _REDACTION_MARK not in body,
                "opaque_block": opaque,
                "over_cap": over_cap,
            })

    # sentence_index must be 0-based WITHIN its record after the drops above
    per_record: dict[int, int] = {}
    for s in sentences:
        idx = per_record.get(s["record_index"], 0)
        s["sentence_index"] = idx
        per_record[s["record_index"]] = idx + 1

    dropped = 0
    if max_sentences and len(sentences) > max_sentences:
        dropped = len(sentences) - max_sentences
        sentences = sentences[:max_sentences]

    for n, s in enumerate(sentences, start=1):
        s["sid"] = n

    return {
        "segmenter_harness_version": SEGMENTER_HARNESS_VERSION,
        "sentences": sentences,
        "dropped_over_cap": dropped,
        "n_records": len(records),
    }


def sentence_by_sid(table: dict[str, Any], sid: int) -> dict[str, Any] | None:
    for s in table["sentences"]:
        if s["sid"] == sid:
            return s
    return None


def resolve(unit_text: str, table: dict[str, Any], sid: int) -> str | None:
    """Materialize a cited sentence: table lookup plus a slice. Never a search."""
    s = sentence_by_sid(table, sid)
    if s is None:
        return None
    return unit_text[s["start"]:s["end"]]


# --------------------------------------------------------------------------
# RENDER_V1
# --------------------------------------------------------------------------

def _truncate_utf8(body: str, cap: int) -> tuple[str, int]:
    """Cut `body` to at most `cap` bytes on a character boundary.

    Returns (kept_text, dropped_bytes).
    """
    raw = body.encode("utf-8")
    if len(raw) <= cap:
        return body, 0
    cut = raw[:cap]
    while cut:
        try:
            kept = cut.decode("utf-8")
            break
        except UnicodeDecodeError:
            cut = cut[:-1]
    else:
        kept = ""
    return kept, len(raw) - len(kept.encode("utf-8"))


def render_sentence(
    unit_text: str,
    sentence: dict[str, Any],
    opaque_cap_bytes: int = OPAQUE_RENDER_CAP_BYTES,
) -> str:
    """One RENDER_V1 line (opaque blocks: header plus 2-space-indented body)."""
    body = unit_text[sentence["start"]:sentence["end"]]
    head = f"S{sentence['sid']} [{sentence['role']}]: "
    if not sentence["opaque_block"]:
        # Prose never contains a newline by construction (newline is a hard
        # boundary and merges never cross one), so this is one line.
        return head + body

    kept, dropped = _truncate_utf8(body, opaque_cap_bytes)
    lines = kept.split("\n")
    out = head + lines[0]
    for extra in lines[1:]:
        out += "\n  " + extra
    if dropped:
        out += f"… [+{dropped} bytes]"
    return out


def render_unit(
    unit_text: str,
    table: dict[str, Any] | None = None,
    opaque_cap_bytes: int = OPAQUE_RENDER_CAP_BYTES,
) -> str:
    """The exact bytes the model sees. Byte-identical across replays."""
    if table is None:
        table = enumerate_unit(unit_text)
    return "\n".join(
        render_sentence(unit_text, s, opaque_cap_bytes) for s in table["sentences"]
    )


# --------------------------------------------------------------------------
# self-check
# --------------------------------------------------------------------------

def _selftest() -> int:
    """`python3 eval/curator/sid.py` -- proves the invariants the contract rests on."""
    failures = 0

    def check(name: str, cond: bool, detail: str = "") -> None:
        nonlocal failures
        if not cond:
            failures += 1
            print(f"  FAIL {name} {detail}")
        else:
            print(f"  ok   {name}")

    # 1. The guide's section 6 fixture, in harness rendering form.
    unit = (
        "USER: From now on we deploy Atlas only on Tuesdays. Marketing keeps "
        "landing Friday hotfixes and it burned us twice. Can you update the runbook?\n"
        "\n"
        "ASSISTANT: Updated the runbook. I changed the deploy section to say "
        "Tuesday-only and noted the Friday incident history. The staging cron "
        "still runs at 03:30 UTC, so the Tuesday deploy window opens after 04:00.\n"
    )
    t = enumerate_unit(unit)
    sids = [s["sid"] for s in t["sentences"]]
    roles = [s["role"] for s in t["sentences"]]
    check("ids are 1..n contiguous", sids == list(range(1, len(sids) + 1)), str(sids))
    check("six sentences", len(sids) == 6, f"got {len(sids)}")
    check("roles split 3 user / 3 assistant",
          roles == ["user"] * 3 + ["assistant"] * 3, str(roles))
    check("every sentence is a verbatim substring of the unit",
          all(resolve(unit, t, s) in unit for s in sids))
    check("S1 is the deploy decision",
          resolve(unit, t, 1) == "From now on we deploy Atlas only on Tuesdays.",
          repr(resolve(unit, t, 1)))
    check("S6 carries 03:30 UTC", "03:30 UTC" in (resolve(unit, t, 6) or ""))
    rendered = render_unit(unit, t)
    check("render is one line per sentence",
          len(rendered.split("\n")) == len(sids), repr(rendered[:120]))
    check("render_v1 shape", rendered.startswith("S1 [user]: From now on"))
    check("determinism", render_unit(unit) == rendered)

    # 2. Redaction-touched sentences are enumerated but not citable.
    red = "USER: The staging password=[REDACTED:CREDENTIAL] is in the vault now.\n"
    tr = enumerate_unit(red)
    check("redacted sentence enumerated", len(tr["sentences"]) == 1)
    check("redacted sentence not citable", tr["sentences"][0]["cite_ok"] is False)

    # 3. A fenced block is ONE id; a log run is ONE id.
    fenced = (
        "ASSISTANT: Here is the config.\n"
        "```json\n"
        "{\n"
        '  "port": 5433\n'
        "}\n"
        "```\n"
        "ASSISTANT: That is the whole file.\n"
    )
    tf = enumerate_unit(fenced)
    opaque = [s for s in tf["sentences"] if s["opaque_block"]]
    check("one opaque id for the fence", len(opaque) == 1, str(len(opaque)))
    check("fence body kept whole", '"port": 5433' in resolve(fenced, tf, opaque[0]["sid"]))
    check("fence continuation lines indent by two spaces",
          "\n  " in render_sentence(fenced, opaque[0]))

    logs = (
        "TOOL_RESULT: 2026-08-01T10:00:00Z started\n"
        "2026-08-01T10:00:01Z step one\n"
        "2026-08-01T10:00:02Z step two\n"
        "2026-08-01T10:00:03Z done\n"
    )
    tl = enumerate_unit(logs)
    check("log run collapses to one id",
          len([s for s in tl["sentences"] if s["opaque_block"]]) >= 1,
          str(tl["sentences"]))
    check("tool role tagged", tl["sentences"][0]["role"] == "tool")

    # 4. Abbreviations and versions do not over-split.
    abbr = "USER: We use PostgreSQL 16.4 in prod, e.g. for the ledger service.\n"
    ta = enumerate_unit(abbr)
    check("no split on 16.4 / e.g.", len(ta["sentences"]) == 1,
          str([resolve(abbr, ta, s['sid']) for s in ta['sentences']]))

    # 5. Short fragments merge forward, not backward.
    short = "USER: Yes. And always run migrations behind a feature flag please.\n"
    ts = enumerate_unit(short)
    check("short fragment merges into successor", len(ts["sentences"]) == 1,
          str([resolve(short, ts, s['sid']) for s in ts['sentences']]))

    # 6. Over-cap opaque block: full offsets, truncated rendering.
    big_line = '{"payload": "' + "x" * 3000 + '"}'
    big = f"TOOL_RESULT: {big_line}\n{big_line}\n{big_line}\n"
    tb = enumerate_unit(big)
    over = [s for s in tb["sentences"] if s["over_cap"]]
    check("over-cap flagged", len(over) == 1, str(len(over)))
    if over:
        r = render_sentence(big, over[0])
        check("over-cap suffix present", "bytes]" in r)
        check("over-cap keeps full offsets",
              len(resolve(big, tb, over[0]["sid"])) > OPAQUE_RENDER_CAP_BYTES)

    # 7. Lowercase smoke-fixture markers still resolve to roles.
    low = "user: hello there friend\nassistant: hi, the build is green\n"
    tlow = enumerate_unit(low)
    check("lowercase markers recognised when no uppercase exists",
          [s["role"] for s in tlow["sentences"]] == ["user", "assistant"],
          str([s["role"] for s in tlow["sentences"]]))

    # 8. A quoted lowercase marker inside an UPPERCASE unit opens no record.
    mixed = 'USER: I told them "user: do it" yesterday and they did it today.\n'
    tm = enumerate_unit(mixed)
    check("uppercase units ignore lowercase markers",
          all(s["role"] == "user" for s in tm["sentences"]) and len(tm["sentences"]) == 1,
          str(tm["sentences"]))

    print("FAIL" if failures else "OK")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(_selftest())
