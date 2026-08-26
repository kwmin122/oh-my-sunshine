// Minimal Tauri boundary (spec §14.1): the shell only hosts the web UI and talks to
// the daemon over localhost HTTP/WS. No orchestration logic lives in Rust.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tauri::command]
fn daemon_origin() -> String {
    std::env::var("DEVFLOW_DAEMON_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:47710".into())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![daemon_origin])
        .run(tauri::generate_context!())
        .expect("error while running DevFlow desktop shell");
}
