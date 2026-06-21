// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// The `neurovault` desktop binary only exists in a GUI build. `run()` lives in
// the gui-gated `app` module, so it is present only with the default `gui`
// feature.
#[cfg(feature = "gui")]
fn main() {
    neurovault_lib::run()
}

// A `--no-default-features` build (the headless `neurovault-server` path, plus
// `cargo test` / `nv-bench`) still compiles this bin target, so it needs a
// `main` symbol — it just isn't the desktop app.
#[cfg(not(feature = "gui"))]
fn main() {
    eprintln!(
        "neurovault: this is the desktop app binary; build it with the default `gui` feature \
         (plain `cargo build` / `tauri dev`). For the headless server, use `neurovault-server`."
    );
    std::process::exit(1);
}
