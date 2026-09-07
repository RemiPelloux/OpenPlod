use serde_json::Value;
use tauri::{plugin::{Builder, TauriPlugin}, Runtime};
#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
struct PlaudHandle<R: Runtime>(tauri::plugin::PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("plaud")
    .setup(|_app, _api| {
      #[cfg(target_os = "android")]
      _app.manage(PlaudHandle(_api.register_android_plugin("com.openplod.vault", "PlaudPlugin")?));
      Ok(())
    })
    .build()
}

#[tauri::command]
pub async fn plaud_command<R: Runtime>(app: tauri::AppHandle<R>, action: String, args: Value) -> Result<Value, String> {
  let allowed = ["initialize", "scan", "connect", "refresh", "download", "upload", "snapshot", "play", "stopPlayback", "disconnect", "cancel", "permissions", "exportDocument", "exportRecording", "exportVaultRecording", "requestAuthorization", "finishAuthorization", "autoImport"];
  if !allowed.contains(&action.as_str()) { return Err("Unknown Plaud command".into()); }
  #[cfg(target_os = "android")]
  return app.state::<PlaudHandle<R>>().0.run_mobile_plugin_async(&action, args).await.map_err(|e| e.to_string());
  #[cfg(not(target_os = "android"))]
  { let _ = (app, args); Err("Connect the Note Pro through OpenPlod Android, then sync to this vault.".into()) }
}
