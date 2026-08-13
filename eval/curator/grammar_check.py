"""Run spec section 20's grammar half: schema-v2 AND its llama.cpp grammar
against one accepted/rejected corpus.

    the exact served schema-v2 object and its generated llama.cpp grammar
    pass the same accepted/rejected fixture corpus using only the allowed
    schema subset
                                            -- spec section 20, acceptance item 7

WHY THIS EXISTS. `prompt.rs::OUTPUT_SCHEMA_JSON` is byte-identical to
`schema_sid.json` and uses only the keyword subset llama.cpp is believed to
convert reliably. "Believed" was the gap: llama.cpp SILENTLY SKIPS keywords it
cannot express, so a generated grammar can be strictly weaker than the schema
it came from and nothing in the pipeline says so. The only honest way to find
out is to run the real converter and then run strings through what it produced.

WHAT IS PROVEN HERE, EXACTLY
  Schema half   EXECUTABLE. `validate_instance()` is a small validator over
                the nine keywords this schema actually uses. `jsonschema` is
                not installed and is not installed by this script: the harness
                is stdlib-only by policy (verify_sid.py re-checks the anchored
                pattern with `re` for the same reason). `schema_uses_only_the_
                supported_subset()` fails loudly if the schema ever grows a
                keyword the validator does not implement, so the validator
                cannot silently under-check the way llama.cpp silently
                under-converts.
  Grammar half  EXECUTABLE. `Gbnf` parses the converter's real output and
                recognizes strings against it. No llama.cpp binary is
                downloaded or run -- the recognizer is ~150 lines of stdlib
                over the GBNF subset the converter emits (literals, character
                classes, alternation, sequence, grouping, bounded repetition).
                It is a recognizer, not a sampler: it answers "could
                constrained decoding have produced these bytes", which is the
                question acceptance item 7 asks.
  Structure     Asserted on top of the executable half, so a future re-vendor
                that quietly drops a bound fails here rather than in
                production.

WHAT IS NOT PROVEN. That llama.cpp's own C++ GBNF engine agrees with this
recognizer. Two implementations of one grammar is exactly the class of bug the
sentence-id contract exists to prevent, and it is named rather than hidden:
running the corpus through a real `llama-gbnf-validator` is the one remaining
upgrade, and it needs a binary this script deliberately does not fetch.

THE CORPUS IS NOT A PASS/FAIL ON AGREEMENT. Four cases are recorded as
DIVERGENT: the schema accepts and the grammar refuses (unknown keys, a `quote`
field, byte offsets, a reordered key), and two more where BOTH accept something
only Rust G00 rejects. Those are findings, pinned in `grammar_corpus/manifest.jsonl`
so they cannot drift unnoticed. A case is a FAILURE only when what happens
disagrees with what the manifest recorded.

Usage:
    python3 eval/curator/grammar_check.py              # everything, table + exit code
    python3 eval/curator/grammar_check.py --emit-grammar
    python3 eval/curator/grammar_check.py --verify-vendor
    python3 eval/curator/grammar_check.py --quiet

Stdlib only. No model, no network, no Ollama, no llama.cpp binary.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
VENDOR = HERE / "vendor"
SCHEMA_PATH = HERE / "schema_sid.json"
CORPUS_DIR = HERE / "grammar_corpus"

# The pristine upstream file, reassembled as `head -1` + everything after the
# vendoring header. Pinned in vendor/json_schema_to_grammar.py's own header.
VENDOR_SHA256 = "ee451dc460aa31185226e58988626f64e75ab735169fa3e484fcf16889475ae3"
VENDOR_HEADER_END_LINE = 30          # content resumes on line 31
VENDOR_COMMIT = "c57607016a1ebdd08d269e3378eee5546fc3bf3a"

sys.path.insert(0, str(VENDOR))


# ==========================================================================
# 0. the vendored converter
# ==========================================================================

def verify_vendor() -> tuple[bool, str]:
    """Prove the vendored converter is byte-identical to the pinned commit."""
    path = VENDOR / "json_schema_to_grammar.py"
    if not path.exists():
        return False, f"missing {path}"
    lines = path.read_text(encoding="utf-8").split("\n")
    pristine = "\n".join([lines[0]] + lines[VENDOR_HEADER_END_LINE:])
    got = hashlib.sha256(pristine.encode("utf-8")).hexdigest()
    if got != VENDOR_SHA256:
        return False, (f"vendored converter has been edited: sha256 {got} != "
                       f"pinned {VENDOR_SHA256}. Re-vendor from "
                       f"llama.cpp@{VENDOR_COMMIT} rather than patching it.")
    return True, f"llama.cpp@{VENDOR_COMMIT[:12]} sha256 {got[:16]}… verified"


def generate_grammar(schema: dict[str, Any]) -> str:
    """The GBNF llama.cpp would generate for this schema, from its own code."""
    from json_schema_to_grammar import SchemaConverter  # noqa: PLC0415

    converter = SchemaConverter(
        prop_order={}, allow_fetch=False, dotall=False, raw_pattern=False)
    converter.visit(schema, "")
    return converter.format_grammar()


# ==========================================================================
# 1. a GBNF recognizer  (the executable grammar half)
# ==========================================================================

class Node:
    _seq = 0

    def __init__(self) -> None:
        Node._seq += 1
        self.nid = Node._seq


class Lit(Node):
    def __init__(self, text: str) -> None:
        super().__init__()
        self.text = text


class Cls(Node):
    def __init__(self, negated: bool, ranges: list[tuple[str, str]]) -> None:
        super().__init__()
        self.negated = negated
        self.ranges = ranges


class Ref(Node):
    def __init__(self, name: str) -> None:
        super().__init__()
        self.name = name


class Seq(Node):
    def __init__(self, items: list[Node]) -> None:
        super().__init__()
        self.items = items


class Alt(Node):
    def __init__(self, options: list[Node]) -> None:
        super().__init__()
        self.options = options


class Rep(Node):
    def __init__(self, item: Node, lo: int, hi: int | None) -> None:
        super().__init__()
        self.item = item
        self.lo = lo
        self.hi = hi


class GrammarBudgetExceeded(RuntimeError):
    """The recognizer gave up. Never silently reported as 'rejected'."""


_RULE_RE = re.compile(r"^([A-Za-z][A-Za-z0-9-]*)\s*::=\s*(.*)$")
_NAME_RE = re.compile(r"[A-Za-z][A-Za-z0-9-]*")


class _RhsParser:
    """One rule's right-hand side. The converter emits one rule per line, so a
    line is the whole unit and rule boundaries never need guessing."""

    def __init__(self, text: str) -> None:
        self.s = text
        self.i = 0

    # --- lexing helpers ---------------------------------------------------
    def _ws(self) -> None:
        while self.i < len(self.s) and self.s[self.i] in " \t":
            self.i += 1

    def _peek(self) -> str:
        return self.s[self.i] if self.i < len(self.s) else ""

    def _escape(self) -> str:
        """One escape sequence; `self.i` points AT the backslash."""
        self.i += 1
        c = self.s[self.i]
        self.i += 1
        if c in "xuU":
            width = {"x": 2, "u": 4, "U": 8}[c]
            hexes = self.s[self.i:self.i + width]
            self.i += width
            return chr(int(hexes, 16))
        return {"n": "\n", "r": "\r", "t": "\t"}.get(c, c)

    def _one_char(self) -> str:
        if self._peek() == "\\":
            return self._escape()
        c = self.s[self.i]
        self.i += 1
        return c

    # --- grammar ----------------------------------------------------------
    def parse(self) -> Node:
        node = self.alternates()
        self._ws()
        if self.i != len(self.s):
            raise ValueError(f"unconsumed GBNF at {self.s[self.i:self.i + 40]!r}")
        return node

    def alternates(self) -> Node:
        options = [self.sequence()]
        self._ws()
        while self._peek() == "|":
            self.i += 1
            options.append(self.sequence())
            self._ws()
        return options[0] if len(options) == 1 else Alt(options)

    def sequence(self) -> Node:
        items: list[Node] = []
        while True:
            self._ws()
            c = self._peek()
            if c == "" or c in "|)":
                break
            items.append(self.postfixed())
        # An EMPTY sequence is legal and load-bearing: `space ::= | " " | …`
        # makes whitespace optional through a zero-width first alternative.
        return items[0] if len(items) == 1 else Seq(items)

    def postfixed(self) -> Node:
        atom = self.atom()
        c = self._peek()
        if c == "*":
            self.i += 1
            return Rep(atom, 0, None)
        if c == "+":
            self.i += 1
            return Rep(atom, 1, None)
        if c == "?":
            self.i += 1
            return Rep(atom, 0, 1)
        if c == "{":
            close = self.s.index("}", self.i)
            body = self.s[self.i + 1:close]
            self.i = close + 1
            if "," in body:
                lo, hi = body.split(",", 1)
                return Rep(atom, int(lo), int(hi) if hi.strip() else None)
            return Rep(atom, int(body), int(body))
        return atom

    def atom(self) -> Node:
        c = self._peek()
        if c == '"':
            return Lit(self.literal())
        if c == "[":
            return self.charclass()
        if c == "(":
            self.i += 1
            inner = self.alternates()
            self._ws()
            if self._peek() != ")":
                raise ValueError(f"unclosed group at {self.s[self.i:]!r}")
            self.i += 1
            return inner
        m = _NAME_RE.match(self.s, self.i)
        if not m:
            raise ValueError(f"bad atom at {self.s[self.i:self.i + 40]!r}")
        self.i = m.end()
        return Ref(m.group(0))

    def literal(self) -> str:
        self.i += 1                                   # opening quote
        out: list[str] = []
        while True:
            if self.i >= len(self.s):
                raise ValueError("unterminated literal")
            if self._peek() == '"':
                self.i += 1
                return "".join(out)
            out.append(self._one_char())

    def charclass(self) -> Node:
        self.i += 1                                   # [
        negated = self._peek() == "^"
        if negated:
            self.i += 1
        ranges: list[tuple[str, str]] = []
        while True:
            if self.i >= len(self.s):
                raise ValueError("unterminated character class")
            if self._peek() == "]":
                self.i += 1
                return Cls(negated, ranges)
            lo = self._one_char()
            if self._peek() == "-" and self.s[self.i + 1:self.i + 2] != "]":
                self.i += 1
                ranges.append((lo, self._one_char()))
            else:
                ranges.append((lo, lo))


class Gbnf:
    """A parsed GBNF, able to say whether a string is in the language."""

    BUDGET = 20_000_000

    def __init__(self, text: str) -> None:
        self.source = text
        self.rules: dict[str, Node] = {}
        self.rule_text: dict[str, str] = {}
        for line in text.split("\n"):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            m = _RULE_RE.match(line)
            if not m:
                raise ValueError(f"not a GBNF rule line: {line!r}")
            name, rhs = m.group(1), m.group(2)
            self.rule_text[name] = rhs
            self.rules[name] = _RhsParser(rhs).parse()
        if "root" not in self.rules:
            raise ValueError("grammar has no `root` rule")

    # --- recognition ------------------------------------------------------
    def accepts(self, text: str, rule: str = "root") -> bool:
        """True when `text` is derivable from `rule` in full.

        Bottom-up over end positions rather than a single greedy walk: a
        backtracking matcher can report a false rejection on a grammar with
        bounded repetition, and a false rejection here would read as "the
        grammar is stricter than the schema", which is exactly the claim this
        script exists to make carefully.
        """
        memo: dict[tuple[int, int], frozenset[int]] = {}
        steps = [0]

        def match(node: Node, pos: int) -> frozenset[int]:
            key = (node.nid, pos)
            cached = memo.get(key)
            if cached is not None:
                return cached
            steps[0] += 1
            if steps[0] > self.BUDGET:
                raise GrammarBudgetExceeded(
                    f"recognizer budget {self.BUDGET} exhausted on "
                    f"{len(text)} chars")
            memo[key] = frozenset()          # cycle guard
            result = compute(node, pos)
            memo[key] = result
            return result

        def compute(node: Node, pos: int) -> frozenset[int]:
            if isinstance(node, Lit):
                if text.startswith(node.text, pos):
                    return frozenset({pos + len(node.text)})
                return frozenset()
            if isinstance(node, Cls):
                if pos >= len(text):
                    return frozenset()
                ch = text[pos]
                inside = any(lo <= ch <= hi for lo, hi in node.ranges)
                return frozenset({pos + 1}) if inside != node.negated else frozenset()
            if isinstance(node, Ref):
                target = self.rules.get(node.name)
                if target is None:
                    raise ValueError(f"undefined rule {node.name!r}")
                return match(target, pos)
            if isinstance(node, Alt):
                ends: set[int] = set()
                for option in node.options:
                    ends |= match(option, pos)
                return frozenset(ends)
            if isinstance(node, Seq):
                current = {pos}
                for item in node.items:
                    nxt: set[int] = set()
                    for p in current:
                        nxt |= match(item, p)
                    if not nxt:
                        return frozenset()
                    current = nxt
                return frozenset(current)
            if isinstance(node, Rep):
                ceiling = node.hi if node.hi is not None else len(text) - pos + 1
                ends: set[int] = {pos} if node.lo == 0 else set()
                current = {pos}
                for count in range(1, ceiling + 1):
                    nxt = set()
                    for p in current:
                        nxt |= match(node.item, p)
                    if not nxt:
                        break
                    if count >= node.lo:
                        ends |= nxt
                    if nxt == current:           # zero-width, no progress
                        break
                    current = nxt
                return frozenset(ends)
            raise TypeError(f"unknown node {node!r}")

        start = self.rules.get(rule)
        if start is None:
            raise ValueError(f"no rule {rule!r}")
        return len(text) in match(start, 0)


# --- is the recognizer itself right? --------------------------------------
#
# A recognizer that is wrong in a convenient direction would make this whole
# script lie, and the corpus alone cannot catch that: a matcher that accepted
# everything would fail the reject cases, but one with a subtle repetition bug
# could still get all 24 right by accident. So: micro-grammars whose languages
# are obvious by eye, including the three constructs the converter's output
# actually leans on (bounded repetition, an empty alternative, nested groups).
RECOGNIZER_SELFTEST: list[tuple[str, str, list[str], list[str]]] = [
    ("literal", 'root ::= "abc"', ["abc"], ["", "ab", "abcd", "ABC"]),
    ("alternation", 'root ::= "a" | "b"', ["a", "b"], ["", "ab", "c"]),
    ("empty alternative", 'root ::= | "a"', ["", "a"], ["aa", "b"]),
    ("bounded repetition", 'root ::= "a"{2,4}',
     ["aa", "aaa", "aaaa"], ["", "a", "aaaaa"]),
    ("open repetition", 'root ::= "a"+', ["a", "aaaaaa"], ["", "b", "ab"]),
    ("optional", 'root ::= "a" "b"?', ["a", "ab"], ["", "b", "abb"]),
    ("negated class", 'root ::= [^abc]', ["d", "Z"], ["a", "b", "", "dd"]),
    ("range class", "root ::= [0-9a-f]{1,2}",
     ["0", "9f", "ab"], ["", "g", "0g", "000"]),
    ("escapes", r'root ::= "\"" [\\] "\n"', ['"\\\n'], ['"\\', "\\\n", ""]),
    ("nested group + ref",
     'root ::= "x" (inner | "z")\ninner ::= "y"{1,2}',
     ["xy", "xyy", "xz"], ["x", "xyyy", "xyz", ""]),
    # The shape the converter emits for a bounded array: a mandatory first
    # item plus a bounded tail. Getting this wrong would silently mis-report
    # the evidence cardinality check.
    ("array shape", 'root ::= "[" ("i" ("," "i"){0,2})? "]"',
     ["[]", "[i]", "[i,i]", "[i,i,i]"], ["[i,i,i,i]", "[,]", "[i,]"]),
]


def selftest_recognizer() -> list[str]:
    """Failures, or [] when the recognizer behaves."""
    failures = []
    for name, source, accept, reject in RECOGNIZER_SELFTEST:
        g = Gbnf(source)
        for s in accept:
            if not g.accepts(s):
                failures.append(f"{name}: should accept {s!r}")
        for s in reject:
            if g.accepts(s):
                failures.append(f"{name}: should reject {s!r}")
    return failures


# ==========================================================================
# 2. a JSON-Schema validator over the keywords this schema uses
# ==========================================================================

# Every keyword `schema_sid.json` is allowed to contain. `$schema` and `title`
# are annotations. Anything outside this set means the validator would
# under-check, so the schema-subset assertion below fails rather than passing a
# case the validator never really examined.
SUPPORTED_KEYWORDS = {
    "$schema", "title", "type", "properties", "required", "enum",
    "items", "minItems", "maxItems", "maxLength", "pattern",
}

_JSON_TYPES: dict[str, Any] = {
    "object": dict, "array": list, "string": str, "boolean": bool,
    "number": (int, float), "integer": int, "null": type(None),
}


def schema_keywords(schema: Any, seen: set[str] | None = None) -> set[str]:
    """Every keyword appearing anywhere in the schema (field names excluded)."""
    seen = set() if seen is None else seen
    if isinstance(schema, dict):
        for key, value in schema.items():
            if key == "properties" and isinstance(value, dict):
                for sub in value.values():
                    schema_keywords(sub, seen)
                seen.add(key)
                continue
            seen.add(key)
            if key in ("items",):
                schema_keywords(value, seen)
    return seen


def validate_instance(instance: Any, schema: dict[str, Any],
                      path: str = "$") -> list[str]:
    """Validation errors, or [] when the instance conforms. Stdlib only."""
    errors: list[str] = []
    expected = schema.get("type")
    if expected:
        py = _JSON_TYPES[expected]
        ok = isinstance(instance, py)
        # JSON has no separate bool/number: `true` must not satisfy `number`.
        if expected in ("number", "integer") and isinstance(instance, bool):
            ok = False
        if not ok:
            return [f"{path}: expected {expected}, got "
                    f"{type(instance).__name__}"]

    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{path}: {instance!r} not in enum {schema['enum']}")

    if isinstance(instance, str):
        if "maxLength" in schema and len(instance) > schema["maxLength"]:
            errors.append(f"{path}: length {len(instance)} > maxLength "
                          f"{schema['maxLength']}")
        if "pattern" in schema and not re.search(schema["pattern"], instance):
            errors.append(f"{path}: {instance!r} does not match "
                          f"{schema['pattern']}")

    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append(f"{path}: {len(instance)} items < minItems "
                          f"{schema['minItems']}")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            errors.append(f"{path}: {len(instance)} items > maxItems "
                          f"{schema['maxItems']}")
        if "items" in schema:
            for idx, element in enumerate(instance):
                errors += validate_instance(element, schema["items"],
                                            f"{path}[{idx}]")

    if isinstance(instance, dict):
        for name in schema.get("required", []):
            if name not in instance:
                errors.append(f"{path}: missing required property {name!r}")
        for name, subschema in (schema.get("properties") or {}).items():
            if name in instance:
                errors += validate_instance(instance[name], subschema,
                                            f"{path}.{name}")
        # No `additionalProperties` check: the schema deliberately omits the
        # keyword, so draft-07's default (true) applies. That is the source of
        # four recorded divergences, not an omission here.

    return errors


def schema_verdict(payload: str, schema: dict[str, Any]) -> tuple[str, str]:
    """('accept'|'reject', reason) for one raw candidate response."""
    try:
        instance = json.loads(payload)
    except json.JSONDecodeError as exc:
        return "reject", f"not JSON: {exc.msg}"
    errors = validate_instance(instance, schema)
    return ("reject", errors[0]) if errors else ("accept", "")


# ==========================================================================
# 3. structural assertions on the generated grammar
# ==========================================================================

def structural_checks(grammar: Gbnf, schema: dict[str, Any]) -> list[tuple[str, bool, str]]:
    """(name, ok, detail). Proved by RECOGNITION wherever recognition can
    prove it, so a check cannot pass on a string match that means nothing."""
    out: list[tuple[str, bool, str]] = []
    props = schema["properties"]["proposals"]["items"]["properties"]

    # --- the anchored sentence-id pattern ---------------------------------
    # The same six cases gates.rs::g00_bounds_counts_sizes_and_ids refuses,
    # plus the two anchor probes: an unquoted id and a trailing space. If the
    # pattern were unanchored, `"S1 "` would pass.
    ev_rule = "proposals-item-evidence-item"
    MUST_ACCEPT = ('"S1"', '"S9"', '"S12"', '"S9999"')
    MUST_REFUSE = ('"S0"', '"S01"', '"s1"', '"S99999"', '"S"', '"12"',
                   'S1', '"S1 "')
    have = ev_rule in grammar.rules
    wrongly_refused = [s for s in MUST_ACCEPT
                       if have and not grammar.accepts(s, ev_rule)]
    wrongly_accepted = [s for s in MUST_REFUSE
                        if have and grammar.accepts(s, ev_rule)]
    ok = have and not wrongly_refused and not wrongly_accepted
    out.append((
        "sid_pattern_is_anchored_and_range_bounded_in_the_grammar", ok,
        f"{ev_rule} accepts {list(MUST_ACCEPT)} and refuses "
        f"{list(MUST_REFUSE)}"
        + (f"; WRONGLY REFUSED {wrongly_refused}" if wrongly_refused else "")
        + (f"; WRONGLY ACCEPTED {wrongly_accepted}" if wrongly_accepted else "")
        + ". The leading [1-9] makes S0 unexpressible, the {0,3} bound makes "
          "S99999 unexpressible, and the enclosing quote literals are the "
          "anchors — an unanchored pattern would admit `\"S1 \"`."))

    # --- no unbounded string where the schema bounds one -------------------
    unbounded: list[str] = []
    bounded: list[str] = []
    for field in ("statement", "subject"):
        cap = props[field].get("maxLength")
        name = f"proposals-item-{field}"
        rhs = grammar.rule_text.get(name, "")
        if re.search(r"char\s*[*+]", rhs) or "char" not in rhs:
            unbounded.append(f"{field}: {rhs!r}")
            continue
        m = re.search(r"char\{(\d+),(\d+)\}", rhs)
        if not m or int(m.group(2)) != cap:
            unbounded.append(f"{field}: {rhs!r} does not bound at {cap}")
        else:
            bounded.append(f"{field}<={m.group(2)}")
    out.append((
        "every_maxLength_survived_the_conversion", not unbounded,
        f"bounded: {bounded}; unbounded: {unbounded}. llama.cpp DOES honour "
        f"minLength/maxLength at this commit, so `maxLength` is not the "
        f"decoration prompt.rs calls it — it is enforced twice. Belt and "
        f"braces, but the comment is stale."))

    # --- array cardinality -------------------------------------------------
    card_ok = (
        grammar.accepts('["S1"]', "proposals-item-evidence")
        and grammar.accepts('["S1", "S2", "S3"]', "proposals-item-evidence")
        and not grammar.accepts("[]", "proposals-item-evidence")
        and not grammar.accepts('["S1", "S2", "S3", "S4"]', "proposals-item-evidence")
    )
    out.append((
        "evidence_cardinality_is_one_to_three", card_ok,
        "1 and 3 accepted; 0 and 4 refused, so minItems/maxItems both "
        "survived as a mandatory first item plus a {0,2} tail."))

    # --- closed enums ------------------------------------------------------
    enum_ok = True
    detail = []
    for field in ("type", "source_role"):
        name = "proposals-item-" + field.replace("_", "-")
        allowed = props[field]["enum"]
        for value in allowed:
            enum_ok &= grammar.accepts(f'"{value}"', name)
        for bad in ("opinion", "tool", "USER", ""):
            if bad not in allowed:
                enum_ok &= not grammar.accepts(f'"{bad}"', name)
        detail.append(f"{field}={allowed}")
    out.append(("enums_are_closed_literal_alternatives", enum_ok,
                "; ".join(detail)))

    # --- the object is CLOSED, which the schema is not --------------------
    item_rhs = grammar.rule_text.get("proposals-item", "")
    declared = list(props)
    order = re.findall(r"proposals-item-([a-z-]+)-kv", item_rhs)
    closed = [o.replace("-", "_") for o in order] == declared
    out.append((
        "the_grammar_object_is_closed_and_ordered", closed,
        f"emitted key order {order}; the schema declares {declared} and omits "
        f"`additionalProperties`, so the grammar is STRICTER than the schema "
        f"here. Rust `deny_unknown_fields` at G00 is the authority and agrees "
        f"with the grammar."))

    # --- no keyword was silently skipped -----------------------------------
    used = schema_keywords(schema)
    unknown = sorted(used - SUPPORTED_KEYWORDS)
    out.append((
        "schema_uses_only_the_validated_keyword_subset", not unknown,
        f"keywords in use: {sorted(used)}"
        + (f"; UNVALIDATED: {unknown}" if unknown else "")))

    return out


# ==========================================================================
# 4. the corpus
# ==========================================================================

def load_corpus() -> list[dict[str, Any]]:
    manifest = CORPUS_DIR / "manifest.jsonl"
    if not manifest.exists():
        raise SystemExit(f"FATAL: no corpus manifest at {manifest}")
    cases = []
    for line in manifest.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        case = json.loads(line)
        case["payload"] = (CORPUS_DIR / case["case"]).read_text(encoding="utf-8")
        cases.append(case)
    return cases


def run_corpus(cases: list[dict[str, Any]], schema: dict[str, Any],
               grammar: Gbnf) -> list[dict[str, Any]]:
    results = []
    for case in cases:
        s_verdict, s_reason = schema_verdict(case["payload"], schema)
        try:
            g_verdict = "accept" if grammar.accepts(case["payload"]) else "reject"
            g_reason = ""
        except GrammarBudgetExceeded as exc:      # never silently a reject
            g_verdict, g_reason = "budget", str(exc)
        results.append({
            **case,
            "schema": s_verdict, "schema_reason": s_reason,
            "grammar": g_verdict, "grammar_reason": g_reason,
            "ok": (s_verdict == case["expect_schema"]
                   and g_verdict == case["expect_grammar"]),
        })
    return results


# ==========================================================================
# 5. reporting
# ==========================================================================

def report(results: list[dict[str, Any]], checks: list[tuple[str, bool, str]],
           grammar: Gbnf, vendor_note: str) -> str:
    lines = ["# llama.cpp grammar corpus — spec §20 acceptance item 7", ""]
    lines.append(f"Recognizer self-test: {len(RECOGNIZER_SELFTEST)} "
                 "micro-grammars, all green (a wrong recognizer would make "
                 "every verdict below meaningless).")
    lines.append(f"Converter: {vendor_note}")
    lines.append(f"Grammar: {len(grammar.rules)} rules, "
                 f"{len(grammar.source)} bytes, generated from "
                 f"`eval/curator/schema_sid.json`.")
    lines.append("")
    lines.append("## Structural checks on the generated grammar")
    lines.append("")
    lines.append("| Check | Result |")
    lines.append("|---|---|")
    for name, ok, _ in checks:
        lines.append(f"| `{name}` | {'PASS' if ok else 'FAIL'} |")
    lines.append("")
    for name, ok, detail in checks:
        lines.append(f"- **{name}** — {'PASS' if ok else 'FAIL'}. {detail}")
    lines.append("")
    lines.append("## The corpus")
    lines.append("")
    lines.append("| Case | Expect schema | Schema | Expect grammar | Grammar | |")
    lines.append("|---|---|---|---|---|---|")
    for r in results:
        lines.append(
            f"| `{r['name']}` | {r['expect_schema']} | {r['schema']} | "
            f"{r['expect_grammar']} | {r['grammar']} | "
            f"{'ok' if r['ok'] else '**MISMATCH**'} |")
    div = [r for r in results if r["family"] == "divergent"]
    lines.append("")
    lines.append(f"{len(results)} cases: "
                 f"{sum(1 for r in results if r['family'] == 'accept')} accepted "
                 f"by both, {sum(1 for r in results if r['family'] == 'reject')} "
                 f"rejected by both, {len(div)} divergent.")
    if div:
        lines.append("")
        lines.append("### Divergences (recorded, not failures)")
        lines.append("")
        for r in div:
            lines.append(f"- **`{r['name']}`** — schema {r['schema']}, "
                         f"grammar {r['grammar']}. {r['why']}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Check schema_sid.json and its llama.cpp grammar against "
                    "one accepted/rejected corpus.")
    ap.add_argument("--emit-grammar", action="store_true",
                    help="print the generated GBNF and exit")
    ap.add_argument("--verify-vendor", action="store_true",
                    help="check the vendored converter's hash and exit")
    ap.add_argument("--out-md", type=Path, default=None,
                    help="also write the report to this markdown path")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    vendor_ok, vendor_note = verify_vendor()
    if not vendor_ok:
        print(f"FATAL: {vendor_note}", file=sys.stderr)
        return 2
    if args.verify_vendor:
        print(vendor_note)
        return 0

    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    gbnf_text = generate_grammar(schema)
    if args.emit_grammar:
        print(gbnf_text)
        return 0

    # Nothing below this line means anything if the recognizer is broken.
    selftest = selftest_recognizer()
    if selftest:
        print("FATAL: the GBNF recognizer is wrong, so no verdict it produces "
              "can be trusted:", file=sys.stderr)
        for line in selftest:
            print(f"  - {line}", file=sys.stderr)
        return 2

    grammar = Gbnf(gbnf_text)
    checks = structural_checks(grammar, schema)
    results = run_corpus(load_corpus(), schema, grammar)

    text = report(results, checks, grammar, vendor_note)
    if args.out_md:
        args.out_md.write_text(text + "\n", encoding="utf-8")
    if not args.quiet:
        print(text)

    failed_checks = [n for n, ok, _ in checks if not ok]
    mismatches = [r["name"] for r in results if not r["ok"]]
    if failed_checks or mismatches:
        print(f"\nFAIL: structural {failed_checks}, corpus {mismatches}",
              file=sys.stderr)
        return 1
    if not args.quiet:
        print(f"\nOK: {len(checks)} structural checks, {len(results)} corpus "
              f"cases, every verdict as recorded.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
