//! Adaptive Memory scenario test — the "consulting room" story as a
//! regression gate (docs/specs/adaptive-memory.md, acceptance §12).
//!
//! Mirrors the live scenario run on 2026-07-10 that shook out three
//! real defects (CE-gated briefing decisions, CE-gated recent changes,
//! narrow find_source patterns). Everything here runs WITHOUT the
//! cross-encoder model: continue_work is structural (zero retrieval),
//! and the retrieval-touching steps use an empty/near-empty corpus so
//! the pooled rerank never fires. The heavier semantic behavior is
//! covered by the live `ambient test` CLI and the unit gate-matrix.
//!
//! ISOLATION (same discipline as retrieval_integration.rs): ONE test
//! fn, unique temp NEUROVAULT_HOME, no parallel env-var races, no
//! residue in ~/.neurovault.

use neurovault_lib::memory::adaptive::types::{
    load_working_state, save_working_state, WorkingState,
};
use neurovault_lib::memory::adaptive::Scope;
use neurovault_lib::memory::ambient::{run_at, AmbientQueryPacket};
use neurovault_lib::memory::{db, todos};

fn packet(prompt: &str, intent: Option<&str>) -> AmbientQueryPacket {
    AmbientQueryPacket {
        prompt: prompt.to_string(),
        host: Some("scenario-test".into()),
        event: Some("UserPromptSubmit".into()),
        intent: intent.map(String::from),
        room: Some("clients/acme".into()),
        ..Default::default()
    }
}

#[test]
fn consulting_room_story() {
    // --- isolation: unique temp NEUROVAULT_HOME ---
    let home = std::env::temp_dir().join(format!(
        "nv-adaptive-scenario-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("NEUROVAULT_HOME", &home);

    let brain_id = "scenario";
    let brain = db::open_brain(brain_id).expect("open temp brain");
    let scope = Scope::room(brain_id, "clients/acme");
    let cfg = home.join("ambient.json"); // absent -> defaults
    let log = home.join("logs").join("ambient.jsonl");

    // ------------------------------------------------------------------
    // 1. "continue" with NO working state: router matches, falls back,
    //    the glue guard keeps it silent. (Acceptance: "continue" must
    //    never inject random old chunks.)
    // ------------------------------------------------------------------
    let resp = run_at(&brain, brain_id, &packet("continue", None), &cfg, &log).unwrap();
    assert_eq!(resp.decision, "silent", "{}", resp.reason);
    assert_eq!(resp.intent.as_deref(), Some("general_question"));

    // ------------------------------------------------------------------
    // 2. An agent reports working state + a task lands in the queue.
    // ------------------------------------------------------------------
    let mut ws = WorkingState::default();
    ws.apply(
        WorkingState {
            current_task: Some("Revising the Acme pricing deck".into()),
            next_step: Some("send one-page summary to Elena".into()),
            last_files: vec!["clients/acme/deck-v3.md".into()],
            updated_by: Some("scenario-test".into()),
            ..Default::default()
        },
        time::OffsetDateTime::now_utc(),
    );
    save_working_state(&scope, &ws).unwrap();
    assert!(!load_working_state(&scope).is_empty());

    todos::add_todo(
        brain_id,
        todos::AddTodoArgs {
            text: "Send revised pricing deck to Elena before Friday".into(),
            agent_match: None,
            priority: Some("high".into()),
            created_by: Some("scenario-test".into()),
            note: None,
            kind: None,
            payload: None,
            source_engram: None,
        },
    )
    .unwrap();

    // ------------------------------------------------------------------
    // 3. "continue" now reconstructs the situation — structural path,
    //    no retrieval, no models, and it must carry state + task.
    // ------------------------------------------------------------------
    let resp = run_at(&brain, brain_id, &packet("continue", None), &cfg, &log).unwrap();
    assert_eq!(resp.decision, "inject", "{}", resp.reason);
    assert_eq!(resp.intent.as_deref(), Some("continue_work"));
    let block = resp.context_block.as_deref().unwrap();
    assert!(block.contains("intent=\"continue_work\""));
    assert!(block.contains("Revising the Acme pricing deck"), "{block}");
    assert!(block.contains("next: send one-page summary to Elena"));
    assert!(block.contains("[T-"), "task line present: {block}");
    assert!(block.contains("(high priority)"));
    assert!(
        block.contains("Why this context was injected"),
        "why-footer required"
    );
    // Injection-as-data: nothing inside the wrapper may carry angle
    // brackets (the fields above came through sanitize).
    let inner = block
        .trim_start_matches("<neurovault_context")
        .trim_end_matches("</neurovault_context>");
    let after_tag = &inner[inner.find('>').map(|i| i + 1).unwrap_or(0)..];
    assert!(
        !after_tag.contains('<') && !after_tag.contains('>'),
        "no tag-shaped content inside the packet"
    );

    // ------------------------------------------------------------------
    // 4. Same session dedup contract: structural items carry no engram
    //    ids (nothing to poison the seen-file), so repeated "continue"
    //    keeps working — state is a live buffer, not a memory.
    // ------------------------------------------------------------------
    assert!(resp.memories.is_empty(), "structural items are not engrams");
    let again = run_at(&brain, brain_id, &packet("continue", None), &cfg, &log).unwrap();
    assert_eq!(again.decision, "inject", "continue stays available");

    // ------------------------------------------------------------------
    // 5. Stale state: age the buffer past the threshold — continue
    //    still answers (freshness gates the ROUTER via ws_fresh, and a
    //    stale-but-present state must be FLAGGED, never silently
    //    presented as current). With stale state the router falls back
    //    (working_state_fresh=false) and the glue guard silences.
    // ------------------------------------------------------------------
    let mut stale = load_working_state(&scope);
    stale.updated_at = Some("2020-01-01T00:00:00Z".into());
    save_working_state(&scope, &stale).unwrap();
    let resp = run_at(&brain, brain_id, &packet("continue", None), &cfg, &log).unwrap();
    assert_eq!(
        resp.decision, "silent",
        "stale working state must not answer 'continue': {}",
        resp.reason
    );

    // ------------------------------------------------------------------
    // 6. Forced intent on an empty corpus: prepare_brief injects the
    //    structural sections (tasks) and reports semantic sections as
    //    skipped/empty rather than erroring. (Working state is stale
    //    now, so only tasks carry.) No reranker model is loaded: the
    //    empty corpus yields no candidates to pool.
    // ------------------------------------------------------------------
    let resp = run_at(
        &brain,
        brain_id,
        &packet(
            "prepare me for the steering committee",
            Some("prepare_brief"),
        ),
        &cfg,
        &log,
    )
    .unwrap();
    assert_eq!(resp.intent.as_deref(), Some("prepare_brief"));
    assert_eq!(resp.decision, "inject", "{}", resp.reason);
    let block = resp.context_block.as_deref().unwrap();
    assert!(block.contains("Open tasks"));

    // ------------------------------------------------------------------
    // 6b. temporal_diff: a reconstructed change brief, not recent
    //     memories. The task created above must appear as a change
    //     event; asking again immediately ("what did i miss") uses the
    //     last-seen marker and reports no meaningful changes — stated
    //     explicitly, never silent. Pure SQL/jsonl: no models.
    // ------------------------------------------------------------------
    let resp = run_at(
        &brain,
        brain_id,
        &packet("what changed since yesterday?", None),
        &cfg,
        &log,
    )
    .unwrap();
    assert_eq!(resp.intent.as_deref(), Some("temporal_diff"));
    assert_eq!(resp.decision, "inject", "{}", resp.reason);
    let block = resp.context_block.as_deref().unwrap();
    assert!(block.contains("<neurovault_temporal_diff"), "{block}");
    assert!(block.contains("Time window:"));
    assert!(
        block.contains("Send revised pricing deck"),
        "task change event present: {block}"
    );
    assert!(block.contains("Recommended next action:"), "{block}");
    assert!(resp.reason.contains("Yesterday"), "{}", resp.reason);

    // marker written -> "what did i miss" anchors on it; nothing new
    // happened in between, so the brief says so explicitly.
    let resp = run_at(
        &brain,
        brain_id,
        &packet("what did i miss?", None),
        &cfg,
        &log,
    )
    .unwrap();
    assert_eq!(resp.intent.as_deref(), Some("temporal_diff"));
    assert_eq!(resp.decision, "inject");
    let block = resp.context_block.as_deref().unwrap();
    assert!(
        block.contains("No meaningful changes"),
        "explicit no-change brief: {block}"
    );
    assert!(resp.reason.contains("SinceLastSession"), "{}", resp.reason);

    // ------------------------------------------------------------------
    // 7. The decision log recorded every event above, one JSON line
    //    each, with intent fields — the Inspector's substrate.
    // ------------------------------------------------------------------
    let raw = std::fs::read_to_string(&log).unwrap();
    let lines: Vec<serde_json::Value> = raw
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert!(
        lines.len() >= 7,
        "one record per event, got {}",
        lines.len()
    );
    assert!(lines
        .iter()
        .any(|r| r["intent"] == "temporal_diff" && r["sections"][0]["title"] == "Change events"));
    assert!(lines
        .iter()
        .any(|r| r["intent"] == "continue_work" && r["decision"] == "inject"));
    assert!(
        lines.iter().all(|r| r["prompt_text"].is_null()),
        "prompt text must not be logged by default"
    );

    // cleanup best-effort
    std::env::remove_var("NEUROVAULT_HOME");
    let _ = std::fs::remove_dir_all(&home);
}
