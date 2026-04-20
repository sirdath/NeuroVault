"""Long-memory benchmark — LoCoMo-style multi-session recall.

IMPORTANT: the bench spins up a dedicated, isolated brain for its run
(``BrainBench``) so it never writes into the user's production brain.
The original active brain is restored — and the bench brain is deleted
— before the process exits, even on error. If you see any
``bench-longmem-*`` or ``BrainBench`` leftovers, that's a bug to fix.



Inspired by the LoCoMo paper (Bae et al. 2024) and Mem0's LoCoMo
evaluation setup. The question LoCoMo asks:

    *Given a long multi-session chat history where a specific fact is
    mentioned only once several sessions ago, can the memory system
    retrieve it when needed?*

This bench doesn't download the proprietary LoCoMo dataset — it builds
a synthetic equivalent so the test is reproducible for anyone running
a local NeuroVault server. The structure mirrors LoCoMo:

    N sessions × K turns each, with ONE "ground-truth" fact buried in
    each session. After all sessions are ingested, we ask a probe
    question whose correct answer is a fact from an earlier session
    and check whether that session's engram surfaces in the top-k
    recall hits.

Reported metrics:
    • hit@1     — top-1 accuracy
    • hit@5     — at-least-one-correct-in-top-5 accuracy
    • MRR       — mean reciprocal rank of the correct engram
    • avg_tokens_returned — how many tokens came back in total

Run with the server up:
    python benchmarks/bench_longmemory.py
"""

from __future__ import annotations

import json
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

SERVER = "http://127.0.0.1:8765"
SESSION_PREFIX = "bench-longmem"
BENCH_BRAIN_NAME = "BrainBench"


# --- Synthetic multi-session chat corpus ---------------------------------
# Each "session" is a single note ingested into the brain, simulating a
# conversation where ONE key fact is worth remembering. The distractor
# filler is deliberately boring small-talk to make recall hard.

@dataclass
class Probe:
    session_idx: int  # which session held the ground-truth fact
    question: str     # how the fact gets asked later
    keywords: list[str] = field(default_factory=list)  # substrings a correct answer must contain


CORPUS: list[tuple[str, Probe]] = [
    (
        "Mid-morning standup. Sam mentioned the on-call rotation is swapping "
        "so Priya covers next weekend instead of me. Otherwise normal sprint "
        "chatter about tickets and lunch.",
        Probe(0, "Who's on-call next weekend?", ["Priya"]),
    ),
    (
        "Long design review. Lots of bikeshedding on the button copy. Main "
        "outcome: we're moving the staging database off Heroku onto Fly.io "
        "in the iad region by end of the month.",
        Probe(1, "Where is staging being deployed?", ["Fly.io", "iad"]),
    ),
    (
        "Watched a Karpathy video on his personal wiki. Interesting pattern: "
        "three layers — raw notes, wiki, schema. Noting it down for reference.",
        Probe(2, "What three layers does Karpathy's personal wiki use?",
              ["raw", "wiki", "schema"]),
    ),
    (
        "Coffee chat with Alex. He mentioned his brother just moved to Porto "
        "and is loving the seafood. Nothing work-related came out of this one.",
        Probe(3, "Where did Alex's brother move to?", ["Porto"]),
    ),
    (
        "Security review: we agreed to rotate the Stripe API keys quarterly "
        "from now on. Reminder set for the last Friday of each quarter.",
        Probe(4, "How often do we rotate Stripe API keys?",
              ["quarter"]),
    ),
    (
        "Random friday afternoon. Ordered pizza. Noticed the PDF exporter is "
        "dropping the first blank page if a document starts with a heading.",
        Probe(5, "What bug did we spot in the PDF exporter?",
              ["blank", "heading"]),
    ),
    (
        "New contractor onboarded: Yuki Tanaka, working 20 hours a week on "
        "frontend polish. Starts Monday. IT needs to provision access.",
        Probe(6, "Who is the new frontend contractor?", ["Yuki"]),
    ),
    (
        "Debugging session. Found the weird timezone bug — the server was "
        "using UTC but cron entries were written in local time. Fix ships "
        "in v2.4.1.",
        Probe(7, "Which version fixes the timezone cron bug?", ["2.4.1"]),
    ),
    (
        "Budget meeting. Next quarter we can only spend on infra or marketing, "
        "not both. Leadership is leaning infra because the latency dashboards "
        "look bad during EU peak hours.",
        Probe(8, "What is next quarter's spending priority?",
              ["infra"]),
    ),
    (
        "Client call with Revolut. Pavel wants a two-minute demo focused on "
        "multi-brain and the compiler. He won't care about theming — keep it "
        "tight.",
        Probe(9, "What does Pavel want to see in the Revolut demo?",
              ["multi-brain", "compiler"]),
    ),
]


# --- HTTP helpers --------------------------------------------------------

def _post(path: str, body: dict, timeout: float = 60.0) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{SERVER}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _delete(path: str, timeout: float = 30.0) -> dict | None:
    req = urllib.request.Request(f"{SERVER}{path}", method="DELETE")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode()
        return json.loads(body) if body else None


def _get(path: str, timeout: float = 60.0) -> dict | list:
    with urllib.request.urlopen(f"{SERVER}{path}", timeout=timeout) as resp:
        return json.loads(resp.read().decode())


# --- Brain isolation helpers ---------------------------------------------

def _active_brain_id() -> str:
    """Return the currently active brain's id so we can restore it later."""
    data = _get("/api/brains/active")
    return data["brain_id"]  # type: ignore[index]


def _create_and_activate_bench_brain() -> str:
    """Create the isolated bench brain, activate it, and return its id.

    If a brain with the bench name already exists (from a previous
    crashed run), reuse it — better than minting a new one each time
    and leaving stale brains on disk.
    """
    brains = _get("/api/brains")
    existing = next((b for b in brains if b.get("name") == BENCH_BRAIN_NAME), None)  # type: ignore[union-attr]
    if existing:
        brain_id = existing["brain_id"]
    else:
        created = _post("/api/brains", {
            "name": BENCH_BRAIN_NAME,
            "description": "Ephemeral brain for bench_longmemory.py — deleted at end of run.",
        })
        if "error" in created:
            raise RuntimeError(f"failed to create bench brain: {created['error']}")
        brain_id = created["brain_id"]

    _post(f"/api/brains/{brain_id}/activate", {})
    # Give the brain a moment to become the active context on the server.
    time.sleep(1.0)
    return brain_id


def _restore_and_cleanup(original_brain_id: str, bench_brain_id: str) -> None:
    """Switch back to the original brain, then delete the bench brain."""
    try:
        _post(f"/api/brains/{original_brain_id}/activate", {})
        time.sleep(0.5)
    except Exception as e:
        print(f"WARN: failed to reactivate original brain {original_brain_id}: {e}")
    try:
        _delete(f"/api/brains/{bench_brain_id}")
    except Exception as e:
        print(f"WARN: failed to delete bench brain {bench_brain_id}: {e}")


# --- The bench ----------------------------------------------------------

def seed_corpus(shuffle: bool = True) -> list[str]:
    """Ingest each session as a note. Returns the engram IDs in order of
    session_idx so probes can map back to the expected correct engram."""
    items = list(enumerate(CORPUS))
    if shuffle:
        # Shuffle the ingest order so the benchmark doesn't accidentally
        # reward recency — the correct answer may be the oldest note.
        r = random.Random(42)
        r.shuffle(items)

    ids_by_idx: dict[int, str] = {}
    for idx, (content, _probe) in items:
        title = f"{SESSION_PREFIX}-session-{idx:02d}"
        resp = _post("/api/notes", {"title": title, "content": content})
        if "engram_id" in resp:
            ids_by_idx[idx] = resp["engram_id"]
        elif "id" in resp:
            ids_by_idx[idx] = resp["id"]
        # Pace the POSTs — the server runs the slow phase on a single
        # worker and hammering it faster than it can drain causes the
        # SQLite connection to back up and occasionally time out.
        time.sleep(0.5)
    # Let any straggling async slow-phase work finish so embeddings +
    # entity links land before we probe.
    time.sleep(5.0)
    return [ids_by_idx[i] for i in range(len(CORPUS))]


def run_probes(engram_ids: list[str], topk: int = 5) -> dict:
    hits_at_1 = 0
    hits_at_k = 0
    mrr_total = 0.0
    tokens_total = 0
    rows = []

    for session_idx, (_content, probe) in enumerate(CORPUS):
        correct_id = engram_ids[probe.session_idx]
        q = urllib.parse.quote(probe.question)
        try:
            # Use preview mode so results come back with a reasonable payload
            # and we can also measure returned-token volume.
            result = _get(f"/api/recall?q={q}&limit={topk}&mode=preview")
        except urllib.error.URLError as e:
            print(f"recall failed for probe '{probe.question}': {e}")
            continue

        items = result if isinstance(result, list) else result.get("results", [])
        tokens_total += sum(len((r.get("preview") or "").split()) for r in items)
        ids = [r.get("engram_id") or r.get("id") for r in items]

        rank = next((i + 1 for i, rid in enumerate(ids) if rid == correct_id), 0)
        if rank == 1:
            hits_at_1 += 1
        if 1 <= rank <= topk:
            hits_at_k += 1
            mrr_total += 1.0 / rank

        rows.append({
            "session": session_idx,
            "question": probe.question,
            "rank": rank or "miss",
            "returned_ids": ids[:3],
        })

    n = len(CORPUS)
    return {
        "n_probes": n,
        "hit@1": hits_at_1 / n,
        f"hit@{topk}": hits_at_k / n,
        "mrr": mrr_total / n,
        "avg_tokens_returned": tokens_total / max(1, n),
        "detail": rows,
    }


def main():
    print("== NeuroVault long-memory bench (LoCoMo-style) ==\n")
    original_brain = _active_brain_id()
    print(f"Active brain before bench: {original_brain}")
    bench_brain = _create_and_activate_bench_brain()
    print(f"Bench brain (isolated)   : {bench_brain}\n")

    try:
        print(f"Seeding {len(CORPUS)} sessions into {SERVER} …")
        ids = seed_corpus()

        print("Running probes (top-5) …")
        report = run_probes(ids, topk=5)

        print()
        print(f"  hit@1               : {report['hit@1']:.2%}")
        print(f"  hit@5               : {report['hit@5']:.2%}")
        print(f"  MRR                 : {report['mrr']:.3f}")
        print(f"  avg tokens returned : {report['avg_tokens_returned']:.0f}")
        print()
        print("Per-probe detail:")
        for row in report["detail"]:
            print(f"  session {row['session']:>2}  rank={row['rank']!s:>4}  q={row['question']}")

        print()
        print(json.dumps({k: v for k, v in report.items() if k != "detail"}, indent=2))
    finally:
        # Always restore even if the bench crashed mid-run — we don't
        # want the user stranded on the bench brain with a half-seeded
        # corpus in place of their real notes.
        print(f"\nRestoring original brain ({original_brain}) and deleting bench brain …")
        _restore_and_cleanup(original_brain, bench_brain)


if __name__ == "__main__":
    main()
