"""Local Memory Curator benchmark runner.

Drives one candidate model over a directory of ExperienceUnits via the local
Ollama HTTP API using structured outputs (`format: <schema>`), and records
everything the scorer needs: raw response, parse status, wall-time, and
periodic RAM samples from `ollama ps`.

Design notes:
  - Structured outputs. We pass the proposal schema as `format`, so llama.cpp
    constrains decoding to the grammar. That makes "invalid JSON" nearly
    impossible and moves the failure mode to *degenerate* output (`{}`-ish,
    or an empty proposals array on a unit that clearly has content). We
    therefore record `degenerate` separately from `parse_error`.
  - think:false. Qwen3 reasons before answering, which under a JSON grammar
    reproducibly burns the budget and can collapse to an empty object. Ollama
    0.30+ accepts a top-level `think` boolean on /api/chat. `--think auto`
    sends `think: false` for known thinking-capable families and omits the
    field otherwise; if the server rejects it we retry once without it, so a
    model that has never heard of thinking still runs.
  - Cold vs warm. One cold load is measured on purpose (unload via
    keep_alive:0, then time the first call) and written to cold_load.json.
    Every benchmarked unit then runs warm with keep_alive held open, so the
    per-unit latency distribution is not polluted by a one-off model load.
  - Idempotent. A unit whose result file already exists is skipped, so an
    interrupted run resumes. `--force` re-runs everything.
  - Never crash. Timeouts, HTTP errors and malformed bodies are recorded as
    a result row with a status, never raised. A 4-hour sweep must not die on
    unit 37.

Usage:
    python eval/curator/run_bench.py --model qwen3:1.7b \
        --units-dir eval/curator/units --out eval/curator/results/qwen3-1.7b

Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

HERE = Path(__file__).parent
DEFAULT_SCHEMA = HERE / "schema.json"
DEFAULT_PROMPT = HERE / "prompts" / "extract.txt"
DEFAULT_HOST = "http://localhost:11434"

# Placeholder in the prompt template that receives the unit text. If a
# template lacks it we append the transcript instead of silently sending a
# prompt with no data.
UNIT_PLACEHOLDER = "{{UNIT_TEXT}}"

# Families that reason before answering and therefore need `think: false`.
# Matched case-insensitively as substrings of the model name.
THINKING_FAMILIES = ("qwen3", "deepseek-r1", "magistral", "granite3.2", "cogito")

# Sample `ollama ps` every N units. It shells out, so we do not do it per unit.
PS_SAMPLE_EVERY = 10
# Consecutive transport failures that abort the sweep. A model can be slow
# (timeout) or wrong (parse_error) many times in a row, but it cannot be
# unreachable three times in a row unless the server itself is gone.
TRANSPORT_ABORT_AFTER = 3


# --------------------------------------------------------------------------
# unit loading
# --------------------------------------------------------------------------

def _text_from_obj(obj: Any) -> str | None:
    """Pull transcript text out of whatever shape a unit JSON happens to be.

    The unit builder is owned by another agent, so we accept the plausible
    shapes rather than hard-coding one: a bare string, a dict with a text-ish
    key, or a list of chat messages.
    """
    if isinstance(obj, str):
        return obj
    if isinstance(obj, list):
        parts = []
        for m in obj:
            if isinstance(m, dict) and "content" in m:
                role = m.get("role", "user")
                parts.append(f"{role}: {m['content']}")
            elif isinstance(m, str):
                parts.append(m)
        return "\n".join(parts) if parts else None
    if isinstance(obj, dict):
        for key in ("text", "unit_text", "content", "transcript", "body"):
            v = obj.get(key)
            if isinstance(v, str) and v.strip():
                return v
        for key in ("messages", "turns", "conversation"):
            v = obj.get(key)
            if isinstance(v, list):
                got = _text_from_obj(v)
                if got:
                    return got
    return None


def load_units(units_dir: Path) -> list[dict[str, Any]]:
    """Load units from a directory of .txt / .json / .jsonl files.

    Returns [{id, text, path}] sorted by id. A unit whose text cannot be
    found is skipped with a warning rather than aborting the run.
    """
    units: list[dict[str, Any]] = []
    if not units_dir.is_dir():
        return units

    for path in sorted(units_dir.iterdir()):
        if path.name.startswith(".") or not path.is_file():
            continue
        suffix = path.suffix.lower()
        if suffix not in (".txt", ".json", ".jsonl", ".md"):
            continue

        stem = path.stem
        if stem.startswith("unit_"):
            stem = stem[len("unit_"):]

        try:
            raw = path.read_text(encoding="utf-8")
        except OSError as exc:
            print(f"  ! unreadable unit {path.name}: {exc}", file=sys.stderr)
            continue

        if suffix == ".jsonl":
            # A whole file of units, one per line.
            for i, line in enumerate(raw.splitlines()):
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                text = _text_from_obj(obj)
                if not text:
                    continue
                uid = str(obj.get("id") or f"{stem}-{i:03d}") if isinstance(obj, dict) else f"{stem}-{i:03d}"
                units.append({"id": uid, "text": text, "path": str(path)})
            continue

        if suffix == ".json":
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError as exc:
                print(f"  ! bad JSON unit {path.name}: {exc}", file=sys.stderr)
                continue
            text = _text_from_obj(obj)
            if isinstance(obj, dict):
                # Prefer an id the unit file declares over the filename, so
                # results and gold key off the same string.
                for id_key in ("unit_id", "id"):
                    if obj.get(id_key):
                        stem = str(obj[id_key])
                        break
        else:
            text = raw

        if not text or not text.strip():
            print(f"  ! empty unit {path.name}, skipped", file=sys.stderr)
            continue
        units.append({"id": stem, "text": text, "path": str(path)})

    units.sort(key=lambda u: u["id"])
    return units


# --------------------------------------------------------------------------
# ollama
# --------------------------------------------------------------------------

def ollama_ps() -> list[dict[str, str]]:
    """Snapshot `ollama ps` so we can report resident size per model.

    Best-effort: returns [] if the CLI is missing or the output is odd. RAM
    numbers are nice-to-have, never a reason to fail a run.
    """
    try:
        out = subprocess.run(
            ["ollama", "ps"], capture_output=True, text=True, timeout=15
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    lines = [ln for ln in out.splitlines() if ln.strip()]
    if len(lines) < 2:
        return []
    rows = []
    for ln in lines[1:]:
        # NAME ID SIZE PROCESSOR CONTEXT UNTIL -- whitespace-separated, and
        # SIZE/UNTIL contain spaces, so split loosely and keep the raw line.
        cols = re.split(r"\s{2,}", ln.strip())
        rows.append({"raw": ln.strip(), "name": cols[0] if cols else "", "cols": cols})
    return rows


def unload_model(host: str, model: str) -> None:
    """Evict the model so the next call pays a genuine cold load."""
    body = {"model": model, "messages": [], "keep_alive": 0}
    try:
        req = urllib.request.Request(
            f"{host}/api/chat", json.dumps(body).encode(), {"Content-Type": "application/json"}
        )
        urllib.request.urlopen(req, timeout=60).read()
    except Exception:
        pass
    time.sleep(1.0)


def build_body(
    model: str, prompt: str, schema: dict, think: bool | None, keep_alive: str, num_ctx: int
) -> dict:
    body: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "format": schema,
        "options": {"temperature": 0, "num_ctx": num_ctx},
        "keep_alive": keep_alive,
    }
    if think is not None:
        body["think"] = think
    return body


def call_ollama(
    host: str, body: dict, timeout: int
) -> tuple[str, dict[str, Any], float]:
    """POST /api/chat. Returns (status, payload, elapsed_seconds).

    status is one of: ok | timeout | http_error | transport_error | bad_body.
    Never raises.
    """
    started = time.time()
    try:
        req = urllib.request.Request(
            f"{host}/api/chat", json.dumps(body).encode(), {"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
        elapsed = time.time() - started
        try:
            return "ok", json.loads(raw), elapsed
        except json.JSONDecodeError as exc:
            return "bad_body", {"error": str(exc), "raw": raw[:4000]}, elapsed
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:1000]
        except Exception:
            pass
        return "http_error", {"code": exc.code, "error": detail}, time.time() - started
    except TimeoutError:
        return "timeout", {"error": f"exceeded {timeout}s"}, time.time() - started
    except urllib.error.URLError as exc:
        reason = str(exc.reason)
        status = "timeout" if "timed out" in reason.lower() else "transport_error"
        return status, {"error": reason}, time.time() - started
    except Exception as exc:  # noqa: BLE001 - a runner must never die
        return "transport_error", {"error": f"{type(exc).__name__}: {exc}"}, time.time() - started


def resolve_think(model: str, mode: str) -> bool | None:
    if mode == "true":
        return True
    if mode == "false":
        return False
    if mode == "omit":
        return None
    lowered = model.lower()
    return False if any(f in lowered for f in THINKING_FAMILIES) else None


# --------------------------------------------------------------------------
# per-unit execution
# --------------------------------------------------------------------------

def classify(payload: dict, status: str) -> dict[str, Any]:
    """Turn a raw Ollama response into parse status + parsed proposals.

    Distinguishes three failure shapes that mean very different things:
      parse_error  -- content was not JSON (should be ~impossible under a grammar)
      degenerate   -- valid JSON but carries no signal at all ({} / missing keys)
      empty        -- well-formed abstention (proposals: [], nothing_durable set)
    """
    if status != "ok":
        return {"parse_status": status, "parsed": None, "content": None}

    msg = payload.get("message") or {}
    content = msg.get("content")
    thinking = msg.get("thinking") or ""
    if not isinstance(content, str):
        return {"parse_status": "no_content", "parsed": None, "content": None,
                "thinking_chars": len(thinking)}

    stripped = content.strip()
    if not stripped:
        return {"parse_status": "degenerate", "parsed": None, "content": content,
                "degenerate_reason": "empty_string", "thinking_chars": len(thinking)}

    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError as exc:
        return {"parse_status": "parse_error", "parsed": None, "content": content,
                "error": str(exc), "thinking_chars": len(thinking)}

    if not isinstance(parsed, dict):
        return {"parse_status": "degenerate", "parsed": None, "content": content,
                "degenerate_reason": "not_an_object", "thinking_chars": len(thinking)}

    has_proposals = "proposals" in parsed
    has_flag = "nothing_durable" in parsed
    if not has_proposals and not has_flag:
        # The classic Qwen3-under-grammar collapse: `{}`.
        return {"parse_status": "degenerate", "parsed": parsed, "content": content,
                "degenerate_reason": "no_schema_keys", "thinking_chars": len(thinking)}

    proposals = parsed.get("proposals")
    if not isinstance(proposals, list):
        return {"parse_status": "degenerate", "parsed": parsed, "content": content,
                "degenerate_reason": "proposals_not_a_list", "thinking_chars": len(thinking)}

    # Incoherent abstention: the model claimed "nothing durable" while also
    # emitting proposals. Observed on qwen3:1.7b. Not fatal -- we keep the
    # proposals and let the scorer count the incoherence.
    incoherent = bool(parsed.get("nothing_durable")) and len(proposals) > 0

    return {
        "parse_status": "ok",
        "parsed": parsed,
        "content": content,
        "n_proposals": len(proposals),
        "nothing_durable": bool(parsed.get("nothing_durable")),
        "incoherent_abstention": incoherent,
        "thinking_chars": len(thinking),
    }


def render_unit_text(
    unit: dict, render: str, max_sentences: int
) -> tuple[str, dict[str, Any]]:
    """The transcript body the prompt receives, plus what that rendering cost.

    `raw` (default) is the unit exactly as build_units.py wrote it -- both the
    quote and the anchor contract point into that text, so their behaviour is
    untouched by this function existing.

    `sid` is the SENTENCE-ID contract: the same enumeration `verify_sid.py`
    resolves against, rendered as `S{n} [{role}]: text`. Imported from `sid.py`
    rather than reimplemented -- a prompt and a verifier that enumerate
    sentences differently would grade the wrong sentence while agreeing on the
    label, which is precisely the failure the ID contract exists to remove.
    """
    if render != "sid":
        return unit["text"], {}
    import sid as sidmod  # local: only the sid contract needs it

    table = sidmod.enumerate_unit(unit["text"], max_sentences=max_sentences)
    return sidmod.render_unit(unit["text"], table), {
        "render": "sid",
        "segmenter_harness_version": sidmod.SEGMENTER_HARNESS_VERSION,
        "n_sentences": len(table["sentences"]),
        "n_records": table["n_records"],
        "dropped_over_sentence_cap": table["dropped_over_cap"],
    }


def run_unit(
    host: str, model: str, unit: dict, template: str, schema: dict,
    think: bool | None, keep_alive: str, num_ctx: int, timeout: int,
    render: str = "raw", max_sentences: int = 0,
) -> dict[str, Any]:
    body_text, render_meta = render_unit_text(unit, render, max_sentences)
    if UNIT_PLACEHOLDER in template:
        prompt = template.replace(UNIT_PLACEHOLDER, body_text)
    else:
        prompt = f"{template.rstrip()}\n\nTRANSCRIPT:\n{body_text}\nOUTPUT:\n"

    body = build_body(model, prompt, schema, think, keep_alive, num_ctx)
    status, payload, elapsed = call_ollama(host, body, timeout)

    # A model that has never heard of `think` returns 400. Retry once
    # without the field so the sweep covers non-thinking candidates too.
    think_used = think
    if status == "http_error" and think is not None:
        detail = str(payload.get("error", "")).lower()
        if "think" in detail or payload.get("code") == 400:
            body = build_body(model, prompt, schema, None, keep_alive, num_ctx)
            status, payload, elapsed = call_ollama(host, body, timeout)
            think_used = None

    row: dict[str, Any] = {
        "unit_id": unit["id"],
        "model": model,
        "status": status,
        "wall_seconds": round(elapsed, 3),
        "think": think_used,
        "prompt_chars": len(prompt),
        "unit_chars": len(unit["text"]),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    row.update(render_meta)
    row.update(classify(payload, status))

    if status == "ok":
        for k in ("total_duration", "load_duration", "prompt_eval_count", "eval_count"):
            if k in payload:
                row[k] = payload[k]
    else:
        row["error_payload"] = payload

    return row


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Run the curator benchmark for one model.")
    ap.add_argument("--model", required=True, help="Ollama model tag, e.g. qwen3:1.7b")
    ap.add_argument("--units-dir", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path, help="results/<model>/")
    ap.add_argument("--schema", type=Path, default=DEFAULT_SCHEMA)
    ap.add_argument("--prompt", type=Path, default=DEFAULT_PROMPT)
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--timeout", type=int, default=120, help="per-unit seconds")
    ap.add_argument("--keep-alive", default="30m")
    ap.add_argument("--num-ctx", type=int, default=8192)
    ap.add_argument("--think", choices=["auto", "true", "false", "omit"], default="auto")
    ap.add_argument("--render", choices=["raw", "sid"], default="raw",
                    help="how the transcript reaches the prompt. raw (default) = the "
                         "unit text as written, for the quote/anchor contracts. sid = "
                         "sentence-ID enumeration from sid.py ('S7 [user]: ...'); pair "
                         "it with --schema schema_sid.json --prompt prompts/extract_sid.txt "
                         "and verify with verify_sid.py")
    ap.add_argument("--max-sentences", type=int, default=0,
                    help="--render sid only: cap sentences per unit (0 = uncapped, the "
                         "harness default; the product caps at 150 and splits into "
                         "sub-units). verify_sid.py MUST be given the same value")
    ap.add_argument("--limit", type=int, default=0, help="only the first N units")
    ap.add_argument("--force", action="store_true", help="re-run units already present")
    ap.add_argument("--no-cold-load", action="store_true", help="skip the cold-load measurement")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    try:
        schema = json.loads(args.schema.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"FATAL: cannot read schema {args.schema}: {exc}", file=sys.stderr)
        return 2
    # `$schema`/`title` are meta keys; llama.cpp's grammar converter ignores
    # them but there is no reason to ship them over the wire.
    wire_schema = {k: v for k, v in schema.items() if k not in ("$schema", "title")}

    try:
        template = args.prompt.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"FATAL: cannot read prompt {args.prompt}: {exc}", file=sys.stderr)
        return 2

    units = load_units(args.units_dir)
    if not units:
        print(f"FATAL: no units found in {args.units_dir}", file=sys.stderr)
        return 2
    if args.limit:
        units = units[: args.limit]

    args.out.mkdir(parents=True, exist_ok=True)
    units_out = args.out / "units"
    units_out.mkdir(exist_ok=True)

    think = resolve_think(args.model, args.think)
    log = (lambda *a: None) if args.quiet else print

    log(f"model={args.model}  units={len(units)}  think={think}  "
        f"render={args.render}  out={args.out}")

    # --- cold load, measured once and kept out of the warm distribution ----
    cold: dict[str, Any] | None = None
    cold_path = args.out / "cold_load.json"
    if not args.no_cold_load and (args.force or not cold_path.exists()):
        log("  measuring cold load (unloading model first) ...")
        unload_model(args.host, args.model)
        probe = {"id": "__cold__", "text": "user: hello\nassistant: hi\n"}
        cold = run_unit(
            args.host, args.model, probe, template, wire_schema,
            think, args.keep_alive, args.num_ctx, args.timeout,
            args.render, args.max_sentences,
        )
        cold["ollama_ps"] = ollama_ps()
        cold_path.write_text(json.dumps(cold, indent=2), encoding="utf-8")
        log(f"  cold load: {cold['wall_seconds']}s (status={cold['status']})")
    elif cold_path.exists():
        # Already measured on an earlier (possibly interrupted) run. Carry it
        # forward so a resumed sweep does not report cold load as unknown.
        try:
            cold = json.loads(cold_path.read_text(encoding="utf-8"))
            log(f"  cold load: {cold.get('wall_seconds')}s (cached)")
        except (OSError, json.JSONDecodeError):
            cold = None

    # --- warm sweep -------------------------------------------------------
    started = time.time()
    ran = skipped = 0
    transport_errors = 0
    consecutive_transport = 0
    aborted = False
    ps_samples: list[dict[str, Any]] = []

    for i, unit in enumerate(units):
        dest = units_out / f"unit_{unit['id']}.json"
        if dest.exists() and not args.force:
            # A written row only counts as done if the request actually reached
            # the model. Infrastructure rows (transport_error, http_error,
            # bad_body, timeout) are not results — a resumed sweep re-runs them
            # instead of silently keeping a dead server's rows.
            try:
                prev = json.loads(dest.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                prev = None
            if prev is not None and prev.get("status") == "ok":
                skipped += 1
                continue

        row = run_unit(
            args.host, args.model, unit, template, wire_schema,
            think, args.keep_alive, args.num_ctx, args.timeout,
            args.render, args.max_sentences,
        )
        dest.write_text(json.dumps(row, indent=2), encoding="utf-8")
        ran += 1

        if row.get("status") == "transport_error":
            transport_errors += 1
            consecutive_transport += 1
        else:
            consecutive_transport = 0
        if consecutive_transport >= TRANSPORT_ABORT_AFTER:
            aborted = True
            print(
                f"FATAL: {consecutive_transport} consecutive transport errors — "
                f"the server at {args.host} is unreachable. Aborting the sweep "
                f"so a dead server is never recorded as model output. The "
                f"failed rows re-run automatically on the next invocation.",
                file=sys.stderr,
            )
            break

        if i % PS_SAMPLE_EVERY == 0:
            snap = {"after_unit": unit["id"], "rows": ollama_ps()}
            ps_samples.append(snap)
            row["ollama_ps"] = snap["rows"]
            dest.write_text(json.dumps(row, indent=2), encoding="utf-8")

        if not args.quiet:
            note = row.get("parse_status", row["status"])
            n = row.get("n_proposals", "-")
            print(f"  [{i+1}/{len(units)}] {unit['id']}: {note} "
                  f"n={n} {row['wall_seconds']}s")

    meta = {
        "model": args.model,
        "units_dir": str(args.units_dir),
        "n_units": len(units),
        "ran": ran,
        "skipped_existing": skipped,
        # complete | aborted_transport — score.py refuses aborted sweeps.
        "status": "aborted_transport" if aborted else "complete",
        "transport_errors": transport_errors,
        "think_setting": args.think,
        "think_sent": think,
        "options": {"temperature": 0, "num_ctx": args.num_ctx},
        "keep_alive": args.keep_alive,
        "timeout_seconds": args.timeout,
        "schema_path": str(args.schema),
        "prompt_path": str(args.prompt),
        # The contract this sweep ran. verify_sid.py must be given the same
        # --max-sentences, or it would resolve IDs against a different table.
        "render": args.render,
        "max_sentences": args.max_sentences,
        "host": args.host,
        "cold_load_seconds": (cold or {}).get("wall_seconds"),
        "ps_samples": ps_samples,
        "sweep_seconds": round(time.time() - started, 2),
        "finished": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    (args.out / "run_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    log(f"done: ran={ran} skipped={skipped} in {meta['sweep_seconds']}s")
    return 3 if aborted else 0


if __name__ == "__main__":
    raise SystemExit(main())
