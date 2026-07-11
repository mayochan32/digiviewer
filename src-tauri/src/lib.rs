use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{BufWriter, Cursor},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tauri::Manager;

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
struct SaveCropToSourceRequest {
    source_path: String,
    left: u32,
    top: u32,
    width: u32,
    height: u32,
    upscale2x: bool,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveToDeletedRequest {
    directory: String,
    paths: Vec<String>,
}

#[derive(Serialize)]
struct MoveToDeletedResult {
    old_path: String,
    deleted_path: String,
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
fn move_images_to_deleted(
    request: MoveToDeletedRequest,
) -> Result<Vec<MoveToDeletedResult>, String> {
    let root = PathBuf::from(&request.directory);
    if !root.is_dir() {
        return Err("フォルダが見つかりません。".to_owned());
    }

    let root_canonical = root.canonicalize().map_err(|error| error.to_string())?;
    let deleted_dir = root.join("deleted");
    fs::create_dir_all(&deleted_dir).map_err(|error| error.to_string())?;
    let deleted_canonical = deleted_dir
        .canonicalize()
        .map_err(|error| error.to_string())?;

    let mut results = Vec::new();
    for path in request.paths {
        let source = PathBuf::from(&path);
        if !source.is_file() {
            continue;
        }
        let source_canonical = source.canonicalize().map_err(|error| error.to_string())?;
        if !source_canonical.starts_with(&root_canonical)
            || source_canonical.starts_with(&deleted_canonical)
        {
            continue;
        }

        let Some(parent) = source.parent() else {
            continue;
        };
        let Some(stem) = source.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(file_name) = source.file_name().and_then(|value| value.to_str()) else {
            continue;
        };

        let target = available_moved_path(&deleted_dir, file_name);
        fs::rename(&source, &target).map_err(|error| error.to_string())?;
        move_raw_sidecars_to_deleted(
            parent,
            stem,
            &deleted_dir,
            target
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(stem),
        );

        results.push(MoveToDeletedResult {
            old_path: path,
            deleted_path: target.to_string_lossy().into_owned(),
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
    if !existed && !try_migrate_legacy_folder_thumbnail(&source, &cache_path, max_edge) {
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
        if try_migrate_legacy_folder_thumbnail(&source, &cache_path, max_edge) {
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
fn save_crop_image(app: tauri::AppHandle, image: CropImage) -> Result<String, String> {
    let directory = crop_output_dir(&app);
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
fn save_crop_to_source_folder(request: SaveCropToSourceRequest) -> Result<ImageFile, String> {
    let source = PathBuf::from(&request.source_path);
    if !source.is_file() {
        return Err("元画像が見つかりません。".to_owned());
    }
    let Some(parent) = source.parent() else {
        return Err("保存先フォルダが見つかりません。".to_owned());
    };
    let Some(stem) = source.file_stem().and_then(|value| value.to_str()) else {
        return Err("元画像のファイル名を取得できません。".to_owned());
    };

    let target = available_crop_path(parent, stem);
    let reader = image::ImageReader::open(&source).map_err(|error| error.to_string())?;
    let image = reader.decode().map_err(|error| error.to_string())?;
    let image_width = image.width();
    let image_height = image.height();
    if image_width == 0 || image_height == 0 {
        return Err("画像サイズを取得できません。".to_owned());
    }

    let left = request.left.min(image_width.saturating_sub(1));
    let top = request.top.min(image_height.saturating_sub(1));
    let width = request.width.max(1).min(image_width - left);
    let height = request.height.max(1).min(image_height - top);
    let cropped = image.crop_imm(left, top, width, height);
    let output = if request.upscale2x {
        cropped.resize_exact(
            width.saturating_mul(2),
            height.saturating_mul(2),
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        cropped
    };
    let rgb = output.to_rgb8();
    let mut jpeg_bytes = Vec::new();
    let writer = Cursor::new(&mut jpeg_bytes);
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(writer, 97);
    encoder
        .encode_image(&rgb)
        .map_err(|error| error.to_string())?;
    if let Ok(source_bytes) = fs::read(&source) {
        jpeg_bytes = preserve_jpeg_metadata(&source_bytes, &jpeg_bytes);
    }
    fs::write(&target, jpeg_bytes).map_err(|error| error.to_string())?;
    preserve_file_modified_time(&source, &target);
    image_file_from_path(&target, FileKind::Image)
}

#[tauri::command]
fn ensure_crop_directory(app: tauri::AppHandle) -> Result<String, String> {
    let directory = crop_output_dir(&app);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.to_string_lossy().into_owned())
}

fn crop_output_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .picture_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("DigiViewer Crops")
}

fn sanitize_filename_part(value: &str) -> String {
    let sanitized = value
        .trim()
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\0' => '_',
            character if character.is_control() => '_',
            _ => character,
        })
        .collect::<String>();
    sanitized.trim_end_matches([' ', '.']).to_owned()
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

fn available_crop_path(parent: &Path, stem: &str) -> PathBuf {
    let base = format!("{stem}_crop");
    for suffix in 0.. {
        let candidate_stem = if suffix == 0 {
            base.clone()
        } else {
            format!("{base}_{suffix}")
        };
        let candidate = parent.join(format!("{candidate_stem}.jpg"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("suffix loop always returns an available path")
}

fn available_moved_path(parent: &Path, file_name: &str) -> PathBuf {
    let source_name = Path::new(file_name);
    let stem = source_name
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(file_name);
    let extension = source_name.extension().and_then(|value| value.to_str());

    for suffix in 0.. {
        let candidate_name = if suffix == 0 {
            file_name.to_owned()
        } else {
            match extension {
                Some(extension) if !extension.is_empty() => {
                    format!("{stem}_{suffix}.{extension}")
                }
                _ => format!("{stem}_{suffix}"),
            }
        };
        let candidate = parent.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("suffix loop always returns an available path")
}

fn image_file_from_path(path: &Path, kind: FileKind) -> Result<ImageFile, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    Ok(ImageFile {
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_owned(),
        size: metadata.len(),
        modified_at: modified_at_millis(&metadata),
        kind,
    })
}

fn preserve_jpeg_metadata(source: &[u8], encoded: &[u8]) -> Vec<u8> {
    let metadata_segments = jpeg_metadata_segments(source);
    if metadata_segments.is_empty() || encoded.len() < 2 || encoded[0..2] != [0xff, 0xd8] {
        return encoded.to_vec();
    }

    let mut result =
        Vec::with_capacity(encoded.len() + metadata_segments.iter().map(Vec::len).sum::<usize>());
    result.extend_from_slice(&encoded[0..2]);
    for segment in metadata_segments {
        result.extend_from_slice(&segment);
    }
    result.extend_from_slice(&encoded[2..]);
    result
}

fn preserve_file_modified_time(source: &Path, target: &Path) {
    let Ok(metadata) = fs::metadata(source) else {
        return;
    };
    let modified = filetime::FileTime::from_last_modification_time(&metadata);
    let accessed = filetime::FileTime::from_last_access_time(&metadata);
    let _ = filetime::set_file_times(target, accessed, modified);
}

fn jpeg_metadata_segments(source: &[u8]) -> Vec<Vec<u8>> {
    if source.len() < 4 || source[0..2] != [0xff, 0xd8] {
        return Vec::new();
    }

    let mut segments = Vec::new();
    let mut index = 2;
    while index + 4 <= source.len() {
        if source[index] != 0xff {
            break;
        }
        while index < source.len() && source[index] == 0xff {
            index += 1;
        }
        if index >= source.len() {
            break;
        }
        let marker = source[index];
        index += 1;
        if marker == 0xda || marker == 0xd9 {
            break;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        if index + 2 > source.len() {
            break;
        }
        let length = u16::from_be_bytes([source[index], source[index + 1]]) as usize;
        if length < 2 || index + length > source.len() {
            break;
        }
        let segment_start = index - 2;
        let segment_end = index + length;
        if is_preserved_jpeg_metadata_marker(marker, &source[index + 2..segment_end]) {
            segments.push(source[segment_start..segment_end].to_vec());
        }
        index = segment_end;
    }
    segments
}

fn is_preserved_jpeg_metadata_marker(marker: u8, payload: &[u8]) -> bool {
    match marker {
        0xe1 => {
            payload.starts_with(b"Exif\0\0")
                || payload.starts_with(b"http://ns.adobe.com/xap/1.0/\0")
        }
        0xe2 => payload.starts_with(b"ICC_PROFILE\0"),
        _ => false,
    }
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

fn move_raw_sidecars_to_deleted(parent: &Path, old_stem: &str, deleted_dir: &Path, new_stem: &str) {
    for extension in [
        "cr2", "cr3", "nef", "nrw", "arw", "orf", "raf", "rw2", "pef", "dng",
    ] {
        for raw_extension in [extension.to_owned(), extension.to_ascii_uppercase()] {
            let source = parent.join(format!("{old_stem}.{raw_extension}"));
            if !source.is_file() {
                continue;
            }
            let target = available_moved_path(deleted_dir, &format!("{new_stem}.{raw_extension}"));
            let _ = fs::rename(source, target);
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
    match scope {
        Some(ThumbnailCacheScope::Folder) => {
            let cache_key = thumbnail_cache_key(
                &folder_thumbnail_cache_identity(source),
                size,
                modified_at,
                max_edge,
            );
            let filename = thumbnail_cache_filename(source, &cache_key);
            let Some(cache_dir) = folder_thumbnail_cache_dir(source, max_edge) else {
                return Ok(thumbnail_cache_dir().join(filename));
            };
            match fs::create_dir_all(&cache_dir) {
                Ok(()) => Ok(cache_dir.join(filename)),
                Err(_) => Ok(thumbnail_cache_dir().join(filename)),
            }
        }
        _ => {
            let cache_key = thumbnail_cache_key(path, size, modified_at, max_edge);
            let filename = thumbnail_cache_filename(source, &cache_key);
            Ok(thumbnail_cache_dir().join(filename))
        }
    }
}

fn folder_thumbnail_cache_identity(source: &Path) -> String {
    source
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .unwrap_or_else(|| source.to_string_lossy().to_lowercase())
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
            let old_folder_key = thumbnail_cache_key(
                &folder_thumbnail_cache_identity(old_source),
                size,
                modified_at,
                max_edge,
            );
            let new_folder_key = thumbnail_cache_key(
                &folder_thumbnail_cache_identity(new_source),
                size,
                modified_at,
                max_edge,
            );
            let old_folder_filename = thumbnail_cache_filename(old_source, &old_folder_key);
            let new_folder_filename = thumbnail_cache_filename(new_source, &new_folder_key);
            migrate_thumbnail_cache_file(
                &old_dir.join(&old_folder_filename),
                &new_dir.join(&new_folder_filename),
            );
            migrate_thumbnail_cache_file(&old_dir.join(&old_filename), &new_dir.join(new_filename));
        }
    }
}

fn try_migrate_legacy_folder_thumbnail(source: &Path, new_path: &Path, max_edge: u32) -> bool {
    if new_path.is_file() {
        return true;
    }
    let Some(cache_dir) = folder_thumbnail_cache_dir(source, max_edge) else {
        return false;
    };
    if new_path.parent() != Some(cache_dir.as_path()) {
        return false;
    }
    let Some(stem) = source
        .file_stem()
        .and_then(|value| value.to_str())
        .map(sanitize_filename_part)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    let prefix = format!("{stem}__");
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return false;
    };

    let mut candidates = Vec::new();
    let source_modified_at = fs::metadata(source)
        .ok()
        .and_then(|metadata| metadata.modified().ok());
    for entry in entries.flatten() {
        let path = entry.path();
        if path == new_path || !path.is_file() {
            continue;
        }
        let filename = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if !filename.starts_with(&prefix) || !filename.ends_with(".jpg") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if let (Some(source_modified_at), Ok(cache_modified_at)) =
            (source_modified_at, metadata.modified())
        {
            if cache_modified_at < source_modified_at {
                continue;
            }
        }
        candidates.push(path);
    }

    if candidates.len() != 1 {
        return false;
    }
    migrate_thumbnail_cache_file(&candidates[0], new_path);
    new_path.is_file()
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

    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|error| error.to_string())
}

#[tauri::command]
fn reveal_file(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn open_crop_directory(app: tauri::AppHandle) -> Result<String, String> {
    let directory = crop_output_dir(&app);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    tauri_plugin_opener::open_path(&directory, None::<&str>)
        .map_err(|error| error.to_string())?;
    Ok(directory.to_string_lossy().into_owned())
}

fn visit_directory(directory: &Path, images: &mut Vec<ImageFile>) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| error.to_string())?;

        if file_type.is_dir() {
            if is_digiviewer_cache_dir(&path) || is_deleted_dir(&path) {
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

fn is_deleted_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.eq_ignore_ascii_case("deleted"))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_cross_platform_filename_characters() {
        assert_eq!(sanitize_filename_part("  bird<name>:?*.  "), "bird_name____");
        assert_eq!(sanitize_filename_part("line\nname"), "line_name");
    }

    #[test]
    fn folder_thumbnail_identity_ignores_absolute_parent_path() {
        let first = folder_thumbnail_cache_identity(Path::new("/Volumes/Photos/Observation.JPG"));
        let second = folder_thumbnail_cache_identity(Path::new("/mnt/shared/Observation.JPG"));

        assert_eq!(first, second);
        assert_eq!(first, "observation.jpg");
    }

    #[test]
    fn scans_thumbnails_and_renames_images_with_raw_sidecars() {
        let directory = std::env::temp_dir().join(format!(
            "digiviewer-image-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&directory).unwrap();
        let image_path = directory.join("observation 01.png");
        let raw_path = directory.join("observation 01.CR3");
        image::RgbImage::from_pixel(32, 24, image::Rgb([20, 120, 220]))
            .save(&image_path)
            .unwrap();
        fs::write(&raw_path, b"RAW sidecar test").unwrap();

        let scanned = scan_images(directory.to_string_lossy().into_owned()).unwrap();
        assert_eq!(scanned.len(), 2);

        let metadata = fs::metadata(&image_path).unwrap();
        let thumbnail = get_thumbnail(ThumbnailRequest {
            path: image_path.to_string_lossy().into_owned(),
            size: metadata.len(),
            modified_at: modified_at_millis(&metadata),
            max_edge: 128,
            cache_limit_mb: 64,
            prune_cache: false,
            cache_scope: Some(ThumbnailCacheScope::Folder),
        })
        .unwrap()
        .unwrap();
        assert!(Path::new(&thumbnail).is_file());

        let renamed = rename_images(RenameRequest {
            paths: vec![image_path.to_string_lossy().into_owned()],
            species_name: "bird:sample?".to_owned(),
        })
        .unwrap();
        assert_eq!(renamed.len(), 1);
        assert!(Path::new(&renamed[0].path).is_file());
        assert!(directory.join("observation 01_bird_sample_.CR3").is_file());

        fs::remove_dir_all(directory).unwrap();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_images,
            rename_images,
            move_images_to_deleted,
            copy_files_to_clipboard,
            app_version,
            get_thumbnail,
            build_thumbnail_cache,
            clean_thumbnail_cache,
            clear_thumbnail_cache,
            save_crop_image,
            save_crop_to_source_folder,
            ensure_crop_directory,
            open_external_url,
            reveal_file,
            open_crop_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
