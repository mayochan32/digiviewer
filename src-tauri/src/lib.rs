use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

#[derive(Serialize)]
struct ImageFile {
    path: String,
    name: String,
    size: u64,
    modified_at: u128,
}

#[tauri::command]
fn scan_images(directory: String) -> Result<Vec<ImageFile>, String> {
    let root = PathBuf::from(directory);
    let mut images = Vec::new();
    visit_directory(&root, &mut images)?;
    images.sort_by(|a, b| natordish(&a.path).cmp(&natordish(&b.path)));
    Ok(images)
}

fn visit_directory(directory: &Path, images: &mut Vec<ImageFile>) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| error.to_string())?;

        if file_type.is_dir() {
            visit_directory(&path, images)?;
        } else if file_type.is_file() && is_supported_image(&path) {
            let metadata = entry.metadata().map_err(|error| error.to_string())?;
            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis())
                .unwrap_or(0);

            images.push(ImageFile {
                path: path.to_string_lossy().into_owned(),
                name: path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("")
                    .to_owned(),
                size: metadata.len(),
                modified_at,
            });
        }
    }

    Ok(())
}

fn is_supported_image(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "jpg" | "jpeg" | "png" | "webp" | "gif" | "avif" | "heic" | "heif"
            )
        })
        .unwrap_or(false)
}

fn natordish(value: &str) -> String {
    value.to_lowercase()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![scan_images])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
