use std::{io::Write, path::{Path, PathBuf}, time::Duration};
use tauri::Manager;

fn safe_filename(filename: &str) -> Result<&str, String> {
    if filename.is_empty() || filename.len() > 255 || filename == "." || filename == ".."
        || filename.chars().any(|c| c == '/' || c == '\\' || c.is_control()) {
        return Err("Invalid export filename.".into());
    }
    Ok(filename)
}

fn destination(filename: &str, vault: &Path) -> Result<Option<PathBuf>, String> {
    let path = rfd::FileDialog::new().set_title("Export from OpenPlod")
        .set_file_name(safe_filename(filename)?).save_file();
    if let Some(ref path) = path {
        let parent = path.parent().ok_or("Invalid export destination.")?
            .canonicalize().map_err(|_| "Export folder is unavailable.")?;
        if parent.starts_with(vault) {
            return Err("Choose a location outside OpenPlod's private vault.".into());
        }
    }
    Ok(path)
}

fn write_export(path: &Path, source: &mut impl std::io::Read) -> Result<(), String> {
    // Keep an existing destination intact if disk space or a transfer fails.
    let parent = path.parent().ok_or("Invalid export destination.")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|_| "Cannot create the export file.")?;
    std::io::copy(source, temporary.as_file_mut()).map_err(|_| "Export interrupted. The destination was not changed.")?;
    temporary.flush().map_err(|_| "Could not flush the export.")?;
    temporary.as_file().sync_all().map_err(|_| "Could not save the export to disk.")?;
    temporary.persist(path).map_err(|_| "Could not finish saving the export.")?;
    Ok(())
}

#[tauri::command]
pub async fn export_document(app: tauri::AppHandle, filename: String, content: String) -> Result<bool, String> {
    let extension = Path::new(safe_filename(&filename)?).extension().and_then(|v| v.to_str());
    if !matches!(extension, Some("md" | "txt" | "json")) || content.len() > 16 * 1024 * 1024 {
        return Err("Document export must be Markdown, text, or JSON under 16 MB.".into());
    }
    let vault = app.path().app_data_dir().map_err(|_| "Vault location is unavailable.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = destination(&filename, &vault)? else { return Ok(false) };
        write_export(&path, &mut content.as_bytes())?;
        Ok(true)
    }).await.map_err(|_| "Export could not start.")?
}

#[tauri::command]
pub async fn export_audio(app: tauri::AppHandle, info: tauri::State<'_, crate::RuntimeInfo>,
                          recording_id: String, filename: String) -> Result<bool, String> {
    uuid::Uuid::parse_str(&recording_id).map_err(|_| "Invalid recording ID.")?;
    safe_filename(&filename)?;
    let vault = app.path().app_data_dir().map_err(|_| "Vault location is unavailable.")?;
    let token = info.pairing_token.clone().ok_or("Vault authentication is unavailable.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = destination(&filename, &vault)? else { return Ok(false) };
        let client = reqwest::blocking::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(300))
            .build().map_err(|_| "Could not access the vault.")?;
        let mut response = client.get(format!("http://127.0.0.1:{}/api/recordings/{recording_id}/audio", crate::SERVICE_PORT))
            .header("X-OpenPlod-Token", token).send().and_then(|r| r.error_for_status())
            .map_err(|_| "Recording audio is unavailable. Check the vault and retry.")?;
        write_export(&path, &mut response)?;
        Ok(true)
    }).await.map_err(|_| "Audio export could not start.")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filenames_cannot_escape_the_save_dialog() {
        for value in ["../audio.wav", "/tmp/audio.wav", "a\\b", "..", "bad\nname"] {
            assert!(safe_filename(value).is_err());
        }
        assert!(safe_filename("Meeting notes.md").is_ok());
    }

    #[test]
    fn failed_copy_retains_the_existing_destination() {
        struct Broken;
        impl std::io::Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> { Err(std::io::Error::other("interrupted")) }
        }
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("recording.wav");
        std::fs::write(&target, b"original").unwrap();
        assert!(write_export(&target, &mut Broken).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        write_export(&target, &mut &b"exported"[..]).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"exported");
    }
}
