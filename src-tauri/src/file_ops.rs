use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use crate::models::{RenameRequest, RenameResult};

pub fn rename_images_with_species(request: RenameRequest) -> Result<Vec<RenameResult>, String> {
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
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_owned());

        let target = available_renamed_path(parent, stem, extension.as_deref(), &species_name);
        fs::rename(&source, &target).map_err(|error| error.to_string())?;
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

pub fn modified_at_millis(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}
