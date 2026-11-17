use std::env;
use tauri_utils::{config::FrontendDist, platform::Target};

fn main() {
    if !tauri_build::is_dev() {
        check_embedded_frontend();
    }
    tauri_build::build()
}

fn check_embedded_frontend() {
    let root = env::current_dir().expect("cannot find the Tauri configuration directory");
    let target = Target::from_triple(&env::var("TARGET").expect("missing Cargo target"));
    let (mut config, _) = tauri_utils::config::parse::read_from(target, &root)
        .expect("cannot read the Tauri configuration");
    if let Ok(overrides) = env::var("TAURI_CONFIG") {
        let overrides = serde_json::from_str(&overrides).expect("invalid TAURI_CONFIG JSON");
        json_patch::merge(&mut config, &overrides);
    }
    let config: tauri_utils::config::Config =
        serde_json::from_value(config).expect("invalid Tauri configuration");

    // Tauri tries URLs before paths: a Windows D:/... path becomes a URL and
    // silently disables asset embedding. Production builds must be self-contained.
    let Some(FrontendDist::Directory(path)) = config.build.frontend_dist else {
        panic!(
            "Atorch Load must embed its frontend. Set build.frontendDist to a relative \
             directory containing index.html (for example ../dist); Windows drive paths \
             such as D:/... are interpreted as URLs and do not embed any assets."
        );
    };
    assert!(
        path.is_relative(),
        "build.frontendDist must be relative to src-tauri so releases are portable"
    );
    let assets = root.join(&path);
    assert!(
        assets.join("index.html").is_file(),
        "frontend entry point is missing: {}. Build the frontend before packaging.",
        assets.join("index.html").display()
    );
    println!("cargo:rerun-if-changed={}", assets.display());
}
