//! Retrieval integration test — the fast regression gate.
//!
//! WHY THIS EXISTS
//! ---------------
//! The 64 unit tests are order-polluted: cargo runs them in parallel,
//! they share the global brain cache + embedder singleton + temp dirs,
//! so exactly one test fails per full-suite run and *which* one is
//! non-deterministic. They cannot gate a retrieval change.
//!
//! The bench (LongMemEval) is a real gate but costs $5 (50-Q) to $50
//! (500-Q) and 30 min to 8 hr. Too slow/expensive to run on every edit.
//!
//! This sits between: a fixed 12-engram fixture, a handful of recall
//! queries, asserting the expected engram lands in the top-K. Runs in
//! well under 60 s (the only slow part is the one-time ONNX model load,
//! ~2-7 s). Catches the class of regression that matters: "a scoring
//! change silently stopped the obviously-right answer from ranking."
//!
//! THE ORACLE PROBLEM (discovered 2026-05-17)
//! ------------------------------------------
//! `recency_factor` in the scorer is wall-clock dependent (`age_days`
//! uses `now()`), so raw recall scores DRIFT minute-to-minute with zero
//! code change. Exact-score comparison across time is therefore an
//! invalid oracle. Every query here passes `ablate=recency`, which
//! removes the wall-clock term and makes recall byte-identical
//! run-to-run (verified). Assertions are on rank/membership, never on
//! absolute score values.
//!
//! ISOLATION
//! ---------
//! A single #[test] fn (no parallel env-var race). It points
//! `NEUROVAULT_HOME` at a unique temp dir, so it never touches a real
//! brain and leaves no residue in `~/.neurovault`.

use std::path::PathBuf;
use std::sync::Arc;

use neurovault_lib::memory::{db, ingest, retriever};
use neurovault_lib::memory::retriever::RecallOpts;

/// Fixed corpus. Each tuple is (filename, markdown). Content is written
/// so each query below has exactly one obviously-correct answer that a
/// working retriever MUST rank #1 — and a couple of plausible
/// distractors so the test fails if ranking degrades to "any vaguely
/// related doc."
fn fixture() -> Vec<(&'static str, &'static str)> {
    vec![
        (
            "shampoo.md",
            "# Hair care\n\nI switched to Trader Joe's tea tree tingle \
             shampoo last month. The lavender one irritated my scalp so \
             I stopped using it.",
        ),
        (
            "car-service.md",
            "# New car\n\nFirst service on the new Civic was March 15. \
             A week later the GPS unit failed completely and the \
             dealership had to replace the whole head unit under warranty.",
        ),
        (
            "db-decision.md",
            "# Architecture decision\n\nWe decided to use sqlite-vec for \
             the embedding store instead of Chroma. Reasons: single-file, \
             no server process, ships inside the Tauri binary.",
        ),
        (
            "team.md",
            "# Team\n\nSarah runs the weekly engineering sync on Tuesdays. \
             She owns the retrieval pipeline and the bench harness.",
        ),
        (
            "hmtops.md",
            "# Wardrobe\n\nUpdate: I now own five tops from H&M after the \
             two I bought at the weekend sale. Earlier I only had three.",
        ),
        (
            "coffee.md",
            "# Morning routine\n\nI grind Ethiopian Yirgacheffe beans and \
             pull a 1:2 ratio espresso every morning. No milk.",
        ),
        (
            "rust-port.md",
            "# Migration\n\nThe Python memory server was deleted; the Rust \
             backend now owns ingest and retrieval end to end.",
        ),
        (
            "guitar.md",
            "# Music\n\nFor electric guitar I strongly prefer a Fender \
             Stratocaster over a Gibson Les Paul — lighter body, snappier \
             neck, cleaner single-coil tone.",
        ),
        (
            "trip.md",
            "# Travel\n\nThe most recent family trip was to Lisbon in \
             April. Before that we went to the Lake District.",
        ),
        (
            "yoga.md",
            "# Health\n\nI take yoga classes at Serenity Yoga on Camden \
             High Street, Monday and Thursday evenings.",
        ),
        (
            "budget.md",
            "# Finances\n\nMonthly grocery budget is 400 pounds. I track \
             it in a spreadsheet and review it on the last Sunday.",
        ),
        (
            "book.md",
            "# Reading\n\nFinished 'The Nightingale' (440 pages). Started \
             'Project Hail Mary' next, currently on page 90.",
        ),
        // --- Improvement #2 fixture pair ---------------------------------
        // The proper noun "Sarah" is buried mid-note in a standup whose
        // title/topic is unrelated; the note shares almost no generic
        // query tokens (it says "decided"/"migration", not the query's
        // "decide"/"database"). This is the proper-noun-blind failure
        // case: the right answer carries the name but little surface
        // overlap.
        (
            "standup.md",
            "# Standup notes\n\nFriday standup ran long — status updates \
             on the deploy pipeline and the flaky CI runners took most \
             of it. Near the end Sarah decided we should defer the \
             storage-layer migration until after the security audit. \
             Action items were assigned and we wrapped up.",
        ),
        // Generic-token distractor: dense in the query's surface tokens
        // ("database", "decide") but carries NO proper noun. Without the
        // proper-noun boost this outranks the Sarah note for
        // "what did Sarah decide about the database".
        (
            "db-maint.md",
            "# Database maintenance\n\nWe decide the database vacuum \
             cadence quarterly. The database team will decide on new \
             database indexes next sprint, and database backups stay \
             nightly regardless of what we decide about retention.",
        ),
        // --- Improvement #3 fixture pair (numeric near-twins) ------------
        // Two notes identical in topic, differing only by the year — the
        // BGE-blind discriminator. Neutral "cycling log" theme, chosen so
        // none of its tokens collide with any existing probe or title
        // (verified: no probe query contains cycling/log/loops/gravel).
        (
            "mileage-2023.md",
            "# Cycling log\n\nIn 2023 I rode many long weekend loops and \
             logged plenty of miles on the gravel bike.",
        ),
        // Near-twin distractor: NO "2023", denser in the query's generic
        // tokens (many/loops) so without the numeric boost it outranks
        // the correct note for "how many loops did I ride in 2023".
        (
            "mileage-2024.md",
            "# Cycling log\n\nIn 2024 I rode many many long loops; many \
             weekend loops, loops and more loops on the gravel bike.",
        ),
        // --- Improvement #5 fixture (MMR diversification) ----------------
        // Five near-duplicate "session 1" paraphrases (identical title →
        // mutual title-embedding cosine 1.0) plus ONE distinct "session 2"
        // fact with a different title. All ~equally relevant to the probe
        // (the cluster has only a slim "status" keyword edge so it ranks
        // just above the distinct note pre-MMR — the genuine multi-session
        // shape, where paraphrases match equally and crowd out the other
        // session's fact). MMR should collapse the redundant cluster and
        // surface the distinct fact.
        (
            "atlas-a.md",
            "# Atlas project update\n\nThe Atlas status stayed steady \
             this period; nothing notable shifted and Atlas work \
             continued as planned.",
        ),
        (
            "atlas-b.md",
            "# Atlas project update\n\nAtlas status held steady — no \
             notable change, Atlas work proceeded as planned this \
             period.",
        ),
        (
            "atlas-c.md",
            "# Atlas project update\n\nNothing notable on Atlas; the \
             Atlas status was steady and work continued as planned.",
        ),
        (
            "atlas-d.md",
            "# Atlas project update\n\nAtlas work continued as planned, \
             Atlas status steady, nothing notable to flag this period.",
        ),
        (
            "atlas-e.md",
            "# Atlas project update\n\nThis period Atlas stayed steady; \
             Atlas status unchanged and work continued as planned.",
        ),
        // Distinct session-2 fact, different title (low title-emb cosine
        // to the cluster), NO "status" token (slightly lower pre-MMR
        // rank, but ~equally relevant via the shared "Atlas").
        (
            "atlas-roadmap.md",
            "# Atlas roadmap change\n\nThe Atlas team decided to retire \
             the legacy Atlas service and consolidate onto the new \
             stack.",
        ),
        // --- Improvement #4 fixture pair (fact supersession) ------------
        // Same fact stated twice over time. budget-old is ingested
        // BEFORE budget-new (vec order = ingest order), so write_facts
        // records 400 then supersedes it with 550. Both use revision
        // markers so both become `facts` rows; budget-new ends current,
        // budget-old superseded. The query asks for the CURRENT value.
        (
            "budget-old.md",
            "# Budget\n\nUpdate: grocery budget = 400 pounds. Reviewed \
             on the last Sunday as usual.",
        ),
        (
            "budget-new.md",
            "# Monthly review\n\nGood news this month — I bumped the \
             grocery budget to 550 pounds going forward.",
        ),
    ]
}

/// (query, must-rank-1 filename-stem). The expected engram is the one a
/// human would unambiguously pick. If a scoring change pushes the right
/// answer out of #1 on a recency-ablated query, this fails — which is
/// exactly the regression class we care about.
fn probes() -> Vec<(&'static str, &'static str)> {
    vec![
        ("what shampoo do I use", "shampoo"),
        ("what went wrong with the new car after its first service", "car-service"),
        ("which vector database did we choose", "db-decision"),
        ("who runs the weekly engineering sync", "team"),
        ("how many H&M tops do I own now", "hmtops"),
        ("which electric guitar do I prefer", "guitar"),
        ("where do I take yoga classes", "yoga"),
        ("where was our most recent family trip", "trip"),
        // Improvement #1 probe: the preference is ONE clause buried in
        // a long note whose title/topic is auth debugging. Without
        // preference extraction the code-search query competes with
        // the dominant debugging prose and the right answer is weak.
        // With it, a terse derived `kind=preference` engram
        // ("Preference: I always use ripgrep…") surfaces directly.
        ("what do I use for code search", "codesearch"),
    ]
}

/// A long, mixed-content note whose dominant topic is auth debugging.
/// The standing preference ("I always use ripgrep instead of grep for
/// code search") is a single buried clause — exactly the real-user
/// shape improvement #1 targets. Kept separate from `fixture()` so the
/// intent is obvious to a future reader.
const PREFERENCE_FIXTURE: (&str, &str) = (
    "auth-debug-session.md",
    "# Auth debugging session\n\nSpent most of the morning chasing a \
     token refresh bug in the OAuth flow. The refresh endpoint was \
     returning 401 because the clock skew check was too tight — fixed \
     it by widening the allowed drift to 90 seconds. While grepping \
     through the middleware I remembered: I always use ripgrep instead \
     of grep for code search, it's dramatically faster on this \
     monorepo and respects .gitignore by default. After that I rotated \
     the signing keys, updated the integration tests for the new drift \
     window, and wrote up the incident in the postmortem doc. Also \
     need to follow up with the platform team about the load balancer \
     idle timeout next week.",
);

#[test]
fn recall_ranks_known_facts_top1_recency_ablated() {
    // --- isolation: unique temp NEUROVAULT_HOME ---
    let home: PathBuf = std::env::temp_dir()
        .join(format!("nv-itest-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).expect("mk temp home");
    std::env::set_var("NEUROVAULT_HOME", &home);

    // The sqlite-vec extension ships at src-tauri/resources/vec0.<ext>,
    // with a per-platform suffix (dll on Windows, dylib on macOS, so on
    // Linux). When this test runs from target/<profile>/deps/ none of the
    // server's default candidate paths resolve, so point it explicitly.
    // CARGO_MANIFEST_DIR is the src-tauri crate root at test time.
    let vec0_file = if cfg!(target_os = "windows") {
        "vec0.dll"
    } else if cfg!(target_os = "macos") {
        "vec0.dylib"
    } else {
        "vec0.so"
    };
    let vec0 = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(vec0_file);
    assert!(
        vec0.exists(),
        "{vec0_file} missing at {vec0:?} — build resources are incomplete \
         (the macOS/Linux builds download it in CI; for a local run, fetch \
         the matching sqlite-vec loadable into src-tauri/resources/)"
    );
    std::env::set_var("NEUROVAULT_VEC_EXTENSION", &vec0);

    let brain_id = "itest-brain";
    // close_all() defends against a stale cached handle if this binary
    // somehow ran a prior brain (it doesn't today, but cheap insurance).
    db::close_all();
    let db: Arc<_> = db::open_brain(brain_id).expect("open brain");

    // --- ingest the fixed corpus ---
    for (fname, body) in fixture() {
        ingest::ingest_content(fname, body, &db)
            .unwrap_or_else(|e| panic!("ingest {fname} failed: {e}"));
    }
    // Improvement #1 fixture — ingest triggers preference extraction,
    // which writes a derived `pref-*` engram for the buried clause.
    ingest::ingest_content(PREFERENCE_FIXTURE.0, PREFERENCE_FIXTURE.1, &db)
        .unwrap_or_else(|e| panic!("ingest preference fixture failed: {e}"));
    // Chunk-window fixture (improvement #6): one long note whose
    // distinctive detail ("nondiegetic") sits ~char 2400 — past both the
    // 1200-char head window and the 2000-char document-chunk cap. The only
    // chunk carrying it is a late sentence window, so surfacing it depends
    // entirely on appending the matched chunk (the fix under test).
    let cw_body = chunk_window_fixture_body();
    ingest::ingest_content("param-reference.md", &cw_body, &db)
        .unwrap_or_else(|e| panic!("ingest chunk-window fixture failed: {e}"));

    // --- recency-ablated opts: deterministic oracle ---
    let opts = RecallOpts {
        top_k: 5,
        ablate: vec!["recency".to_string()],
        ..RecallOpts::default()
    };

    let mut failures: Vec<String> = Vec::new();
    for (query, expected_stem) in probes() {
        let hits = retriever::hybrid_retrieve(&db, query, &opts)
            .unwrap_or_else(|e| panic!("recall '{query}' failed: {e}"));
        if hits.is_empty() {
            failures.push(format!("'{query}': returned ZERO hits"));
            continue;
        }
        // Assert the expected doc is in the TOP 3 (recall@3), not
        // strictly #1. Rationale: with recency ablated the pipeline is
        // deterministic, but inter-document score gaps are often <0.001
        // (e.g. the H&M-tops probe sits 0.0008 behind a distractor).
        // Strict top-1 would make the gate fail on a baseline that's
        // actually fine, so it could never *measure* a regression from
        // green. recall@3 is the standard IR robustness metric: a real
        // regression (scoring signal broke, right answer falls off the
        // shortlist) drops the doc out of top-3 and trips this; near-tie
        // jitter between ranks 1-3 does not. The keyword is unique to
        // the correct doc so a top-3 hit is unambiguous, not luck.
        let kw = expected_keyword(expected_stem);
        let rank = hits.iter().take(3).position(|h| {
            h.title.to_lowercase().contains(expected_stem)
                || h.content.to_lowercase().contains(expected_stem)
                || h.content.to_lowercase().contains(kw)
        });
        if rank.is_none() {
            let got: Vec<String> = hits
                .iter()
                .take(3)
                .map(|h| format!("{} ({:.4})", first_line(&h.title), h.score))
                .collect();
            failures.push(format!(
                "'{query}': expected '{expected_stem}' in top-3, got {got:?}"
            ));
        }
    }

    // ----------------------------------------------------------------
    // Improvement #1 — clean deterministic A/B (non-confounded).
    //
    // The earlier bench comparison vs v1 is confounded (old Python
    // server, different corpus, noisy at 29 Qs). THIS is the
    // load-bearing keep/revert evidence: identical fixture, identical
    // query, recency ablated — the ONLY variable is preference
    // extraction. It proves the mechanism deterministically:
    //   ON  → a first-class `Preference:` engram exists and ranks top-3
    //         for the natural query.
    //   OFF → that engram does not exist; the buried clause stays
    //         diluted in an auth-debug note and no dedicated preference
    //         hit surfaces.
    // Same single #[test] fn, so the env toggle is sequential — no
    // parallel env-var race (see module ISOLATION note).
    // ----------------------------------------------------------------
    let ab_query = "what do I use for code search";
    let ab_opts = RecallOpts {
        top_k: 5,
        ablate: vec!["recency".to_string()],
        ..RecallOpts::default()
    };
    let build_and_probe = |bid: &str, disable: bool| -> Vec<(String, String)> {
        if disable {
            std::env::set_var("NEUROVAULT_DISABLE_PREFERENCE_EXTRACTION", "1");
        } else {
            std::env::remove_var("NEUROVAULT_DISABLE_PREFERENCE_EXTRACTION");
        }
        db::close_all();
        let bdb: Arc<_> = db::open_brain(bid).expect("open ab brain");
        for (fname, body) in fixture() {
            ingest::ingest_content(fname, body, &bdb)
                .unwrap_or_else(|e| panic!("ab ingest {fname}: {e}"));
        }
        ingest::ingest_content(PREFERENCE_FIXTURE.0, PREFERENCE_FIXTURE.1, &bdb)
            .unwrap_or_else(|e| panic!("ab ingest pref fixture: {e}"));
        let hits = retriever::hybrid_retrieve(&bdb, ab_query, &ab_opts)
            .unwrap_or_else(|e| panic!("ab recall failed: {e}"));
        hits.iter()
            .take(3)
            .map(|h| (h.title.to_lowercase(), h.content.to_lowercase()))
            .collect()
    };
    // A derived preference engram's body is "Preference: <sentence>".
    let is_pref_engram =
        |t: &str, c: &str| t.starts_with("preference:") || c.starts_with("preference:");

    let on_top3 = build_and_probe("itest-ab-on", false);
    let off_top3 = build_and_probe("itest-ab-off", true);
    // restore default before any later code / other test binaries
    std::env::remove_var("NEUROVAULT_DISABLE_PREFERENCE_EXTRACTION");

    if !on_top3.iter().any(|(t, c)| is_pref_engram(t, c)) {
        failures.push(format!(
            "imp#1 A/B: extraction ON did NOT surface a `Preference:` \
             engram in top-3 for '{ab_query}'; got {:?}",
            on_top3.iter().map(|(t, _)| first_line(t)).collect::<Vec<_>>()
        ));
    }
    if off_top3.iter().any(|(t, c)| is_pref_engram(t, c)) {
        failures.push(
            "imp#1 A/B: extraction OFF surfaced a `Preference:` engram — \
             the disable toggle is not actually disabling extraction"
                .to_string(),
        );
    }

    // ----------------------------------------------------------------
    // Improvement #2 — proper-noun boost, deterministic A/B.
    //
    // The `proper_noun_boost` ablate flag IS the A/B switch: identical
    // brain (`itest-brain`, already ingested), identical query, recency
    // ablated — the only variable is whether the boost runs. Probe:
    // "what did Sarah decide about the database". The right answer
    // (`standup`) carries the proper noun but little surface overlap; a
    // generic-token distractor (`db-maint`) is dense in "database/
    // decide". Mechanism is load-bearing iff: boost ON → standup top-3;
    // boost OFF → standup NOT top-3 (distractor wins). No contrast would
    // be honest negative evidence that the boost isn't doing the work.
    // ----------------------------------------------------------------
    let pn_query = "what did Sarah decide about the database";
    let pn_on = RecallOpts {
        top_k: 5,
        ablate: vec!["recency".to_string()],
        ..RecallOpts::default()
    };
    let pn_off = RecallOpts {
        top_k: 5,
        ablate: vec!["recency".to_string(), "proper_noun_boost".to_string()],
        ..RecallOpts::default()
    };
    let top3_has_standup = |opts: &RecallOpts| -> bool {
        let hits = retriever::hybrid_retrieve(&db, pn_query, opts)
            .unwrap_or_else(|e| panic!("pn A/B recall failed: {e}"));
        hits.iter().take(3).any(|h| {
            let t = h.title.to_lowercase();
            let c = h.content.to_lowercase();
            t.contains("standup") || c.contains("storage-layer migration")
        })
    };
    let on_hit = top3_has_standup(&pn_on);
    let off_hit = top3_has_standup(&pn_off);
    if !on_hit {
        failures.push(format!(
            "imp#2 A/B: boost ON did NOT put the proper-noun answer \
             (standup) in top-3 for '{pn_query}'"
        ));
    }
    if off_hit {
        failures.push(
            "imp#2 A/B: boost OFF already had the proper-noun answer in \
             top-3 — the probe doesn't isolate the boost (not load-bearing \
             evidence); strengthen the distractor".to_string(),
        );
    }

    // ----------------------------------------------------------------
    // Improvement #3 — numeric exact-match boost, deterministic A/B.
    //
    // Shares imp#2's `proper_noun_boost` ablate flag (one mechanism,
    // one switch). Probe: "how many loops did I ride in 2023". The two
    // mileage notes are topic-identical near-twins differing only by the
    // year — the discriminator BGE-small cannot represent. The distractor
    // (`mileage-2024`) is denser in the generic query tokens, so without
    // the numeric boost it outranks the correct note. Load-bearing iff:
    // boost ON → mileage-2023 ranked ABOVE mileage-2024; boost OFF →
    // mileage-2024 ranked above mileage-2023 (numeric signal absent).
    // top_k=10 so both near-twins are present and the relative order is
    // well-defined.
    // ----------------------------------------------------------------
    let num_query = "how many loops did I ride in 2023";
    let num_on = RecallOpts {
        top_k: 10,
        ablate: vec!["recency".to_string()],
        ..RecallOpts::default()
    };
    let num_off = RecallOpts {
        top_k: 10,
        ablate: vec!["recency".to_string(), "proper_noun_boost".to_string()],
        ..RecallOpts::default()
    };
    // returns (rank of mileage-2023, rank of mileage-2024) within hits
    let twin_ranks = |opts: &RecallOpts| -> (Option<usize>, Option<usize>) {
        let hits = retriever::hybrid_retrieve(&db, num_query, opts)
            .unwrap_or_else(|e| panic!("numeric A/B recall failed: {e}"));
        let find = |needle: &str| {
            hits.iter().position(|h| {
                h.title.to_lowercase().contains(needle)
                    || h.content.to_lowercase().contains(needle)
            })
        };
        // "2023"/"2024" appear only in the respective note's body.
        (find("2023"), find("2024"))
    };
    let (on_2023, on_2024) = twin_ranks(&num_on);
    let (off_2023, off_2024) = twin_ranks(&num_off);
    let on_correct = matches!((on_2023, on_2024),
        (Some(a), Some(b)) if a < b);
    let off_distractor_wins = match (off_2023, off_2024) {
        (Some(a), Some(b)) => b < a,
        (None, Some(_)) => true, // correct note didn't even surface
        _ => false,
    };
    if !on_correct {
        failures.push(format!(
            "imp#3 A/B: boost ON did NOT rank the correct-year note above \
             its near-twin for '{num_query}' (2023@{on_2023:?}, \
             2024@{on_2024:?})"
        ));
    }
    if !off_distractor_wins {
        failures.push(format!(
            "imp#3 A/B: boost OFF did not favour the distractor — probe \
             doesn't isolate the numeric signal (not load-bearing \
             evidence) (2023@{off_2023:?}, 2024@{off_2024:?})"
        ));
    }

    // ----------------------------------------------------------------
    // Improvement #5 — MMR diversification, deterministic A/B.
    //
    // The `mmr` ablate flag is the A/B switch (identical brain, recency
    // ablated). Probe: "what is the latest Atlas status". Five
    // near-duplicate session-1 notes (identical title) crowd the top
    // tier; one distinct session-2 fact ("retire the legacy Atlas
    // service") sits just below them pre-MMR. Load-bearing iff:
    // MMR ON → the distinct fact in top-3 (redundant cluster collapsed);
    // MMR OFF → distinct fact NOT in top-3 (cluster monopolises it).
    // No contrast = honest negative (λ=0.7 too relevance-leaning for
    // this shape) → imp#5 reverts per the finding-#5 gate.
    // ----------------------------------------------------------------
    let mmr_query = "what is the latest Atlas status";
    let mmr_on = RecallOpts {
        top_k: 5,
        ablate: vec!["recency".to_string()],
        ..RecallOpts::default()
    };
    let mmr_off = RecallOpts {
        top_k: 5,
        ablate: vec!["recency".to_string(), "mmr".to_string()],
        ..RecallOpts::default()
    };
    let distinct_in_top3 = |opts: &RecallOpts| -> bool {
        let hits = retriever::hybrid_retrieve(&db, mmr_query, opts)
            .unwrap_or_else(|e| panic!("mmr A/B recall failed: {e}"));
        hits.iter().take(3).any(|h| {
            let c = h.content.to_lowercase();
            c.contains("retire the legacy atlas")
                || h.title.to_lowercase().contains("roadmap change")
        })
    };
    let on_has_distinct = distinct_in_top3(&mmr_on);
    let off_has_distinct = distinct_in_top3(&mmr_off);
    if !on_has_distinct {
        failures.push(format!(
            "imp#5 A/B: MMR ON did NOT surface the distinct session-2 \
             fact in top-3 for '{mmr_query}'"
        ));
    }
    if off_has_distinct {
        failures.push(
            "imp#5 A/B: MMR OFF already had the distinct fact in top-3 — \
             the near-dup cluster isn't crowding it, so this probe \
             doesn't isolate MMR (not load-bearing evidence)".to_string(),
        );
    }

    // ----------------------------------------------------------------
    // Improvement #4 — fact supersession, deterministic A/B.
    //
    // The `fact_supersession` ablate flag is the A/B switch (identical
    // brain, recency ablated). Same fact revised over time: budget-old
    // ("grocery budget = 400 pounds"), later budget-new ("bumped the
    // grocery budget to 550 pounds"). Probe asks the CURRENT value:
    // "what is my current grocery budget". Load-bearing iff:
    // flag ON → budget-new (current) ranked ABOVE budget-old
    //           (superseded) AND budget-new in top-3;
    // flag OFF → that ordering does NOT hold (no current-value
    //           primitive; the stale value is not correctly preferred).
    // ----------------------------------------------------------------
    let fact_query = "what is my current grocery budget";
    let fs_on = RecallOpts {
        top_k: 10,
        ablate: vec!["recency".to_string()],
        ..RecallOpts::default()
    };
    let fs_off = RecallOpts {
        top_k: 10,
        ablate: vec!["recency".to_string(), "fact_supersession".to_string()],
        ..RecallOpts::default()
    };
    // (rank of budget-new = current/550, rank of budget-old = 400)
    let fact_ranks = |opts: &RecallOpts| -> (Option<usize>, Option<usize>) {
        let hits = retriever::hybrid_retrieve(&db, fact_query, opts)
            .unwrap_or_else(|e| panic!("fact A/B recall failed: {e}"));
        let new_pos = hits.iter().position(|h| {
            h.content.to_lowercase().contains("550 pounds")
                || h.title.to_lowercase().contains("monthly review")
        });
        let old_pos = hits
            .iter()
            .position(|h| h.content.to_lowercase().contains("grocery budget = 400"));
        (new_pos, old_pos)
    };
    let (on_new, on_old) = fact_ranks(&fs_on);
    let (off_new, off_old) = fact_ranks(&fs_off);
    let on_correct = matches!((on_new, on_old), (Some(a), Some(b)) if a < b)
        && on_new.map(|p| p < 3).unwrap_or(false);
    let off_primitive_absent = match (off_new, off_old) {
        (Some(a), Some(b)) => a >= b, // stale not correctly preferred
        (None, _) => true,            // current value didn't surface
        _ => false,
    };
    if !on_correct {
        failures.push(format!(
            "imp#4 A/B: flag ON did NOT rank the current value (budget-new) \
             above the superseded one in top-3 for '{fact_query}' \
             (new@{on_new:?}, old@{on_old:?})"
        ));
    }
    if !off_primitive_absent {
        failures.push(format!(
            "imp#4 A/B: flag OFF already preferred the current value — \
             probe doesn't isolate the supersession primitive \
             (new@{off_new:?}, old@{off_old:?})"
        ));
    }

    // ----------------------------------------------------------------
    // Improvement #6 — chunk-window expansion, deterministic A/B.
    //
    // The `chunk_window` ablate flag is the A/B switch (same `db`, recency
    // ablated). The `param-reference` note buries a unique token
    // ("nondiegetic") past the head/doc-chunk caps; the query targets it.
    // Load-bearing iff:
    //   flag ON  → the returned hit's content CONTAINS the buried detail
    //              (matched late chunk appended);
    //   flag OFF → it does NOT (head-only return cuts it) — proving the
    //              probe actually isolates the fix (detail is past the head).
    // ----------------------------------------------------------------
    let cw_query = "which output parameter covers nondiegetic sound effects";
    let cw_on = RecallOpts {
        top_k: 5,
        ablate: vec!["recency".to_string()],
        ..RecallOpts::default()
    };
    let cw_off = RecallOpts {
        top_k: 5,
        ablate: vec!["recency".to_string(), "chunk_window".to_string()],
        ..RecallOpts::default()
    };
    let returns_buried_detail = |opts: &RecallOpts| -> bool {
        let hits = retriever::hybrid_retrieve(&db, cw_query, opts)
            .unwrap_or_else(|e| panic!("chunk_window A/B recall failed: {e}"));
        hits.iter()
            .any(|h| h.content.to_lowercase().contains("nondiegetic"))
    };
    let cw_on_has = returns_buried_detail(&cw_on);
    let cw_off_has = returns_buried_detail(&cw_off);
    if !cw_on_has {
        failures.push(format!(
            "imp#6 A/B: chunk_window ON did NOT return the buried \
             'nondiegetic' detail for '{cw_query}' — matched chunk not \
             appended"
        ));
    }
    if cw_off_has {
        failures.push(
            "imp#6 A/B: chunk_window OFF already returned the buried detail \
             — the probe doesn't isolate the fix (detail is not actually \
             past the head window)".to_string(),
        );
    }

    db::close_all();
    let _ = std::fs::remove_dir_all(&home);

    assert!(
        failures.is_empty(),
        "retrieval regression — {} of {} probes failed:\n  {}",
        failures.len(),
        probes().len(),
        failures.join("\n  ")
    );
}

/// A distinctive keyword guaranteed to be in the right doc's body —
/// used as a content-match fallback so the assertion doesn't hinge on
/// the title formatting.
fn expected_keyword(stem: &str) -> &'static str {
    match stem {
        "shampoo" => "trader joe",
        "car-service" => "gps unit failed",
        "db-decision" => "sqlite-vec",
        "team" => "weekly engineering sync",
        "hmtops" => "five tops",
        "guitar" => "stratocaster",
        "yoga" => "serenity yoga",
        "trip" => "lisbon",
        "codesearch" => "ripgrep",
        _ => "\0", // never matches
    }
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").trim().to_string()
}

/// Long single-note body for the chunk-window A/B. 50 "Parameter N: …"
/// sentences (each ~75 chars, capital-`P` start so the sentence splitter
/// breaks them cleanly into windows). The distinctive token "nondiegetic"
/// appears ONLY in parameter 40 (~char 2400) — past the 1200 head window
/// and the 2000 doc-chunk cap, so it lives solely in a late sentence
/// chunk. A head-only return cannot contain it; appending the matched
/// chunk can.
fn chunk_window_fixture_body() -> String {
    let mut body = String::from(
        "# Parameter reference\n\nThe assistant supports the following \
         output parameters you can specify. ",
    );
    for n in 1..=50 {
        if n == 40 {
            body.push_str(
                "Parameter 40: Sound effects such as ambient, diegetic, and \
                 nondiegetic layering for immersive scenes. ",
            );
        } else {
            body.push_str(&format!(
                "Parameter {n}: Adjustable control number {n} for shaping the \
                 overall response style and structure. "
            ));
        }
    }
    body
}
