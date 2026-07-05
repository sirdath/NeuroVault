//! Graphify end-to-end integration test.
//!
//! Boots the REAL loopback axum server on a test port, graphifies a
//! multi-language fixture repo over HTTP, and asserts every /api/code/*
//! endpoint plus the /api/graph payload the UI consumes. This is the
//! headless equivalent of "open the app, graphify a repo, look at the
//! graph" — it exercises handler wiring, brain resolution, SQL, and
//! response shapes that unit tests can't.
//!
//! ISOLATION: same pattern as retrieval_integration.rs — a single
//! #[tokio::test] pointing NEUROVAULT_HOME at a unique temp dir, so it
//! never touches a real brain and leaves no residue. No embedder is
//! needed (graphify is pure tree-sitter + SQL), so the test runs in
//! single-digit seconds.

use std::fs;
use std::path::Path;

use neurovault_lib::memory::{db, http_server};

const PORT: u16 = 18987;

fn base() -> String {
    format!("http://127.0.0.1:{PORT}")
}

/// Write the fixture repo: cross-file Rust calls, a Python chain, a TS
/// file, and a node_modules decoy that must be skipped.
fn write_fixture_repo(root: &Path) {
    fs::create_dir_all(root.join("src")).unwrap();
    fs::create_dir_all(root.join("web")).unwrap();
    fs::create_dir_all(root.join("node_modules")).unwrap();

    fs::write(
        root.join("src/engine.rs"),
        "pub struct Engine { pub power: u8 }\n\npub fn build() -> u8 { helper() }\n",
    )
    .unwrap();
    fs::write(root.join("src/util.rs"), "pub fn helper() -> u8 { 1 }\n").unwrap();
    fs::write(
        root.join("app.py"),
        "def py_entry():\n    return py_help()\n\ndef py_help():\n    return 1\n",
    )
    .unwrap();
    fs::write(
        root.join("web/index.ts"),
        "interface Shape { area(): number; }\nfunction compute(r: number): number { return r * r; }\n",
    )
    .unwrap();
    // Decoy: vendored code must NOT be graphified.
    fs::write(root.join("node_modules/junk.rs"), "pub fn vendored() {}\n").unwrap();
}

#[tokio::test]
async fn graphify_end_to_end_over_http() {
    // ---- isolated home + active brain ------------------------------------
    let home = std::env::temp_dir().join(format!("nv_graphify_e2e_{}", std::process::id()));
    let _ = fs::remove_dir_all(&home);
    fs::create_dir_all(&home).unwrap();
    std::env::set_var("NEUROVAULT_HOME", &home);

    fs::write(
        home.join("brains.json"),
        r#"{"active":"codetest","brains":[{"id":"codetest","name":"Code Test"}]}"#,
    )
    .unwrap();

    let repo = home.join("fixture-repo");
    write_fixture_repo(&repo);

    // ---- boot the real server --------------------------------------------
    let mut server = http_server::start_server(Some(PORT))
        .await
        .expect("server should bind the test port");
    let client = reqwest::Client::new();

    // ---- 1. graphify the repo over HTTP -----------------------------------
    let resp: serde_json::Value = client
        .post(format!("{}/api/code/graphify", base()))
        .json(&serde_json::json!({ "path": repo.to_string_lossy() }))
        .send()
        .await
        .expect("graphify request")
        .json()
        .await
        .expect("graphify json");

    assert_eq!(
        resp["files"], 4,
        "engine.rs, util.rs, app.py, index.ts — and NOT node_modules: {resp}"
    );
    assert!(resp["symbols"].as_u64().unwrap() >= 7, "symbols: {resp}");
    assert!(
        resp["edges"].as_u64().unwrap() >= 1,
        "cross-file rust call should produce a file edge: {resp}"
    );

    // ---- 2. where_defined --------------------------------------------------
    let resp: serde_json::Value = client
        .get(format!("{}/api/code/where_defined?symbol=helper", base()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(resp["definitions"][0]["file"], "src/util.rs", "{resp}");

    // ---- 3. who_calls -------------------------------------------------------
    let resp: serde_json::Value = client
        .get(format!("{}/api/code/who_calls?symbol=helper", base()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(resp["callers"][0]["caller"], "build", "{resp}");

    // ---- 4. blast_radius (python chain) -------------------------------------
    let resp: serde_json::Value = client
        .get(format!("{}/api/code/blast_radius?symbol=py_help", base()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(resp["impacted"][0]["name"], "py_entry", "{resp}");

    // ---- 5. whats_in_file by BASENAME (suffix tolerance) --------------------
    let resp: serde_json::Value = client
        .get(format!("{}/api/code/whats_in_file?path=engine.rs", base()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let names: Vec<&str> = resp["symbols"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap())
        .collect();
    assert!(
        names.contains(&"Engine") && names.contains(&"build"),
        "{resp}"
    );
    let build = resp["symbols"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "build")
        .unwrap();
    assert!(
        build["signature"].as_str().unwrap().contains("fn build"),
        "signature should carry the declaration: {build}"
    );

    // ---- 6. fuse: a decision note referencing `helper` links to util.rs -----
    {
        let brain = db::open_brain("codetest").expect("open test brain");
        let conn = brain.lock();
        conn.execute(
            "INSERT INTO engrams (id, filename, title, content, content_hash, kind)
             VALUES ('note-adr','adr.md','ADR 1','Decision: `helper` must stay synchronous.','h1','note')",
            [],
        )
        .unwrap();
    }
    let resp: serde_json::Value = client
        .post(format!("{}/api/code/fuse", base()))
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        resp["links"].as_u64().unwrap() >= 1,
        "fuse should link the ADR: {resp}"
    );

    // ---- 7. the graph the UI renders ----------------------------------------
    let resp: serde_json::Value = client
        .get(format!("{}/api/graph", base()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let nodes = resp["nodes"].as_array().unwrap();
    let code_nodes: Vec<&serde_json::Value> =
        nodes.iter().filter(|n| n["kind"] == "code").collect();
    assert_eq!(
        code_nodes.len(),
        4,
        "4 code files as graph nodes: {}",
        nodes.len()
    );
    assert!(
        code_nodes.iter().any(|n| n["title"] == "src/engine.rs"),
        "code node titled by repo-relative path"
    );

    let edges = resp["edges"].as_array().unwrap();
    assert!(
        edges.iter().any(|e| e["link_type"] == "calls"),
        "graph must carry the gold 'calls' edge: {edges:?}"
    );
    assert!(
        edges.iter().any(|e| e["link_type"] == "references"),
        "graph must carry the note→code 'references' edge: {edges:?}"
    );

    // ---- 8. server-side exclude_types filter --------------------------------
    // The low-power graph view drops edge types at the SOURCE. exclude_types=
    // calls must remove the 'calls' edges, keep the other types, and leave the
    // node set untouched.
    let filtered: serde_json::Value = client
        .get(format!("{}/api/graph?exclude_types=calls", base()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let fedges = filtered["edges"].as_array().unwrap();
    assert!(
        !fedges.iter().any(|e| e["link_type"] == "calls"),
        "exclude_types=calls must drop the 'calls' edges: {fedges:?}"
    );
    assert!(
        fedges.iter().any(|e| e["link_type"] == "references"),
        "exclude_types=calls must keep other edge types: {fedges:?}"
    );
    assert_eq!(
        filtered["nodes"].as_array().unwrap().len(),
        nodes.len(),
        "an edge-type filter must not change the node set"
    );

    // ---- teardown ------------------------------------------------------------
    server.stop().await;
    let _ = fs::remove_dir_all(&home);
}
