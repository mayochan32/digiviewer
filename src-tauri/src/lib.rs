use serde::{Deserialize, Serialize};
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
    kind: FileKind,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum FileKind {
    Image,
    Raw,
}

#[derive(Deserialize)]
struct CropImage {
    bytes: Vec<u8>,
}

#[tauri::command]
fn scan_images(directory: String) -> Result<Vec<ImageFile>, String> {
    let root = PathBuf::from(directory);
    let mut images = Vec::new();
    visit_directory(&root, &mut images)?;
    images.sort_by(|a, b| natordish(&a.path).cmp(&natordish(&b.path)));
    Ok(images)
}

#[tauri::command]
fn save_crop_image(image: CropImage) -> Result<String, String> {
    let directory = crop_output_dir();
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let path = directory.join(format!("digiviewer-crop-{timestamp}.png"));
    fs::write(&path, image.bytes).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn ensure_crop_directory() -> Result<String, String> {
    let directory = crop_output_dir();
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.to_string_lossy().into_owned())
}

fn crop_output_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("Pictures")
        .join("DigiViewer Crops")
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://www.google.com/") || url.starts_with("https://lens.google.com/")) {
        return Err("unsupported url".to_owned());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn reveal_file(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{path}"))
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(parent) = Path::new(&path).parent() {
            std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

fn visit_directory(directory: &Path, images: &mut Vec<ImageFile>) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| error.to_string())?;

        if file_type.is_dir() {
            visit_directory(&path, images)?;
        } else if file_type.is_file() && (is_supported_image(&path) || is_raw_image(&path)) {
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
                kind: if is_supported_image(&path) {
                    FileKind::Image
                } else {
                    FileKind::Raw
                },
            });
        }
    }

    Ok(())
}

fn is_raw_image(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "cr2" | "cr3" | "nef" | "nrw" | "arw" | "orf" | "raf" | "rw2" | "pef"
                    | "dng"
            )
        })
        .unwrap_or(false)
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
        .invoke_handler(tauri::generate_handler![
            scan_images,
            save_crop_image,
            ensure_crop_directory,
            open_external_url,
            reveal_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
