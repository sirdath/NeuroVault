//! NeuroVault crate root.
//!
//! `memory` is the engine — pure, GUI-free, and the only thing the headless
//! binaries (`neurovault-server`, `nv-bench`, `neurovault-api`) compile
//! against. Everything Tauri/desktop lives in `app`, gated behind the `gui`
//! feature (default ON). A `--no-default-features` build therefore drops Tauri
//! entirely and produces a headless binary that links no WebKit/GTK — which is
//! exactly what lets `neurovault-server` run on a server / Docker / CI box (the
//! GUI build links those as system frameworks on macOS, but as dynamic .so on
//! Linux, where they would fail to load on a headless host).

pub mod memory;

#[cfg(feature = "gui")]
mod app;

#[cfg(feature = "gui")]
pub use app::run;
