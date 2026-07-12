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

    // Two brains, a distinct note in each.
    for (brain, title) in [("alpha", "Alpha-only note"), ("beta", "Beta-only note")] {
        let ctx = BrainContext::resolve(Some(brain), paths::vault_dir(brain)).unwrap();
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
