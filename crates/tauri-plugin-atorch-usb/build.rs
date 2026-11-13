fn main() {
    // This plugin is called by the Rust device service. It exposes no JavaScript commands.
    tauri_plugin::Builder::new(&[])
        .android_path("android")
        .build();
}
