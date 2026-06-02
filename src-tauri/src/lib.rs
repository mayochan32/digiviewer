use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::BufWriter,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailRequest {
    path: String,
    size: u64,
    modified_at: u128,
    max_edge: u32,
    cache_limit_mb: u64,
    prune_cache: bool,
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
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn get_thumbnail(request: ThumbnailRequest) -> Result<Option<String>, String> {
    let source = PathBuf::from(&request.path);
    if !source.is_file() {
        return Ok(None);
    }

    let max_edge = request.max_edge.clamp(64, 512);
    let cache_dir = thumbnail_cache_dir();
    fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;

    let cache_key = thumbnail_cache_key(&request.path, request.size, request.modified_at, max_edge);
    let cache_path = cache_dir.join(format!("{cache_key}.jpg"));
    if cache_path.is_file() {
        return Ok(Some(cache_path.to_string_lossy().into_owned()));
    }

    let reader = image::ImageReader::open(&source).map_err(|error| error.to_string())?;
    let image = match reader.decode() {
        Ok(image) => image,
        Err(_) => return Ok(None),
    };
    let thumbnail = image.thumbnail(max_edge, max_edge).to_rgb8();
    let file = File::create(&cache_path).map_err(|error| error.to_string())?;
    let writer = BufWriter::new(file);
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(writer, 78);
    encoder
        .encode_image(&thumbnail)
        .map_err(|error| error.to_string())?;

    if request.prune_cache {
        prune_thumbnail_cache(request.cache_limit_mb);
    }
    Ok(Some(cache_path.to_string_lossy().into_owned()))
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

fn thumbnail_cache_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        return std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("Library")
            .join("Caches")
            .join("DigiViewer")
            .join("thumbnails");
    }

    #[cfg(target_os = "windows")]
    {
        return std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("DigiViewer")
            .join("Cache")
            .join("thumbnails");
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::env::temp_dir().join("DigiViewer").join("thumbnails")
    }
}

fn thumbnail_cache_key(path: &str, size: u64, modified_at: u128, max_edge: u32) -> String {
    let input = format!("{path}\0{size}\0{modified_at}\0{max_edge}");
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn prune_thumbnail_cache(cache_limit_mb: u64) {
    let limit_bytes = cache_limit_mb.saturating_mul(1024).saturating_mul(1024);
    if limit_bytes == 0 {
        return;
    }

    let cache_dir = thumbnail_cache_dir();
    let entries = match fs::read_dir(&cache_dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    let mut files = Vec::new();
    let mut total_size = 0_u64;

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        total_size = total_size.saturating_add(metadata.len());
        files.push((path, metadata.len(), modified_at));
    }

    if total_size <= limit_bytes {
        return;
    }

    files.sort_by_key(|(_, _, modified_at)| *modified_at);
    for (path, size, _) in files {
        if total_size <= limit_bytes {
            break;
        }
        if fs::remove_file(path).is_ok() {
            total_size = total_size.saturating_sub(size);
        }
    }
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://www.google.com/") || url.starts_with("https://lens.google.com/"))
    {
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

#[tauri::command]
fn open_crop_directory() -> Result<String, String> {
    let directory = crop_output_dir();
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&directory)
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&directory)
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&directory)
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    Ok(directory.to_string_lossy().into_owned())
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
                "cr2" | "cr3" | "nef" | "nrw" | "arw" | "orf" | "raf" | "rw2" | "pef" | "dng"
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
            app_version,
            get_thumbnail,
            save_crop_image,
            ensure_crop_directory,
            open_external_url,
            reveal_file,
            open_crop_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
