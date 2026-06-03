use std::{
    fs::{self, File},
    io::BufWriter,
    path::PathBuf,
    time::UNIX_EPOCH,
};

use crate::{models::ThumbnailRequest, platform};

pub fn get_thumbnail_path(request: ThumbnailRequest) -> Result<Option<String>, String> {
    let source = PathBuf::from(&request.path);
    if !source.is_file() {
        return Ok(None);
    }

    let max_edge = request.max_edge.clamp(64, 512);
    let cache_dir = platform::thumbnail_cache_dir();
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

    let cache_dir = platform::thumbnail_cache_dir();
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
