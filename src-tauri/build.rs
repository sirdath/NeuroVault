fn main() {
    // `tauri_build::build()` wires up the GUI app (icons, capabilities,
    // generated context) and panics when the `tauri` dependency isn't active.
    // The headless build (`--no-default-features`, i.e. no `gui` feature) drops
    // Tauri entirely, so skip it there. Cargo exposes enabled features to build
    // scripts as `CARGO_FEATURE_<NAME>`.
    if std::env::var_os("CARGO_FEATURE_GUI").is_some() {
        tauri_build::build();
    }
}
