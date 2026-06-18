/* nv-bench: NeuroVault's reproducible benchmark harness.
 *
 * Two subcommands:
 *
 *   nv-bench graphify --repo <path> [--label <name>]
 *       Time codebase->graph ingestion (tree-sitter parse + DB population)
 *       on a real repository. Reports files/symbols/calls/edges, wall time,
 *       throughput, and on-disk index size. Runs in an isolated temp
 *       NEUROVAULT_HOME; the target repo is only ever read.
 *
 *   nv-bench longmemeval --dataset <file.json> [--limit N] [--k 1,3,5,10]
 *                        [--rerank] [--keep-recency] [--out <report.json>]
 *       Retrieval benchmark on the public LongMemEval dataset
 *       (https://github.com/xiaowu0162/LongMemEval). For each question:
 *       ingest its haystack sessions into a fresh brain, run NeuroVault's
 *       full hybrid retrieval on the question, and score whether the gold
 *       evidence sessions are retrieved. Pure retrieval metrics
 *       (Recall@k / MRR / NDCG@k) — no LLM, no API key, no network.
 *
 *       Determinism: recency ablation is ON by default because the scorer's
 *       wall-clock age decay makes scores drift minute-to-minute (see
 *       tests/retrieval_integration.rs "THE ORACLE PROBLEM"). LongMemEval
 *       questions probe content, not freshness, so this is the honest
 *       reproducible configuration; pass --keep-recency to measure the
 *       production default instead.
 *
 * Everything runs locally: fastembed ONNX embeddings, SQLite, in-process
 * retrieval. The only one-time network need is the embedding model download
 * into the fastembed cache (shared with the app).
 */

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use neurovault_lib::memory::{db, graphify, ingest, retriever};
use neurovault_lib::memory::retriever::RecallOpts;

const HELP: &str = "\
nv-bench: reproducible NeuroVault benchmarks (local, no API keys).

USAGE:
    nv-bench graphify --repo <path> [--label <name>]
    nv-bench longmemeval --dataset <longmemeval_s.json> [--limit N]
                         [--k 1,3,5,10] [--rerank] [--keep-recency]
                         [--out report.json]
";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("graphify") => cmd_graphify(&args[1..]),
        Some("longmemeval") => cmd_longmemeval(&args[1..]),
        Some("probe") => cmd_probe(&args[1..]),
        Some("--help") | Some("-h") | None => {
            print!("{HELP}");
            0
        }
        Some(other) => {
            eprintln!("unknown subcommand: {other}\n{HELP}");
            2
        }
    };
    std::process::exit(code);
}

/// Pull `--flag value` out of an arg slice. Returns None when absent.
fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|a| a == flag)
}

/// Point NEUROVAULT_HOME at a fresh temp dir with a single active brain.
/// Returns the home path (caller removes it on success).
fn isolated_home(tag: &str) -> PathBuf {
    let home = std::env::temp_dir().join(format!("nv_bench_{tag}_{}", std::process::id()));
    let _ = fs::remove_dir_all(&home);
    fs::create_dir_all(&home).expect("create bench home");
    std::env::set_var("NEUROVAULT_HOME", &home);
    // Benchmark corpus = the documents themselves, nothing else. Ingest's
    // silent-capture features spawn terse derived engrams (preferences,
    // facts) from chat content; on LongMemEval those duplicate the sessions
    // and compete with them for top-k slots — measured: terse `pref-*` notes
    // crowding every session out of a top-20. Production keeps these on;
    // the bench must measure document retrieval.
    std::env::set_var("NEUROVAULT_DISABLE_PREFERENCE_EXTRACTION", "1");
    std::env::set_var("NEUROVAULT_DISABLE_FACT_SUPERSESSION", "1");
    fs::write(
        home.join("brains.json"),
        r#"{"active":"bench","brains":[{"id":"bench","name":"Bench"}]}"#,
    )
    .expect("write brains.json");

    // The fastembed model cache resolves under NEUROVAULT_HOME — symlink the
    // user's real cache in so the bench reuses the already-downloaded ONNX
    // model instead of pulling ~100 MB per run. The model is a static
    // artifact; sharing it cannot contaminate results.
    if let Some(user_home) = std::env::var_os("HOME") {
        let real_cache = PathBuf::from(user_home).join(".neurovault/.fastembed_cache");
        if real_cache.is_dir() {
            #[cfg(unix)]
            let _ = std::os::unix::fs::symlink(&real_cache, home.join(".fastembed_cache"));
        }
    }
    home
}

fn dir_size(path: &PathBuf) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(path) {
        for e in entries.flatten() {
            let p = e.path();
            total += if p.is_dir() {
                dir_size(&p)
            } else {
                e.metadata().map(|m| m.len()).unwrap_or(0)
            };
        }
    }
    total
}

// ───────────────────────────── graphify speed ─────────────────────────────

fn cmd_graphify(args: &[String]) -> i32 {
    let Some(repo) = flag_value(args, "--repo") else {
        eprintln!("graphify: --repo <path> is required\n{HELP}");
        return 2;
    };
    let repo = PathBuf::from(repo);
    if !repo.is_dir() {
        eprintln!("graphify: not a directory: {}", repo.display());
        return 2;
    }
    let label = flag_value(args, "--label")
        .unwrap_or_else(|| repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());

    let home = isolated_home("graphify");
    let brain = db::open_brain("bench").expect("open bench brain");

    // Parse-only pass first so parse and DB-write costs are separable.
    let t0 = Instant::now();
    let parsed = graphify::graphify_repo(&repo);
    let parse_time = t0.elapsed();

    let t1 = Instant::now();
    let stats = graphify::graphify_into_brain(&repo, &brain);
    let total_time = t1.elapsed();

    let db_bytes = dir_size(&home.join("brains").join("bench"));
    let parsed_files = parsed.len();
    let secs = total_time.as_secs_f64();

    println!("\n━━ nv-bench graphify — {label} ━━");
    println!("repo:            {}", repo.display());
    println!("files parsed:    {parsed_files}");
    println!("symbols:         {}", stats.symbols);
    println!("calls (intra):   {}", stats.calls);
    println!("graph edges:     {}", stats.edges);
    println!("parse time:      {:.2}s", parse_time.as_secs_f64());
    println!("parse+index:     {secs:.2}s  ({:.0} files/s)", parsed_files as f64 / secs.max(0.001));
    println!("index size:      {:.1} MB", db_bytes as f64 / 1_048_576.0);
    println!("(on-device tree-sitter + SQLite; the repo was only read)");

    let _ = fs::remove_dir_all(&home);
    0
}

// ───────────────────────────── metrics (pure) ─────────────────────────────

/// Recall@k under the standard LongMemEval definition: the fraction of
/// gold evidence sessions that appear in the top-k retrieved sessions,
/// averaged over questions ("any-hit" for single-evidence questions;
/// partial credit for multi-session questions).
fn recall_at_k(ranked: &[String], gold: &[String], k: usize) -> f64 {
    if gold.is_empty() {
        return 0.0;
    }
    let top: Vec<&String> = ranked.iter().take(k).collect();
    let hit = gold.iter().filter(|g| top.iter().any(|t| t == g)).count();
    hit as f64 / gold.len() as f64
}

/// Strict any-evidence hit: 1.0 if ANY gold session is in the top-k.
fn hit_at_k(ranked: &[String], gold: &[String], k: usize) -> f64 {
    let top: Vec<&String> = ranked.iter().take(k).collect();
    if gold.iter().any(|g| top.iter().any(|t| *t == g)) {
        1.0
    } else {
        0.0
    }
}

/// Mean reciprocal rank of the FIRST gold session.
fn mrr(ranked: &[String], gold: &[String]) -> f64 {
    for (i, r) in ranked.iter().enumerate() {
        if gold.iter().any(|g| g == r) {
            return 1.0 / (i as f64 + 1.0);
        }
    }
    0.0
}

/// Binary-relevance NDCG@k against the gold session set.
fn ndcg_at_k(ranked: &[String], gold: &[String], k: usize) -> f64 {
    if gold.is_empty() {
        return 0.0;
    }
    let mut dcg = 0.0;
    for (i, r) in ranked.iter().take(k).enumerate() {
        if gold.iter().any(|g| g == r) {
            dcg += 1.0 / ((i as f64 + 2.0).log2());
        }
    }
    let ideal_hits = gold.len().min(k);
    let idcg: f64 = (0..ideal_hits).map(|i| 1.0 / ((i as f64 + 2.0).log2())).sum();
    if idcg == 0.0 {
        0.0
    } else {
        dcg / idcg
    }
}

// ─────────────────────── abstention (retrieval-gate) ──────────────────────

/// Result of sweeping the retrieval-confidence abstention threshold τ.
///
/// NeuroVault is retrieval-only — it has no answer stage to "refuse" with —
/// so LongMemEval's answer-level abstention judge does not apply. Instead we
/// measure whether retrieval *confidence* separates answerable from
/// unanswerable (`_abs`) questions: the system "abstains" when its top
/// retrieval score is below τ. For an `_abs` question abstaining is CORRECT;
/// for an answerable question it is WRONG. "abstain" is the positive class.
///
/// τ* maximizes balanced accuracy (robust to the ~30/470 answerable/abstention
/// imbalance, where raw accuracy would reward always-answer); ties resolve to
/// the larger τ (more willing to abstain). No known competitor publishes a
/// retrieval-confidence abstention metric — this lets NeuroVault report all
/// five LongMemEval dimensions.
struct AbstentionReport {
    available: bool,
    tau_star: f64,
    /// Abstention@τ* = (TP+TN)/total at τ*.
    accuracy: f64,
    balanced_acc: f64,
    /// Of the questions we abstained on, how many were truly `_abs`.
    precision: f64,
    /// Sensitivity = TP/(TP+FN): of `_abs` questions, how many we caught.
    recall: f64,
    /// TN/(TN+FP): of answerable questions, how many we answered.
    specificity: f64,
    f1: f64,
    n_abs: usize,
    n_ans: usize,
    /// Mean top score on answerable questions (should exceed `abs_mean`).
    ans_mean: f64,
    /// Mean top score on `_abs` questions.
    abs_mean: f64,
    /// (τ, precision, recall, balanced_acc, f1, accuracy) per swept threshold.
    curve: Vec<(f64, f64, f64, f64, f64, f64)>,
}

impl AbstentionReport {
    /// Sentinel for a slice with no `_abs` (or no answerable) questions —
    /// the gate is undefined without both classes present.
    fn na() -> Self {
        AbstentionReport {
            available: false,
            tau_star: 0.0,
            accuracy: 0.0,
            balanced_acc: 0.0,
            precision: 0.0,
            recall: 0.0,
            specificity: 0.0,
            f1: 0.0,
            n_abs: 0,
            n_ans: 0,
            ans_mean: 0.0,
            abs_mean: 0.0,
            curve: Vec::new(),
        }
    }
}

/// Sweep τ over midpoints of the observed top-score distribution and pick
/// τ* = argmax balanced accuracy. `samples` = (top_score, is_abs) per
/// question. Pure (no I/O, no recall) so it is unit-testable in isolation.
///
/// The candidate grid is the set of midpoints between consecutive sorted
/// scores plus two end sentinels — grid-independent, always finds the optimal
/// split point. Scores are config-dependent in magnitude (RRF-only vs rerank
/// vs recency live on different scales), so τ is only meaningful within the
/// single run that produced these samples; never reuse a τ across configs.
fn abstention_curve(samples: &[(f64, bool)]) -> AbstentionReport {
    let n_abs = samples.iter().filter(|(_, a)| *a).count();
    let n_ans = samples.len() - n_abs;
    if n_abs == 0 || n_ans == 0 {
        return AbstentionReport::na();
    }
    let ans_mean =
        samples.iter().filter(|(_, a)| !*a).map(|(s, _)| *s).sum::<f64>() / n_ans as f64;
    let abs_mean =
        samples.iter().filter(|(_, a)| *a).map(|(s, _)| *s).sum::<f64>() / n_abs as f64;

    let mut scores: Vec<f64> = samples.iter().map(|(s, _)| *s).collect();
    scores.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut taus = vec![scores[0] - 1e-6];
    for w in scores.windows(2) {
        taus.push((w[0] + w[1]) / 2.0);
    }
    taus.push(scores[scores.len() - 1] + 1e-6);
    taus.dedup_by(|a, b| (*a - *b).abs() < 1e-12);

    let mut curve = Vec::with_capacity(taus.len());
    // (balanced_acc, tau, precision, recall, specificity, f1, accuracy)
    let mut best: Option<(f64, f64, f64, f64, f64, f64, f64)> = None;
    for &tau in &taus {
        let (mut tp, mut fp, mut fn_, mut tn) = (0usize, 0usize, 0usize, 0usize);
        for &(s, is_abs) in samples {
            let abstain = s < tau; // abstain = top score below threshold
            match (is_abs, abstain) {
                (true, true) => tp += 1,
                (true, false) => fn_ += 1,
                (false, true) => fp += 1,
                (false, false) => tn += 1,
            }
        }
        let sens = tp as f64 / (tp + fn_).max(1) as f64;
        let spec = tn as f64 / (tn + fp).max(1) as f64;
        let bal = 0.5 * (sens + spec);
        let prec = if tp + fp == 0 { 0.0 } else { tp as f64 / (tp + fp) as f64 };
        let f1 = if prec + sens == 0.0 { 0.0 } else { 2.0 * prec * sens / (prec + sens) };
        let acc = (tp + tn) as f64 / samples.len() as f64;
        curve.push((tau, prec, sens, bal, f1, acc));
        let better = match best {
            None => true,
            // tie on balanced accuracy → prefer the larger τ
            Some((b_bal, b_tau, ..)) => bal > b_bal || (bal == b_bal && tau > b_tau),
        };
        if better {
            best = Some((bal, tau, prec, sens, spec, f1, acc));
        }
    }
    let (bal, tau, prec, sens, spec, f1, acc) = best.unwrap();
    AbstentionReport {
        available: true,
        tau_star: tau,
        accuracy: acc,
        balanced_acc: bal,
        precision: prec,
        recall: sens,
        specificity: spec,
        f1,
        n_abs,
        n_ans,
        ans_mean,
        abs_mean,
        curve,
    }
}

// ──────────────────────────── longmemeval mode ────────────────────────────

/// One question after dataset parsing — adapter output, scorer input.
struct LmeQuestion {
    question_id: String,
    question_type: String,
    question: String,
    /// (session_id, serialized markdown) per haystack session.
    sessions: Vec<(String, String)>,
    /// Gold evidence session ids.
    gold: Vec<String>,
}

/// Parse longmemeval_s.json / longmemeval_oracle.json into questions.
/// Schema (public dataset): a JSON array; each entry has question_id,
/// question_type, question, answer, haystack_session_ids, haystack_sessions
/// (list of sessions, each a list of {role, content} turns), and
/// answer_session_ids (gold evidence).
fn parse_dataset(path: &str) -> Result<Vec<LmeQuestion>, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse {path}: {e}"))?;
    let arr = v.as_array().ok_or("dataset root is not a JSON array")?;

    let mut out = Vec::with_capacity(arr.len());
    for q in arr {
        let question_id = q["question_id"].as_str().unwrap_or_default().to_string();
        let question_type = q["question_type"].as_str().unwrap_or_default().to_string();
        let question = q["question"].as_str().unwrap_or_default().to_string();
        let gold: Vec<String> = q["answer_session_ids"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        let ids = q["haystack_session_ids"].as_array().cloned().unwrap_or_default();
        let dates = q["haystack_dates"].as_array().cloned().unwrap_or_default();
        let sessions_json = q["haystack_sessions"].as_array().cloned().unwrap_or_default();
        let mut sessions = Vec::with_capacity(sessions_json.len());
        for (i, sess) in sessions_json.iter().enumerate() {
            let sid = ids
                .get(i)
                .and_then(|s| s.as_str())
                .map(String::from)
                .unwrap_or_else(|| format!("session_{i}"));
            // Serialize turns as a readable transcript. The session id is
            // NOT embedded in the content — mapping back happens via the
            // engram filename, so retrieval can't cheat on id tokens.
            //
            // Each session gets a DISTINCT natural title (its date, which the
            // dataset provides and which a real chat log would carry). With a
            // shared title like "Chat session", every doc has title-embedding
            // cosine 1.0 to every other and the MMR diversifier rightly
            // collapses them as one redundant cluster — first measured as
            // hit@5 = 0.20 on real data vs 1.0 on the oracle split.
            let date = dates.get(i).and_then(|d| d.as_str()).unwrap_or("");
            let mut md = if date.is_empty() {
                format!("# Chat session {}\n\n", i + 1)
            } else {
                format!("# Chat on {date}\n\n")
            };
            if let Some(turns) = sess.as_array() {
                for t in turns {
                    let role = t["role"].as_str().unwrap_or("user");
                    let content = t["content"].as_str().unwrap_or("");
                    md.push_str(&format!("**{role}:** {content}\n\n"));
                }
            }
            sessions.push((sid, md));
        }
        out.push(LmeQuestion { question_id, question_type, question, sessions, gold });
    }
    Ok(out)
}

fn cmd_longmemeval(args: &[String]) -> i32 {
    let Some(dataset) = flag_value(args, "--dataset") else {
        eprintln!("longmemeval: --dataset <file.json> is required\n{HELP}");
        return 2;
    };
    let limit: usize = flag_value(args, "--limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(usize::MAX);
    let ks: Vec<usize> = flag_value(args, "--k")
        .unwrap_or_else(|| "1,3,5,10".into())
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    let kmax = ks.iter().copied().max().unwrap_or(10);
    let rerank = has_flag(args, "--rerank");
    let keep_recency = has_flag(args, "--keep-recency");
    // Extra scoring features to switch off (comma-separated; see RecallOpts
    // for the vocabulary). Diagnosis lever: `--ablate mmr` isolates the MMR
    // diversifier, `--ablate semantic` runs keyword+graph only, etc.
    let extra_ablate: Vec<String> = flag_value(args, "--ablate")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let out_path = flag_value(args, "--out");
    // Abstention questions (id suffix "_abs") are KEPT by default and scored
    // via the retrieval-confidence gate (see AbstentionReport). Pass
    // --no-abstention to restore the legacy exclusion so old "engine-only"
    // numbers stay byte-reproducible.
    let include_abstention = !has_flag(args, "--no-abstention");

    let mut questions = match parse_dataset(&dataset) {
        Ok(q) => q,
        Err(e) => {
            eprintln!("longmemeval: {e}");
            return 1;
        }
    };
    let total_available = questions.len();

    // `_abs` questions carry a DECOY gold id and a real "you did not mention…"
    // answer; their decoy gold is irrelevant — correctness for an `_abs`
    // question is purely "did we abstain?" (handled by abstention_curve). Keep
    // them unless --no-abstention. Answerable questions still need real gold.
    questions.retain(|q| {
        if q.question_id.ends_with("_abs") {
            include_abstention
        } else {
            !q.gold.is_empty()
        }
    });
    let after_abs = questions.len();

    // The dataset file is ordered by question type, so a head-truncation
    // would benchmark a single type. ALWAYS interleave types round-robin
    // (deterministic, no RNG) into one stable global order, then slice
    // [--offset, --offset + --limit). Because the order is stable, chunked
    // runs (e.g. --offset 0/100/200… --limit 100) are disjoint and together
    // cover the full set — merge their reports with
    // docs/benchmarks/merge_reports.py for the combined scorecard.
    let offset: usize = flag_value(args, "--offset")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    {
        let mut by_type: std::collections::BTreeMap<String, Vec<LmeQuestion>> =
            std::collections::BTreeMap::new();
        for q in questions.drain(..) {
            by_type.entry(q.question_type.clone()).or_default().push(q);
        }
        let mut interleaved = Vec::new();
        loop {
            let mut any = false;
            for bucket in by_type.values_mut() {
                if let Some(q) = bucket.pop() {
                    interleaved.push(q);
                    any = true;
                }
            }
            if !any {
                break;
            }
        }
        questions = interleaved.into_iter().skip(offset).take(limit).collect();
    }

    // --list: print the slice (id + type) without running anything — verify
    // chunk boundaries instantly before committing hours of compute.
    if has_flag(args, "--list") {
        for q in &questions {
            println!("{}\t{}", q.question_id, q.question_type);
        }
        eprintln!("({} questions in slice; offset {offset})", questions.len());
        return 0;
    }

    // Split the slice: `_abs` questions are scored by the abstention gate
    // only; answerable questions feed the gold-retrieval metrics. Means must
    // divide by n_scoreable, NOT the full slice, or abstention questions would
    // dilute hit@k / recall@k.
    let n_abs_q = questions.iter().filter(|q| q.question_id.ends_with("_abs")).count();
    let n_scoreable = questions.len() - n_abs_q;

    // A self-describing config label so every report file is unambiguous about
    // which recall path produced it. Production = the real recall() path
    // (rerank + recency); engine-only = the reproducible ablated config.
    let keep_title_boosts = has_flag(args, "--keep-title-boosts");
    let title_boosts_ablated = !keep_title_boosts;
    let config_label = match (rerank, keep_recency, keep_title_boosts) {
        (true, true, false) => "production-A",
        (true, true, true) => "production-B",
        (false, false, false) if extra_ablate.is_empty() => "engine-only",
        _ => "custom",
    };

    eprintln!(
        "longmemeval: {total_available} in file → {after_abs} kept; running {} \
         ({n_scoreable} answerable + {n_abs_q} abstention)",
        questions.len()
    );
    eprintln!(
        "config: [{config_label}] k={ks:?} rerank={rerank} recency={} \
         title_boosts={} extra_ablate={extra_ablate:?}",
        if keep_recency { "production (wall-clock)" } else { "ablated (reproducible)" },
        if keep_title_boosts { "on" } else { "ablated" },
    );

    let home = isolated_home("lme");
    let bench_start = Instant::now();

    // Aggregates: metric -> sum, plus per-question-type breakdown.
    let mut sums: HashMap<String, f64> = HashMap::new();
    let mut type_sums: HashMap<String, (f64, usize)> = HashMap::new(); // r@5 only
    let mut per_question: Vec<serde_json::Value> = Vec::new();
    // (top_score, is_abs) per question — the retrieval-confidence gate input.
    let mut abstain_samples: Vec<(f64, bool)> = Vec::new();
    let mut ingest_secs = 0.0f64;
    let mut query_secs = 0.0f64;
    let n = questions.len();

    for (qi, q) in questions.iter().enumerate() {
        let is_abs = q.question_id.ends_with("_abs");
        // Fresh brain per question — with a UNIQUE id, not a reused one:
        // several layers (BM25 index, recall cache, pagerank state) cache by
        // brain id, so reusing "bench" across questions could silently serve
        // the previous question's index. A new id sidesteps every cache.
        let brain_id = format!("lme-q{qi}");
        let brain_dir = home.join("brains").join(&brain_id);
        let brain: Arc<_> = match db::open_brain(&brain_id) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("open brain: {e}");
                return 1;
            }
        };

        let t0 = Instant::now();
        for (sid, md) in &q.sessions {
            let fname = format!("sess-{sid}.md");
            if let Err(e) = ingest::ingest_content(&fname, md, &brain) {
                eprintln!("  ingest {fname}: {e}");
            }
        }
        ingest_secs += t0.elapsed().as_secs_f64();

        let opts = RecallOpts {
            top_k: kmax,
            spread_hops: 0,
            exclude_kinds: vec!["observation".to_string(), "preference".to_string()],
            as_of: None,
            use_reranker: rerank,
            ablate: {
                let mut a = extra_ablate.clone();
                if !keep_recency {
                    a.push("recency".to_string());
                }
                // Title boosts are ablated because LongMemEval documents have
                // no titles — whatever title the adapter writes (we use the
                // session date) is a synthetic artifact, and boosting on it
                // injects rank noise that buries content-relevant sessions
                // (measured: gold at #11-13 with boosts, #1-2 without, on
                // multiple failing questions). A benchmark must not let the
                // serialization adapter manufacture signal in either
                // direction. Pass --keep-title-boosts to measure anyway.
                if !has_flag(args, "--keep-title-boosts") {
                    a.push("title_semantic".to_string());
                    a.push("title_keyword".to_string());
                }
                a
            },
        };
        let t1 = Instant::now();
        let hits = match retriever::hybrid_retrieve(&brain, &q.question, &opts) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("  recall failed on {}: {e}", q.question_id);
                Vec::new()
            }
        };
        query_secs += t1.elapsed().as_secs_f64();

        // Retrieval-confidence gate input: the top score among real hits
        // (0.0 when nothing was retrieved). Collected for EVERY question,
        // abstention and answerable alike — abstention_curve separates them.
        let top_score = hits
            .iter()
            .filter(|h| h.engram_id != retriever::THROTTLE_HINT_ID)
            .map(|h| h.score)
            .fold(f64::NEG_INFINITY, f64::max);
        let top_score = if top_score.is_finite() { top_score } else { 0.0 };
        abstain_samples.push((top_score, is_abs));

        // engram_id -> session id via the stored filename (sess-<id>.md).
        let ranked: Vec<String> = {
            let conn = brain.lock();
            hits.iter()
                .filter(|h| h.engram_id != retriever::THROTTLE_HINT_ID)
                .filter_map(|h| {
                    conn.query_row(
                        "SELECT filename FROM engrams WHERE id = ?1",
                        [&h.engram_id],
                        |r| r.get::<_, String>(0),
                    )
                    .ok()
                })
                .filter_map(|f| {
                    f.strip_prefix("sess-")
                        .and_then(|s| s.strip_suffix(".md"))
                        .map(String::from)
                })
                .collect()
        };

        // Gold-retrieval metrics apply ONLY to answerable questions. `_abs`
        // questions have a decoy gold, so scoring them here would be
        // meaningless — they are judged solely by the abstention gate.
        if !is_abs {
            for &k in &ks {
                *sums.entry(format!("recall@{k}")).or_default() += recall_at_k(&ranked, &q.gold, k);
                *sums.entry(format!("hit@{k}")).or_default() += hit_at_k(&ranked, &q.gold, k);
                *sums.entry(format!("ndcg@{k}")).or_default() += ndcg_at_k(&ranked, &q.gold, k);
            }
            *sums.entry("mrr".into()).or_default() += mrr(&ranked, &q.gold);
            let entry = type_sums.entry(q.question_type.clone()).or_insert((0.0, 0));
            entry.0 += recall_at_k(&ranked, &q.gold, 5);
            entry.1 += 1;
        }

        let record = serde_json::json!({
            "question_id": q.question_id,
            "type": q.question_type,
            "is_abs": is_abs,
            "abstain_top_score": top_score,
            "gold": q.gold,
            "ranked_top": ranked.iter().take(kmax).collect::<Vec<_>>(),
            // null for `_abs` — merge_reports.py branches on is_abs.
            "recall@5": if is_abs { serde_json::Value::Null }
                        else { serde_json::json!(recall_at_k(&ranked, &q.gold, 5)) },
        });
        // Checkpoint EVERY question the moment it's scored (append-only
        // JSONL next to the --out path). A sleep/kill mid-run then costs at
        // most the question in flight — learned after an overnight 6-hour
        // chunk died to a lid-close thermal sleep and lost everything.
        // merge_reports.py reads .partial.jsonl files directly.
        if let Some(out) = &out_path {
            use std::io::Write;
            if let Ok(mut f) = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(format!("{out}.partial.jsonl"))
            {
                let _ = writeln!(f, "{record}");
            }
        }
        per_question.push(record);

        if is_abs {
            eprintln!(
                "[{}/{}] {} (ABSTENTION) top_score={:.3}  ({} sessions, {:.1}s)",
                qi + 1,
                n,
                q.question_id,
                top_score,
                q.sessions.len(),
                t0.elapsed().as_secs_f64(),
            );
        } else {
            eprintln!(
                "[{}/{}] {} ({}) r@5={:.2}  ({} sessions, {:.1}s)",
                qi + 1,
                n,
                q.question_id,
                q.question_type,
                recall_at_k(&ranked, &q.gold, 5),
                q.sessions.len(),
                t0.elapsed().as_secs_f64(),
            );
        }

        // Free the handle + disk before the next question; 500 brains of
        // ~50 embedded sessions each would otherwise pile up gigabytes.
        db::close_brain(&brain_id);
        let _ = fs::remove_dir_all(&brain_dir);
    }

    let nf = n as f64; // all questions (for per-question timing)
    let nf_score = (n_scoreable as f64).max(1.0); // answerable only (for gold metrics)
    println!(
        "\n━━ nv-bench longmemeval — {} questions ({} answerable + {} abstention) ━━",
        n, n_scoreable, n_abs_q
    );
    println!("dataset:      {dataset}");
    println!(
        "config:       [{config_label}] hybrid (vec+bm25+graph, RRF){}{}",
        if rerank { " + cross-encoder rerank" } else { "" },
        if keep_recency { ", production recency" } else { ", recency-ablated (reproducible)" },
    );
    let mut keys: Vec<&String> = sums.keys().collect();
    keys.sort();
    for k in keys {
        println!("{k:<12} {:.4}", sums[k] / nf_score);
    }
    println!("\nper question type (recall@5):");
    let mut tkeys: Vec<&String> = type_sums.keys().collect();
    tkeys.sort();
    for t in tkeys {
        let (s, c) = type_sums[t];
        println!("  {t:<28} {:.4}  (n={c})", s / c as f64);
    }

    // ── abstention (retrieval-confidence gate) ──
    let abs_report = abstention_curve(&abstain_samples);
    println!("\n━━ abstention (retrieval-confidence gate) ━━");
    if !abs_report.available {
        println!(
            "  N/A (slice has no _abs questions — include abstention questions, i.e."
        );
        println!("       run without --no-abstention, to measure this dimension)");
    } else {
        println!("  τ* (argmax balanced acc):  {:.4}", abs_report.tau_star);
        println!("  Abstention@τ* (accuracy):  {:.4}", abs_report.accuracy);
        println!("  balanced accuracy:         {:.4}", abs_report.balanced_acc);
        println!(
            "  precision / recall / F1:   {:.4} / {:.4} / {:.4}",
            abs_report.precision, abs_report.recall, abs_report.f1
        );
        println!("  specificity:               {:.4}", abs_report.specificity);
        println!(
            "  top-score separation:      answerable μ={:.4}  vs  _abs μ={:.4}  (Δ={:+.4})",
            abs_report.ans_mean,
            abs_report.abs_mean,
            abs_report.ans_mean - abs_report.abs_mean
        );
        println!(
            "  (n: {} answerable, {} abstention)",
            abs_report.n_ans, abs_report.n_abs
        );
        // Compact P/R/balanced-acc curve — ~8 sampled thresholds + the last.
        println!("  sweep (τ → prec / rec / bal / acc):");
        let step = (abs_report.curve.len() / 8).max(1);
        for (i, (tau, prec, sens, bal, _f1, acc)) in abs_report.curve.iter().enumerate() {
            if i % step == 0 || i + 1 == abs_report.curve.len() {
                println!("    {tau:>9.4}  p={prec:.3} r={sens:.3} bal={bal:.3} acc={acc:.3}");
            }
        }
    }

    println!(
        "\ntiming: ingest {:.1}s total ({:.2}s/question) · query {:.1}s total ({:.0} ms/question) · wall {:.1}s",
        ingest_secs,
        ingest_secs / nf,
        query_secs,
        1000.0 * query_secs / nf,
        bench_start.elapsed().as_secs_f64(),
    );

    if let Some(out) = out_path {
        let mut means = serde_json::Map::new();
        for (k, v) in &sums {
            means.insert(k.clone(), serde_json::json!(v / nf_score));
        }
        let abstention_json = if abs_report.available {
            serde_json::json!({
                "available": true,
                "tau_star": abs_report.tau_star,
                "accuracy": abs_report.accuracy,
                "balanced_accuracy": abs_report.balanced_acc,
                "precision": abs_report.precision,
                "recall": abs_report.recall,
                "specificity": abs_report.specificity,
                "f1": abs_report.f1,
                "n_abs": abs_report.n_abs,
                "n_ans": abs_report.n_ans,
                "answerable_mean_top_score": abs_report.ans_mean,
                "abs_mean_top_score": abs_report.abs_mean,
            })
        } else {
            serde_json::json!({ "available": false })
        };
        let report = serde_json::json!({
            "benchmark": "longmemeval-retrieval",
            "dataset": dataset,
            "questions": n,
            "scoreable": n_scoreable,
            "abstention_questions": n_abs_q,
            "config": {
                "label": config_label,
                "retrieval": "hybrid vec+bm25+graph RRF",
                "rerank": rerank,
                "recency_ablated": !keep_recency,
                "title_boosts_ablated": title_boosts_ablated,
                "extra_ablate": extra_ablate,
                "embedder": "BGE-small-en-v1.5 (fastembed, local ONNX)",
            },
            "means": means,
            "abstention": abstention_json,
            "per_question": per_question,
        });
        if let Err(e) = fs::write(&out, serde_json::to_string_pretty(&report).unwrap()) {
            eprintln!("write {out}: {e}");
        } else {
            println!("report written: {out}");
        }
    }

    let _ = fs::remove_dir_all(&home);
    0
}

// ─────────────────────────── probe (diagnosis) ────────────────────────────

/// Ingest ONE question's haystack, then run its query under a matrix of
/// ablation configs and print the gold sessions' ranks in each — pinpoints
/// which scoring signal/stage buries the evidence, in seconds instead of a
/// full re-run. Usage:
///   nv-bench probe --dataset <file> --question-id <id>
fn cmd_probe(args: &[String]) -> i32 {
    let Some(dataset) = flag_value(args, "--dataset") else {
        eprintln!("probe: --dataset required");
        return 2;
    };
    let Some(qid) = flag_value(args, "--question-id") else {
        eprintln!("probe: --question-id required");
        return 2;
    };
    let questions = match parse_dataset(&dataset) {
        Ok(q) => q,
        Err(e) => {
            eprintln!("probe: {e}");
            return 1;
        }
    };
    let Some(q) = questions.into_iter().find(|q| q.question_id == qid) else {
        eprintln!("probe: question {qid} not found");
        return 1;
    };

    // --reuse-home <path>: skip ingest and query an existing probe home
    // (printed by a previous run) — iteration drops from ~6 min to seconds.
    let reuse = flag_value(args, "--reuse-home");
    let home = match &reuse {
        Some(p) => {
            let home = PathBuf::from(p);
            std::env::set_var("NEUROVAULT_HOME", &home);
            home
        }
        None => isolated_home("probe"),
    };
    let brain = db::open_brain("probe").expect("open probe brain");
    if reuse.is_none() {
        eprintln!("probe: ingesting {} sessions …", q.sessions.len());
        let t0 = Instant::now();
        let mut errs = 0;
        for (sid, md) in &q.sessions {
            if let Err(e) = ingest::ingest_content(&format!("sess-{sid}.md"), md, &brain) {
                errs += 1;
                eprintln!("  ingest error ({sid}): {e}");
            }
        }
        eprintln!(
            "probe: ingested in {:.0}s ({errs} errors)",
            t0.elapsed().as_secs_f64()
        );
    }
    let engrams: i64 = {
        let conn = brain.lock();
        conn.query_row("SELECT COUNT(*) FROM engrams", [], |r| r.get(0)).unwrap_or(-1)
    };
    eprintln!("probe: home={} engrams={engrams}", home.display());
    println!("\nQ: {}", q.question);
    println!("gold: {:?}\n", q.gold);

    // (label, ablate list, rerank)
    let configs: Vec<(&str, Vec<&str>, bool)> = vec![
        ("full (prod-ish)", vec!["recency"], false),
        ("no-mmr", vec!["recency", "mmr"], false),
        ("semantic only", vec!["recency", "bm25", "entity_graph"], false),
        ("bm25 only", vec!["recency", "semantic", "entity_graph"], false),
        ("no-graph", vec!["recency", "entity_graph"], false),
        ("bench (no-title)", vec!["recency", "title_semantic", "title_keyword"], false),
        ("bench + no-mmr", vec!["recency", "title_semantic", "title_keyword", "mmr"], false),
        ("full + rerank", vec!["recency"], true),
    ];
    // Match the longmemeval runner's top_k so probe ranks reproduce bench
    // ranks exactly (MMR diversifies within the top_k tier, so tier size
    // changes the ordering). Override with --top-k.
    let probe_top_k: usize = flag_value(args, "--top-k")
        .and_then(|s| s.parse().ok())
        .unwrap_or(10);

    println!("{:<22} {:>10}  top-5", "config", "gold-rank");
    for (label, ablate, rerank) in configs {
        let opts = RecallOpts {
            top_k: probe_top_k,
            spread_hops: 0,
            exclude_kinds: vec!["observation".to_string(), "preference".to_string()],
            as_of: None,
            use_reranker: rerank,
            ablate: ablate.iter().map(|s| s.to_string()).collect(),
        };
        let hits = match retriever::hybrid_retrieve(&brain, &q.question, &opts) {
            Ok(h) => h,
            Err(e) => {
                println!("{label:<22} RECALL ERROR: {e}");
                continue;
            }
        };
        let raw_hits = hits.len();
        let ranked: Vec<String> = {
            let conn = brain.lock();
            hits.iter()
                .filter(|h| h.engram_id != retriever::THROTTLE_HINT_ID)
                .filter_map(|h| {
                    conn.query_row(
                        "SELECT filename FROM engrams WHERE id = ?1",
                        [&h.engram_id],
                        |r| r.get::<_, String>(0),
                    )
                    .ok()
                })
                .filter_map(|f| {
                    f.strip_prefix("sess-")
                        .and_then(|s| s.strip_suffix(".md"))
                        .map(String::from)
                })
                .collect()
        };
        let gold_rank: String = q
            .gold
            .iter()
            .map(|g| {
                ranked
                    .iter()
                    .position(|r| r == g)
                    .map(|p| (p + 1).to_string())
                    .unwrap_or_else(|| "-".into())
            })
            .collect::<Vec<_>>()
            .join(",");
        let top5: Vec<&str> = ranked.iter().take(5).map(|s| s.as_str()).collect();
        println!("{label:<22} {gold_rank:>10}  raw_hits={raw_hits} {top5:?}");
    }

    // Keep the home for --reuse-home iteration; it lives in the OS temp dir
    // and is cleaned by the system (or by a fresh probe run of the same pid).
    eprintln!("\nprobe home kept for --reuse-home: {}", home.display());
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn recall_at_k_partial_credit() {
        let ranked = s(&["a", "b", "c", "d"]);
        // both golds in top-4 → 1.0; only one in top-1 → 0.5
        assert_eq!(recall_at_k(&ranked, &s(&["a", "d"]), 4), 1.0);
        assert_eq!(recall_at_k(&ranked, &s(&["a", "d"]), 1), 0.5);
        assert_eq!(recall_at_k(&ranked, &s(&["x"]), 4), 0.0);
    }

    #[test]
    fn hit_at_k_any_gold() {
        let ranked = s(&["a", "b", "c"]);
        assert_eq!(hit_at_k(&ranked, &s(&["c", "x"]), 3), 1.0);
        assert_eq!(hit_at_k(&ranked, &s(&["c", "x"]), 2), 0.0);
    }

    #[test]
    fn mrr_first_gold_rank() {
        let ranked = s(&["x", "g", "y"]);
        assert!((mrr(&ranked, &s(&["g"])) - 0.5).abs() < 1e-9);
        assert_eq!(mrr(&ranked, &s(&["nope"])), 0.0);
    }

    #[test]
    fn ndcg_perfect_and_late() {
        let gold = s(&["g"]);
        assert!((ndcg_at_k(&s(&["g", "x"]), &gold, 5) - 1.0).abs() < 1e-9);
        // gold at rank 2: dcg = 1/log2(3), idcg = 1/log2(2) = 1
        let expect = 1.0 / 3f64.log2();
        assert!((ndcg_at_k(&s(&["x", "g"]), &gold, 5) - expect).abs() < 1e-9);
    }

    // ── abstention (retrieval-confidence gate) ──

    /// Answerable scores cleanly above `_abs` scores → the gate separates them
    /// perfectly: balanced accuracy, Abstention@τ*, and F1 all == 1.0.
    #[test]
    fn abstention_perfect_separation() {
        let samples = vec![
            (0.9, false),
            (0.9, false),
            (0.9, false),
            (0.1, true),
            (0.1, true),
        ];
        let r = abstention_curve(&samples);
        assert!(r.available);
        assert_eq!(r.n_ans, 3);
        assert_eq!(r.n_abs, 2);
        assert!((r.balanced_acc - 1.0).abs() < 1e-9);
        assert!((r.accuracy - 1.0).abs() < 1e-9);
        assert!((r.f1 - 1.0).abs() < 1e-9);
        assert!((r.precision - 1.0).abs() < 1e-9);
        assert!((r.recall - 1.0).abs() < 1e-9);
        assert!((r.specificity - 1.0).abs() < 1e-9);
        // the empirical proof the signal exists: answerable score > `_abs` score
        assert!(r.ans_mean > r.abs_mean);
    }

    /// Identical scores carry no signal → balanced accuracy collapses to 0.5
    /// (chance), τ* is finite, and the sweep never panics on the degenerate
    /// (zero-variance) distribution.
    #[test]
    fn abstention_no_separation() {
        let samples = vec![(0.5, false), (0.5, false), (0.5, true), (0.5, true)];
        let r = abstention_curve(&samples);
        assert!(r.available);
        assert!((r.balanced_acc - 0.5).abs() < 1e-9);
        assert!(r.tau_star.is_finite());
        assert!((r.ans_mean - r.abs_mean).abs() < 1e-9);
    }

    /// 3 `_abs` vs 9 answerable, cleanly separated: balanced accuracy is robust
    /// to the imbalance and precision/recall/accuracy all hit 1.0 (raw accuracy
    /// alone could be gamed by always-answer, but not here).
    #[test]
    fn abstention_imbalance() {
        let mut samples = vec![(0.2, true), (0.2, true), (0.2, true)];
        for _ in 0..9 {
            samples.push((0.8, false));
        }
        let r = abstention_curve(&samples);
        assert!(r.available);
        assert_eq!(r.n_abs, 3);
        assert_eq!(r.n_ans, 9);
        assert!((r.accuracy - 1.0).abs() < 1e-9);
        assert!((r.precision - 1.0).abs() < 1e-9);
        assert!((r.recall - 1.0).abs() < 1e-9);
    }

    /// A slice with no `_abs` (or no answerable) question leaves the gate
    /// undefined → the N/A sentinel, never a divide-by-zero.
    #[test]
    fn abstention_empty_abs() {
        let r = abstention_curve(&[(0.5, false), (0.6, false)]);
        assert!(!r.available);
        assert_eq!(r.n_abs, 0);
        // the all-`_abs` mirror is equally undefined
        let r2 = abstention_curve(&[(0.5, true), (0.6, true)]);
        assert!(!r2.available);
    }

    /// When two thresholds tie on balanced accuracy, the sweep prefers the
    /// larger τ (more willing to abstain). Here τ=0.3 and τ=0.5 both classify
    /// perfectly; τ* must be the larger, 0.5.
    #[test]
    fn abstention_tie_break_larger_tau() {
        let samples = vec![(0.1, true), (0.5, false), (0.5, false)];
        let r = abstention_curve(&samples);
        assert!(r.available);
        assert!((r.balanced_acc - 1.0).abs() < 1e-9);
        assert!((r.tau_star - 0.5).abs() < 1e-9);
    }
}
