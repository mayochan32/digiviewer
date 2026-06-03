use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use crate::{
    file_ops, image_scan,
    models::{CropImage, ImageFile, RenameRequest, RenameResult, ThumbnailRequest},
    platform, thumbnails,
};

#[tauri::command]
pub fn scan_images(directory: String) -> Result<Vec<ImageFile>, String> {
    image_scan::scan_images_in_directory(&PathBuf::from(directory))
}

#[tauri::command]
pub fn rename_images(request: RenameRequest) -> Result<Vec<RenameResult>, String> {
    file_ops::rename_images_with_species(request)
}

#[tauri::command]
pub fn copy_files_to_clipboard(paths: Vec<String>) -> Result<(), String> {
    let existing_paths: Vec<String> = paths
        .into_iter()
        .filter(|path| Path::new(path).is_file())
        .collect();
    if existing_paths.is_empty() {
        return Err("コピーするファイルがありません。".to_owned());
    }
    platform::copy_files_to_clipboard(&existing_paths)
}

#[tauri::command]
pub fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn get_thumbnail(request: ThumbnailRequest) -> Result<Option<String>, String> {
    thumbnails::get_thumbnail_path(request)
}

#[tauri::command]
pub fn save_crop_image(image: CropImage) -> Result<String, String> {
    let directory = platform::crop_output_dir();
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
pub fn ensure_crop_directory() -> Result<String, String> {
    let directory = platform::crop_output_dir();
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://www.google.com/") || url.starts_with("https://lens.google.com/"))
    {
        return Err("unsupported url".to_owned());
    }
    platform::open_external_url(&url)
}

#[tauri::command]
pub fn reveal_file(path: String) -> Result<(), String> {
    platform::reveal_file(&path)
}

#[tauri::command]
pub fn open_crop_directory() -> Result<String, String> {
    let directory = platform::crop_output_dir();
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    platform::open_directory(&directory)?;
    Ok(directory.to_string_lossy().into_owned())
}
