use serde::Serialize;
use tauri::Manager;
mod plaud;
#[cfg(desktop)]
mod desktop_exports;

#[cfg(desktop)]
use std::{fs, net::UdpSocket, path::PathBuf};
#[cfg(desktop)]
use std::sync::Mutex;
#[cfg(desktop)]
use tauri::path::BaseDirectory;
#[cfg(desktop)]
use tauri::RunEvent;
#[cfg(desktop)]
use tauri_plugin_shell::{process::CommandChild, ShellExt};

#[cfg(desktop)]
const SERVICE_PORT: u16 = 3487;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
  mode: &'static str,
  service_origin: Option<String>,
  pairing_token: Option<String>,
  lan_address: Option<String>,
}

#[cfg(desktop)]
struct SidecarState(Mutex<Option<CommandChild>>);

#[tauri::command]
fn runtime_info(info: tauri::State<'_, RuntimeInfo>) -> RuntimeInfo {
  info.inner().clone()
}

#[cfg(desktop)]
fn local_lan_address() -> Option<String> {
  let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
  socket.connect("8.8.8.8:80").ok()?;
  let ip = socket.local_addr().ok()?.ip();
  Some(format!("http://{ip}:{SERVICE_PORT}"))
}

#[cfg(desktop)]
fn read_or_create_token(app_data_dir: &PathBuf) -> Result<String, Box<dyn std::error::Error>> {
  let token_path = app_data_dir.join("pairing-token");
  if let Ok(token) = fs::read_to_string(&token_path) {
    let token = token.trim();
    if !token.is_empty() {
      return Ok(token.to_owned());
    }
  }
  let token = uuid::Uuid::new_v4().simple().to_string();
  fs::write(token_path, &token)?;
  Ok(token)
}

#[cfg(desktop)]
fn start_service(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
  let app_data_dir = app.path().app_data_dir()?;
  fs::create_dir_all(&app_data_dir)?;
  let library_dir = app_data_dir.join("recordings");
  fs::create_dir_all(&library_dir)?;
  let pairing_token = read_or_create_token(&app_data_dir)?;
  let scan_script = app.path().resolve("resources/scan-plaud.swift", BaseDirectory::Resource)?;
  let ble_script = app.path().resolve("resources/plaud-bridge.swift", BaseDirectory::Resource)?;

  let command = app
    .shell()
    .sidecar("openplod-server")?
    .current_dir(&app_data_dir)
    .env("HOST", "0.0.0.0")
    .env("PORT", SERVICE_PORT.to_string())
    .env("DATABASE_URL", app_data_dir.join("openplod.db"))
    .env("OPENPLOD_LIBRARY_PATH", library_dir)
    .env("OPENPLOD_PAIRING_TOKEN", &pairing_token)
    .env("OPENPLOD_BLE_SCRIPT", ble_script)
    .env("OPENPLOD_SCAN_SCRIPT", scan_script);
  let (mut events, child) = command.spawn()?;
  tauri::async_runtime::spawn(async move {
    // Drain sidecar output without persisting potentially private request details.
    while events.recv().await.is_some() {}
  });

  app.manage(SidecarState(Mutex::new(Some(child))));
  app.manage(RuntimeInfo {
    mode: "desktop",
    service_origin: Some(format!("http://127.0.0.1:{SERVICE_PORT}")),
    pairing_token: Some(pairing_token),
    lan_address: local_lan_address(),
  });
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    .plugin(plaud::init())
    .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      #[cfg(desktop)]
      start_service(app)?;

      #[cfg(mobile)]
      app.manage(RuntimeInfo {
        mode: "mobile",
        service_origin: None,
        pairing_token: None,
        lan_address: None,
      });

      Ok(())
    });

  #[cfg(desktop)]
  let builder = builder.invoke_handler(tauri::generate_handler![
    runtime_info, plaud::plaud_command, desktop_exports::export_document, desktop_exports::export_audio
  ]);
  #[cfg(mobile)]
  let builder = builder.invoke_handler(tauri::generate_handler![runtime_info, plaud::plaud_command]);

  builder
    .build(tauri::generate_context!())
    .expect("error while building OpenPlod")
    .run(|_app_handle, _event| {
      #[cfg(desktop)]
      if matches!(_event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
        if let Some(state) = _app_handle.try_state::<SidecarState>() {
          if let Ok(mut child) = state.0.lock() {
            if let Some(child) = child.take() {
              let _ = child.kill();
            }
          }
        }
      }
    });
}
