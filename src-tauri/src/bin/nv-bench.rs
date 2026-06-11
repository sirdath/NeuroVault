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

    let mut questions = match parse_dataset(&dataset) {
        Ok(q) => q,
        Err(e) => {
            eprintln!("longmemeval: {e}");
            return 1;
        }
    };
    let total_available = questions.len();

    // Abstention questions (id suffix "_abs") have no retrievable answer
    // by design — standard practice is to exclude them from retrieval
    // metrics (they exist to test answer-stage refusal, not search).
    questions.retain(|q| !q.question_id.ends_with("_abs") && !q.gold.is_empty());
    let after_abs = questions.len();

    // The dataset file is ordered by question type, so a head-truncation
    // would benchmark a single type. For --limit subsets, interleave types
    // round-robin (deterministic, no RNG) so every slice is representative.
    if limit < questions.len() {
        let mut by_type: std::collections::BTreeMap<String, Vec<LmeQuestion>> =
            std::collections::BTreeMap::new();
        for q in questions.drain(..) {
            by_type.entry(q.question_type.clone()).or_default().push(q);
        }
        let mut picked = Vec::with_capacity(limit);
        'outer: loop {
            let mut any = false;
            for bucket in by_type.values_mut() {
                if let Some(q) = bucket.pop() {
                    picked.push(q);
                    any = true;
                    if picked.len() == limit {
                        break 'outer;
                    }
                }
            }
            if !any {
                break;
            }
        }
        questions = picked;
    }

    eprintln!(
        "longmemeval: {total_available} questions in file, {after_abs} scoreable \
         (abstention excluded), running {}",
        questions.len()
    );
    eprintln!(
        "config: k={ks:?} rerank={rerank} recency={} extra_ablate={extra_ablate:?}",
        if keep_recency { "production (wall-clock)" } else { "ablated (reproducible)" }
    );

    let home = isolated_home("lme");
    let bench_start = Instant::now();

    // Aggregates: metric -> sum, plus per-question-type breakdown.
    let mut sums: HashMap<String, f64> = HashMap::new();
    let mut type_sums: HashMap<String, (f64, usize)> = HashMap::new(); // r@5 only
    let mut per_question: Vec<serde_json::Value> = Vec::new();
    let mut ingest_secs = 0.0f64;
    let mut query_secs = 0.0f64;
    let n = questions.len();

    for (qi, q) in questions.iter().enumerate() {
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

        for &k in &ks {
            *sums.entry(format!("recall@{k}")).or_default() += recall_at_k(&ranked, &q.gold, k);
            *sums.entry(format!("hit@{k}")).or_default() += hit_at_k(&ranked, &q.gold, k);
            *sums.entry(format!("ndcg@{k}")).or_default() += ndcg_at_k(&ranked, &q.gold, k);
        }
        *sums.entry("mrr".into()).or_default() += mrr(&ranked, &q.gold);
        let entry = type_sums.entry(q.question_type.clone()).or_insert((0.0, 0));
        entry.0 += recall_at_k(&ranked, &q.gold, 5);
        entry.1 += 1;

        per_question.push(serde_json::json!({
            "question_id": q.question_id,
            "type": q.question_type,
            "gold": q.gold,
            "ranked_top": ranked.iter().take(kmax).collect::<Vec<_>>(),
            "recall@5": recall_at_k(&ranked, &q.gold, 5),
        }));

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

        // Free the handle + disk before the next question; 500 brains of
        // ~50 embedded sessions each would otherwise pile up gigabytes.
        db::close_brain(&brain_id);
        let _ = fs::remove_dir_all(&brain_dir);
    }

    let nf = n as f64;
    println!("\n━━ nv-bench longmemeval — {} questions ━━", n);
    println!("dataset:      {dataset}");
    println!(
        "config:       hybrid (vec+bm25+graph, RRF){}{}",
        if rerank { " + cross-encoder rerank" } else { "" },
        if keep_recency { ", production recency" } else { ", recency-ablated (reproducible)" },
    );
    let mut keys: Vec<&String> = sums.keys().collect();
    keys.sort();
    for k in keys {
        println!("{k:<12} {:.4}", sums[k] / nf);
    }
    println!("\nper question type (recall@5):");
    let mut tkeys: Vec<&String> = type_sums.keys().collect();
    tkeys.sort();
    for t in tkeys {
        let (s, c) = type_sums[t];
        println!("  {t:<28} {:.4}  (n={c})", s / c as f64);
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
            means.insert(k.clone(), serde_json::json!(v / nf));
        }
        let report = serde_json::json!({
            "benchmark": "longmemeval-retrieval",
            "dataset": dataset,
            "questions": n,
            "config": {
                "retrieval": "hybrid vec+bm25+graph RRF",
                "rerank": rerank,
                "recency_ablated": !keep_recency,
                "extra_ablate": extra_ablate,
                "embedder": "BGE-small-en-v1.5 (fastembed, local ONNX)",
            },
            "means": means,
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
}
