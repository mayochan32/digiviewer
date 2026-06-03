use std::path::{Path, PathBuf};

pub fn copy_files_to_clipboard(_paths: &[String]) -> Result<(), String> {
    Err("ファイルコピーはこのOSでは未対応です。".to_owned())
}

pub fn open_external_url(_url: &str) -> Result<(), String> {
    Err("外部URLを開く処理はこのOSでは未対応です。".to_owned())
}

pub fn reveal_file(_path: &str) -> Result<(), String> {
    Err("ファイル表示はこのOSでは未対応です。".to_owned())
}

pub fn open_directory(_directory: &Path) -> Result<(), String> {
    Err("フォルダ表示はこのOSでは未対応です。".to_owned())
}

pub fn crop_output_dir() -> PathBuf {
    std::env::temp_dir().join("DigiViewer").join("Crops")
}

pub fn thumbnail_cache_dir() -> PathBuf {
    std::env::temp_dir().join("DigiViewer").join("thumbnails")
}
