use std::{
    path::{Path, PathBuf},
    process::Command,
};

pub fn copy_files_to_clipboard(paths: &[String]) -> Result<(), String> {
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

pub fn open_external_url(url: &str) -> Result<(), String> {
    Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn reveal_file(path: &str) -> Result<(), String> {
    Command::new("open")
        .args(["-R", path])
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn open_directory(directory: &Path) -> Result<(), String> {
    Command::new("open")
        .arg(directory)
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn crop_output_dir() -> PathBuf {
    home_dir().join("Pictures").join("DigiViewer Crops")
}

pub fn thumbnail_cache_dir() -> PathBuf {
    home_dir()
        .join("Library")
        .join("Caches")
        .join("DigiViewer")
        .join("thumbnails")
}

fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
}
