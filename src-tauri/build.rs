fn main() {
    // `tauri_build::build()` wires up the GUI app (icons, capabilities,
    // generated context) and panics when the `tauri` dependency isn't active.
    // The headless build (`--no-default-features`, i.e. no `gui` feature) drops
    // Tauri entirely, so skip it there. Cargo exposes enabled features to build
    // scripts as `CARGO_FEATURE_<NAME>`.
    if std::env::var_os("CARGO_FEATURE_APP_STORE").is_some() {
        let raw = std::env::var("TAURI_CONFIG").unwrap_or_else(|_| {
            panic!(
                "App Store builds must run through scripts/build-app-store.mjs so the effective \
                 Tauri configuration is explicit and isolated"
            )
        });
        let config: serde_json::Value = serde_json::from_str(&raw)
            .unwrap_or_else(|error| panic!("invalid TAURI_CONFIG for App Store build: {error}"));
        assert_eq!(
            config
                .pointer("/app/macOSPrivateApi")
                .and_then(|v| v.as_bool()),
            Some(false),
            "App Store builds require app.macOSPrivateApi=false in the effective Tauri config"
        );
    }

    if std::env::var_os("CARGO_FEATURE_GUI").is_some() {
        tauri_build::build();
    }
}
