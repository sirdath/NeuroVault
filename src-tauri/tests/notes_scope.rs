//! Locks the brain-scoping guarantee that `notes_list` relies on: a
//! per-brain note listing must return ONLY that brain's notes. The
//! Home gallery's most-used hover leaked the active brain's notes for
//! every card because the handler ignored `?brain=` (fixed 2026-07-12);
//! this proves the underlying data path is brain-isolated so the
//! handler's `resolve_brain_id(brain)` fix is meaningful.

use neurovault_lib::memory::write_ops::{save_note, BrainContext};
use neurovault_lib::memory::{db, paths, read_ops};

#[test]
fn list_notes_is_brain_scoped() {
    let home = std::env::temp_dir().join(format!(
        "nv-notes-scope-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("NEUROVAULT_HOME", &home);

    std::fs::write(
        home.join("brains.json"),
        r#"{"active":"alpha","brains":[{"id":"alpha","name":"Alpha"},{"id":"beta","name":"Beta"}]}"#,
    )
    .unwrap();

    // Resolving a brain opens its db, which load_extension()s sqlite-vec; the
    // server's default candidate paths don't resolve from target/<profile>/deps/,
    // so point at the shipped extension — as the other integration suites do.
    let vec0_file = if cfg!(target_os = "windows") {
        "vec0.dll"
    } else if cfg!(target_os = "macos") {
        "vec0.dylib"
    } else {
        "vec0.so"
    };
    let vec0 = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(vec0_file);
    assert!(
        vec0.exists(),
        "{vec0_file} missing at {vec0:?} — build resources are incomplete \
         (CI downloads it on Linux; for a local run, fetch the matching \
         sqlite-vec loadable into src-tauri/resources/)"
    );
    std::env::set_var("NEUROVAULT_VEC_EXTENSION", &vec0);

    // Two brains, a distinct note in each.
    for (brain, title) in [("alpha", "Alpha-only note"), ("beta", "Beta-only note")] {
        let vault = paths::vault_dir(brain);
        std::fs::create_dir_all(&vault).unwrap();
        let ctx = BrainContext::resolve(Some(brain), vault).unwrap();
        save_note(&ctx, "n.md", &format!("# {title}\n\nbody")).unwrap();
    }

    let alpha = db::open_brain("alpha").unwrap();
    let beta = db::open_brain("beta").unwrap();
    let a = read_ops::list_notes(&alpha).unwrap();
    let b = read_ops::list_notes(&beta).unwrap();

    assert!(a.iter().any(|n| n.title.contains("Alpha-only")));
    assert!(
        !a.iter().any(|n| n.title.contains("Beta-only")),
        "alpha leaked beta"
    );
    assert!(b.iter().any(|n| n.title.contains("Beta-only")));
    assert!(
        !b.iter().any(|n| n.title.contains("Alpha-only")),
        "beta leaked alpha"
    );

    std::env::remove_var("NEUROVAULT_HOME");
    let _ = std::fs::remove_dir_all(&home);
}
