mod commands;
mod file_ops;
mod image_scan;
mod models;
mod platform;
mod thumbnails;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::scan_images,
            commands::rename_images,
            commands::copy_files_to_clipboard,
            commands::app_version,
            commands::get_thumbnail,
            commands::save_crop_image,
            commands::ensure_crop_directory,
            commands::open_external_url,
            commands::reveal_file,
            commands::open_crop_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
