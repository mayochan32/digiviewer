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
    cache_scope: Option<ThumbnailCacheScope>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ThumbnailCacheScope {
    App,
    Folder,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailCacheRequest {
    paths: Vec<String>,
    max_edge: u32,
    cache_scope: Option<ThumbnailCacheScope>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailCacheResult {
    total: usize,
    created: usize,
    reused: usize,
    failed: usize,
    deleted: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameRequest {
    paths: Vec<String>,
    species_name: String,
}

#[derive(Serialize)]
struct RenameResult {
    old_path: String,
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

#[tauri::command]
fn rename_images(request: RenameRequest) -> Result<Vec<RenameResult>, String> {
    let species_name = sanitize_filename_part(&request.species_name);
    if species_name.is_empty() {
        return Err("種名を入力してください。".to_owned());
    }

    let mut results = Vec::new();
    for path in request.paths {
        let source = PathBuf::from(&path);
        if !source.is_file() {
            continue;
        }
        let Some(parent) = source.parent() else {
            continue;
        };
        let Some(stem) = source.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        let old_metadata = fs::metadata(&source).map_err(|error| error.to_string())?;
        let old_size = old_metadata.len();
        let old_modified_at = modified_at_millis(&old_metadata);
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_owned());

        let target = available_renamed_path(parent, stem, extension.as_deref(), &species_name);
        fs::rename(&source, &target).map_err(|error| error.to_string())?;
        migrate_thumbnail_cache_after_rename(
            &source,
            &path,
            &target,
            &target.to_string_lossy(),
            old_size,
            old_modified_at,
        );
        rename_raw_sidecars(
            parent,
            stem,
            target
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(stem),
        );

        let metadata = fs::metadata(&target).map_err(|error| error.to_string())?;
        results.push(RenameResult {
            old_path: path,
            path: target.to_string_lossy().into_owned(),
            name: target
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("")
                .to_owned(),
            size: metadata.len(),
            modified_at: modified_at_millis(&metadata),
        });
    }

    Ok(results)
}

#[tauri::command]
fn copy_files_to_clipboard(paths: Vec<String>) -> Result<(), String> {
    let existing_paths: Vec<String> = paths
        .into_iter()
        .filter(|path| Path::new(path).is_file())
        .collect();
    if existing_paths.is_empty() {
        return Err("コピーするファイルがありません。".to_owned());
    }

    #[cfg(target_os = "macos")]
    {
        copy_files_to_macos_pasteboard(&existing_paths)
    }

    #[cfg(target_os = "windows")]
    {
        copy_files_to_windows_clipboard(&existing_paths)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("ファイルコピーは現在このOSでは未対応です。".to_owned())
    }
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
    let cache_path = thumbnail_cache_path_for(
        &source,
        &request.path,
        request.size,
        request.modified_at,
        max_edge,
        request.cache_scope.as_ref(),
    )?;
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let existed = cache_path.is_file();
    if !existed {
        create_thumbnail_file(&source, &cache_path, max_edge)?;
    }

    if request.prune_cache {
        prune_thumbnail_cache(request.cache_limit_mb);
    }
    Ok(Some(cache_path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn build_thumbnail_cache(request: ThumbnailCacheRequest) -> Result<ThumbnailCacheResult, String> {
    let mut result = ThumbnailCacheResult {
        total: request.paths.len(),
        created: 0,
        reused: 0,
        failed: 0,
        deleted: 0,
    };
    let max_edge = request.max_edge.clamp(64, 512);

    for path in request.paths {
        let source = PathBuf::from(&path);
        if !source.is_file() {
            result.failed += 1;
            continue;
        }
        let Ok(metadata) = fs::metadata(&source) else {
            result.failed += 1;
            continue;
        };
        let modified_at = modified_at_millis(&metadata);
        let cache_path = thumbnail_cache_path_for(
            &source,
            &path,
            metadata.len(),
            modified_at,
            max_edge,
            request.cache_scope.as_ref(),
        )?;
        if cache_path.is_file() {
            result.reused += 1;
            continue;
        }
        if let Some(parent) = cache_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        match create_thumbnail_file(&source, &cache_path, max_edge) {
            Ok(()) => result.created += 1,
            Err(_) => result.failed += 1,
        }
    }

    Ok(result)
}

#[tauri::command]
fn clean_thumbnail_cache(directory: String) -> Result<ThumbnailCacheResult, String> {
    clean_folder_thumbnail_cache(&PathBuf::from(directory), false)
}

#[tauri::command]
fn clear_thumbnail_cache(directory: String) -> Result<ThumbnailCacheResult, String> {
    clean_folder_thumbnail_cache(&PathBuf::from(directory), true)
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

#[cfg(not(target_os = "windows"))]
fn crop_output_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("Pictures")
        .join("DigiViewer Crops")
}

#[cfg(target_os = "windows")]
fn crop_output_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("Pictures")
        .join("DigiViewer Crops")
}

fn sanitize_filename_part(value: &str) -> String {
    value
        .trim()
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '\0' => '_',
            _ => character,
        })
        .collect::<String>()
}

fn available_renamed_path(
    parent: &Path,
    stem: &str,
    extension: Option<&str>,
    species_name: &str,
) -> PathBuf {
    let base = format!("{stem}_{species_name}");
    for suffix in 0.. {
        let candidate_stem = if suffix == 0 {
            base.clone()
        } else {
            format!("{base}_{suffix}")
        };
        let filename = match extension {
            Some(extension) if !extension.is_empty() => format!("{candidate_stem}.{extension}"),
            _ => candidate_stem,
        };
        let candidate = parent.join(filename);
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("suffix loop always returns an available path")
}

fn rename_raw_sidecars(parent: &Path, old_stem: &str, new_stem: &str) {
    for extension in [
        "cr2", "cr3", "nef", "nrw", "arw", "orf", "raf", "rw2", "pef", "dng",
    ] {
        for raw_extension in [extension.to_owned(), extension.to_ascii_uppercase()] {
            let source = parent.join(format!("{old_stem}.{raw_extension}"));
            if !source.is_file() {
                continue;
            }
            let target = parent.join(format!("{new_stem}.{raw_extension}"));
            if !target.exists() {
                let _ = fs::rename(source, target);
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn copy_files_to_macos_pasteboard(paths: &[String]) -> Result<(), String> {
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSURL};

    let mut writers = Vec::new();
    for path in paths {
        let url = NSURL::from_file_path(path)
            .ok_or_else(|| format!("ファイルURLを作成できません: {path}"))?;
        writers.push(ProtocolObject::<dyn NSPasteboardWriting>::from_retained(
            url,
        ));
    }
    let writer_array = NSArray::from_retained_slice(&writers);
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    if pasteboard.writeObjects(&writer_array) {
        Ok(())
    } else {
        Err("ファイルコピーに失敗しました。".to_owned())
    }
}

#[cfg(target_os = "windows")]
fn copy_files_to_windows_clipboard(paths: &[String]) -> Result<(), String> {
    use std::{mem, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::{
        Foundation::{GlobalFree, POINT},
        System::{
            DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
            Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
            Ole::CF_HDROP,
        },
        UI::Shell::DROPFILES,
    };

    struct ClipboardGuard;

    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }

    let header_size = mem::size_of::<DROPFILES>();
    let mut wide_paths = Vec::new();
    for path in paths {
        let mut wide: Vec<u16> = std::ffi::OsStr::new(path).encode_wide().collect();
        if wide.is_empty() {
            continue;
        }
        wide.push(0);
        wide_paths.extend(wide);
    }
    wide_paths.push(0);

    let total_size = header_size + wide_paths.len() * mem::size_of::<u16>();
    let mut data = vec![0_u8; total_size];
    let dropfiles = DROPFILES {
        pFiles: header_size as u32,
        pt: POINT { x: 0, y: 0 },
        fNC: 0,
        fWide: 1,
    };

    unsafe {
        std::ptr::copy_nonoverlapping(
            (&dropfiles as *const DROPFILES).cast::<u8>(),
            data.as_mut_ptr(),
            header_size,
        );
        std::ptr::copy_nonoverlapping(
            wide_paths.as_ptr().cast::<u8>(),
            data.as_mut_ptr().add(header_size),
            wide_paths.len() * mem::size_of::<u16>(),
        );

        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("クリップボードを開けません。".to_owned());
        }
        let _guard = ClipboardGuard;
        if EmptyClipboard() == 0 {
            return Err("クリップボードを初期化できません。".to_owned());
        }

        let handle = GlobalAlloc(GMEM_MOVEABLE, data.len());
        if handle.is_null() {
            return Err("クリップボード用メモリを確保できません。".to_owned());
        }

        let locked = GlobalLock(handle);
        if locked.is_null() {
            GlobalFree(handle);
            return Err("クリップボード用メモリをロックできません。".to_owned());
        }
        std::ptr::copy_nonoverlapping(data.as_ptr(), locked.cast::<u8>(), data.len());
        GlobalUnlock(handle);

        if SetClipboardData(CF_HDROP as u32, handle).is_null() {
            GlobalFree(handle);
            return Err("ファイルコピーに失敗しました。".to_owned());
        }
    }

    Ok(())
}

fn modified_at_millis(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
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

fn folder_thumbnail_cache_dir(source: &Path, max_edge: u32) -> Option<PathBuf> {
    source.parent().map(|parent| {
        parent
            .join(".digiviewer")
            .join("thumbs")
            .join(max_edge.to_string())
    })
}

fn thumbnail_cache_path_for(
    source: &Path,
    path: &str,
    size: u64,
    modified_at: u128,
    max_edge: u32,
    scope: Option<&ThumbnailCacheScope>,
) -> Result<PathBuf, String> {
    let cache_key = thumbnail_cache_key(path, size, modified_at, max_edge);
    let filename = thumbnail_cache_filename(source, &cache_key);
    match scope {
        Some(ThumbnailCacheScope::Folder) => {
            let Some(cache_dir) = folder_thumbnail_cache_dir(source, max_edge) else {
                return Ok(thumbnail_cache_dir().join(filename));
            };
            match fs::create_dir_all(&cache_dir) {
                Ok(()) => Ok(cache_dir.join(filename)),
                Err(_) => Ok(thumbnail_cache_dir().join(filename)),
            }
        }
        _ => Ok(thumbnail_cache_dir().join(filename)),
    }
}

fn thumbnail_cache_filename(source: &Path, cache_key: &str) -> String {
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .map(sanitize_filename_part)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "thumb".to_owned());
    format!("{stem}__{cache_key}.jpg")
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

fn migrate_thumbnail_cache_after_rename(
    old_source: &Path,
    old_path: &str,
    new_source: &Path,
    new_path: &str,
    size: u64,
    modified_at: u128,
) {
    for max_edge in thumbnail_cache_sizes_for_rename(old_source) {
        let old_key = thumbnail_cache_key(old_path, size, modified_at, max_edge);
        let new_key = thumbnail_cache_key(new_path, size, modified_at, max_edge);
        let old_filename = thumbnail_cache_filename(old_source, &old_key);
        let new_filename = thumbnail_cache_filename(new_source, &new_key);

        migrate_thumbnail_cache_file(
            &thumbnail_cache_dir().join(&old_filename),
            &thumbnail_cache_dir().join(&new_filename),
        );

        if let (Some(old_dir), Some(new_dir)) = (
            folder_thumbnail_cache_dir(old_source, max_edge),
            folder_thumbnail_cache_dir(new_source, max_edge),
        ) {
            migrate_thumbnail_cache_file(
                &old_dir.join(&old_filename),
                &new_dir.join(&new_filename),
            );
        }
    }
}

fn thumbnail_cache_sizes_for_rename(source: &Path) -> Vec<u32> {
    let mut sizes = std::collections::BTreeSet::from([192_u32]);
    if let Some(parent) = source.parent() {
        let root = parent.join(".digiviewer").join("thumbs");
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten() {
                if !entry
                    .file_type()
                    .map(|file_type| file_type.is_dir())
                    .unwrap_or(false)
                {
                    continue;
                }
                if let Some(size) = entry
                    .file_name()
                    .to_str()
                    .and_then(|value| value.parse::<u32>().ok())
                {
                    sizes.insert(size.clamp(64, 512));
                }
            }
        }
    }
    sizes.into_iter().collect()
}

fn migrate_thumbnail_cache_file(old_path: &Path, new_path: &Path) {
    if !old_path.is_file() || new_path.is_file() {
        return;
    }
    if let Some(parent) = new_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::rename(old_path, new_path).or_else(|_| {
        fs::copy(old_path, new_path)?;
        fs::remove_file(old_path)
    });
}

fn create_thumbnail_file(source: &Path, cache_path: &Path, max_edge: u32) -> Result<(), String> {
    let reader = image::ImageReader::open(source).map_err(|error| error.to_string())?;
    let image = match reader.decode() {
        Ok(image) => image,
        Err(_) => return Ok(()),
    };
    let thumbnail = image.thumbnail(max_edge, max_edge).to_rgb8();
    let file = File::create(cache_path).map_err(|error| error.to_string())?;
    let writer = BufWriter::new(file);
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(writer, 78);
    encoder
        .encode_image(&thumbnail)
        .map_err(|error| error.to_string())
}

fn clean_folder_thumbnail_cache(
    directory: &Path,
    clear_all: bool,
) -> Result<ThumbnailCacheResult, String> {
    let mut result = ThumbnailCacheResult {
        total: 0,
        created: 0,
        reused: 0,
        failed: 0,
        deleted: 0,
    };
    clean_folder_thumbnail_cache_recursive(directory, clear_all, &mut result)?;
    Ok(result)
}

fn clean_folder_thumbnail_cache_recursive(
    directory: &Path,
    clear_all: bool,
    result: &mut ThumbnailCacheResult,
) -> Result<(), String> {
    let cache_root = directory.join(".digiviewer").join("thumbs");
    if !cache_root.exists() {
        // Still visit child folders; each folder owns its local thumbnail cache.
    } else {
        let valid_prefixes = valid_thumbnail_prefixes(directory)?;
        clean_thumbnail_cache_dir(&cache_root, clear_all, &valid_prefixes, result);
    }

    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_dir() && path.file_name().and_then(|value| value.to_str()) != Some(".digiviewer")
        {
            clean_folder_thumbnail_cache_recursive(&path, clear_all, result)?;
        }
    }
    Ok(())
}

fn valid_thumbnail_prefixes(directory: &Path) -> Result<std::collections::HashSet<String>, String> {
    let mut valid_prefixes = std::collections::HashSet::new();
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if !path.is_file() || !is_supported_image(&path) {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|value| value.to_str()) {
            valid_prefixes.insert(format!("{}__", sanitize_filename_part(stem)));
        }
    }
    Ok(valid_prefixes)
}

fn clean_thumbnail_cache_dir(
    directory: &Path,
    clear_all: bool,
    valid_prefixes: &std::collections::HashSet<String>,
    result: &mut ThumbnailCacheResult,
) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            clean_thumbnail_cache_dir(&path, clear_all, valid_prefixes, result);
            let _ = fs::remove_dir(&path);
            continue;
        }
        if !path.is_file() {
            continue;
        }
        result.total += 1;
        let filename = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let should_delete = clear_all
            || !valid_prefixes
                .iter()
                .any(|prefix| filename.starts_with(prefix));
        if should_delete {
            if fs::remove_file(path).is_ok() {
                result.deleted += 1;
            } else {
                result.failed += 1;
            }
        } else {
            result.reused += 1;
        }
    }
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
            if is_digiviewer_cache_dir(&path) {
                continue;
            }
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

fn is_digiviewer_cache_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name == ".digiviewer")
        .unwrap_or(false)
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
            rename_images,
            copy_files_to_clipboard,
            app_version,
            get_thumbnail,
            build_thumbnail_cache,
            clean_thumbnail_cache,
            clear_thumbnail_cache,
            save_crop_image,
            ensure_crop_directory,
            open_external_url,
            reveal_file,
            open_crop_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
