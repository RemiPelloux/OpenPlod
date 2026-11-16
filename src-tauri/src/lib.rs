use serde::Serialize;
use tauri::Manager;
mod plaud;
#[cfg(desktop)]
mod desktop_exports;

#[cfg(desktop)]
use std::{fs, net::UdpSocket, path::PathBuf};
#[cfg(desktop)]
use std::sync::Mutex;
// Only the opt-in macOS Swift fallback resolves bundled resources.
#[cfg(all(desktop, target_os = "macos"))]
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
  updater_enabled: bool,
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
      #[cfg(unix)]
      {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&token_path, fs::Permissions::from_mode(0o600))?;
      }
      return Ok(token.to_owned());
    }
  }
  let token = uuid::Uuid::new_v4().simple().to_string();
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    use std::io::Write;
    fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&token_path)?.write_all(token.as_bytes())?;
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&token_path, fs::Permissions::from_mode(0o600))?;
  }
  #[cfg(not(unix))]
  fs::write(&token_path, &token)?;
  Ok(token)
}

#[cfg(desktop)]
fn ble_bridge_path() -> Option<PathBuf> {
  let directory = std::env::current_exe().ok()?.parent()?.to_path_buf();
  let name = if cfg!(windows) { "plaud-bridge.exe" } else { "plaud-bridge" };
  let path = directory.join(name);
  path.is_file().then_some(path)
}

#[cfg(desktop)]
fn spawn_sidecar(app: &tauri::AppHandle, pairing_token: &str) -> Result<CommandChild, Box<dyn std::error::Error>> {
  let app_data_dir = app.path().app_data_dir()?;
  let library_dir = app_data_dir.join("recordings");

  let command = app
    .shell()
    .sidecar("openplod-server")?
    .current_dir(&app_data_dir)
    .env("HOST", "0.0.0.0")
    .env("PORT", SERVICE_PORT.to_string())
    .env("DATABASE_URL", app_data_dir.join("openplod.db"))
    .env("OPENPLOD_LIBRARY_PATH", library_dir)
    .env("OPENPLOD_PAIRING_TOKEN", pairing_token);
  // Every desktop platform speaks Bluetooth through the same bundled
  // `plaud-bridge` binary (CoreBluetooth, BlueZ or WinRT under one protocol).
  let command = match ble_bridge_path() {
    Some(bridge) => command.env("OPENPLOD_BLE_BRIDGE", bridge),
    None => command,
  };
  // The macOS Swift helpers remain shipped as an opt-in fallback backend
  // (`OPENPLOD_BLE_BACKEND=swift`); they are never selected automatically.
  #[cfg(target_os = "macos")]
  let command = command
    .env(
      "OPENPLOD_BLE_SCRIPT",
      app.path().resolve("resources/plaud-bridge.swift", BaseDirectory::Resource)?,
    )
    .env(
      "OPENPLOD_SCAN_SCRIPT",
      app.path().resolve("resources/scan-plaud.swift", BaseDirectory::Resource)?,
    );
  let (mut events, child) = command.spawn()?;
  tauri::async_runtime::spawn(async move {
    // Drain sidecar output without persisting potentially private request details.
    while events.recv().await.is_some() {}
  });

  Ok(child)
}

#[cfg(desktop)]
fn initialize_desktop_runtime(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
  let app_data_dir = app.path().app_data_dir()?;
  fs::create_dir_all(app_data_dir.join("recordings"))?;
  let pairing_token = read_or_create_token(&app_data_dir)?;
  let updater_enabled = app.config().plugins.0.get("updater")
    .and_then(|value| value.get("pubkey")).and_then(|value| value.as_str())
    .is_some_and(|key| !key.trim().is_empty());
  // Starting the sidecar resumes queued jobs. Wait for the startup update decision.
  let child = if updater_enabled { None } else { Some(spawn_sidecar(app.handle(), &pairing_token)?) };
  app.manage(SidecarState(Mutex::new(child)));
  app.manage(RuntimeInfo {
    mode: "desktop",
    service_origin: Some(format!("http://127.0.0.1:{SERVICE_PORT}")),
    pairing_token: Some(pairing_token),
    lan_address: local_lan_address(),
    updater_enabled,
  });
  Ok(())
}

#[cfg(desktop)]
#[tauri::command]
fn stop_update_service(state: tauri::State<'_, SidecarState>) -> Result<(), String> {
  stop_sidecar(&state)
}

#[cfg(desktop)]
fn stop_sidecar(state: &SidecarState) -> Result<(), String> {
  let mut child = state.0.lock().map_err(|err| err.to_string())?;
  if let Some(child) = child.take() {
    child.kill().map_err(|err| err.to_string())?;
  }
  Ok(())
}

#[cfg(desktop)]
#[tauri::command]
fn ensure_desktop_service(
  app: tauri::AppHandle,
  state: tauri::State<'_, SidecarState>,
  info: tauri::State<'_, RuntimeInfo>,
) -> Result<(), String> {
  let mut child = state.0.lock().map_err(|err| err.to_string())?;
  if child.is_none() {
    let token = info.pairing_token.as_deref().ok_or("Missing desktop pairing token")?;
    *child = Some(spawn_sidecar(&app, token).map_err(|err| err.to_string())?);
  }
  Ok(())
}

#[cfg(desktop)]
#[tauri::command]
fn restart_after_update(app: tauri::AppHandle, state: tauri::State<'_, SidecarState>) -> Result<(), String> {
  stop_sidecar(&state)?;
  app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    .plugin(plaud::init())
    .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      #[cfg(desktop)]
      initialize_desktop_runtime(app)?;

      #[cfg(mobile)]
      app.manage(RuntimeInfo {
        mode: "mobile",
        service_origin: None,
        pairing_token: None,
        lan_address: None,
        updater_enabled: false,
      });

      Ok(())
    });

  // REL-07: update checks verify the release signature against the build-time public key.
  #[cfg(desktop)]
  let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

  #[cfg(desktop)]
  let builder = builder.invoke_handler(tauri::generate_handler![
    runtime_info, plaud::plaud_command, desktop_exports::export_document, desktop_exports::export_audio,
    desktop_exports::pick_export_folder, stop_update_service, ensure_desktop_service, restart_after_update
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
          let _ = stop_sidecar(&state);
        }
      }
    });
}
