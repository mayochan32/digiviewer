use std::{
    mem,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    process::Command,
};

use windows_sys::Win32::{
    Foundation::{HANDLE, POINT},
    System::{
        DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
        Memory::{GlobalAlloc, GlobalFree, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
        Ole::CF_HDROP,
    },
    UI::Shell::DROPFILES,
};

pub fn copy_files_to_clipboard(paths: &[String]) -> Result<(), String> {
    let data = hdrop_bytes(paths)?;
    unsafe {
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

        if SetClipboardData(CF_HDROP as u32, handle as HANDLE).is_null() {
            GlobalFree(handle);
            return Err("ファイルコピーに失敗しました。".to_owned());
        }
    }
    Ok(())
}

struct ClipboardGuard;

impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        unsafe {
            CloseClipboard();
        }
    }
}

fn hdrop_bytes(paths: &[String]) -> Result<Vec<u8>, String> {
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
    }
    Ok(data)
}

pub fn open_external_url(url: &str) -> Result<(), String> {
    Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn reveal_file(path: &str) -> Result<(), String> {
    Command::new("explorer")
        .arg(format!("/select,{path}"))
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn open_directory(directory: &Path) -> Result<(), String> {
    Command::new("explorer")
        .arg(directory)
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn crop_output_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("Pictures")
        .join("DigiViewer Crops")
}

pub fn thumbnail_cache_dir() -> PathBuf {
    std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("DigiViewer")
        .join("Cache")
        .join("thumbnails")
}
