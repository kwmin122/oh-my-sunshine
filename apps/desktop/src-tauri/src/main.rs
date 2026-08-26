// Minimal Tauri boundary (spec §14.1): the shell hosts the web UI, spawns the
// bundled daemon sidecar (S8), and talks to it over localhost HTTP/WS.
// No orchestration logic lives in Rust.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Holds the spawned daemon process so the shell can stop it on exit —
/// no orphaned daemon may outlive the .app (S8 DoD step 9).
struct DaemonState(Mutex<Option<CommandChild>>);

#[tauri::command]
fn daemon_origin() -> String {
    std::env::var("DEVFLOW_DAEMON_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:47710".into())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(DaemonState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![daemon_origin])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match handle.shell().sidecar("devflow-daemon") {
                    Ok(sidecar) => {
                        // GUI launches have cwd=/ — give the daemon an explicit,
                        // writable state directory instead of its relative default.
                        let data_dir = handle
                            .path()
                            .app_data_dir()
                            .map(|p| p.join("devflow"))
                            .unwrap_or_else(|_| std::path::PathBuf::from(".devflow-data"));
                        if let Some(parent) = data_dir.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        let _ = std::fs::create_dir_all(&data_dir);
                        match sidecar
                            .env("DEVFLOW_DATA_DIR", data_dir.to_string_lossy().to_string())
                            .env("DEVFLOW_HTTP_HOST", "127.0.0.1")
                            .spawn()
                        {
                            Ok((_rx, child)) => {
                                println!("[devflow] daemon sidecar spawned");
                                *handle.state::<DaemonState>().0.lock().unwrap() = Some(child);
                            }
                            Err(err) => eprintln!("[devflow] failed to spawn daemon sidecar: {err}"),
                        }
                    }
                    Err(err) => eprintln!("[devflow] failed to resolve devflow-daemon sidecar: {err}"),
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building DevFlow desktop shell")
        .run(|app_handle, event| {
            // Stop the daemon on both the final exit and a quit request so no
            // orphan survives regardless of how the app is closed.
            match event {
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    if let Some(child) = app_handle.state::<DaemonState>().0.lock().unwrap().take() {
                        println!("[devflow] stopping daemon sidecar");
                        let _ = child.kill();
                    }
                }
                _ => {}
            }
        });
}
