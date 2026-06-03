use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct ImageFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_at: u128,
    pub kind: FileKind,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Image,
    Raw,
}

#[derive(Deserialize)]
pub struct CropImage {
    pub bytes: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailRequest {
    pub path: String,
    pub size: u64,
    pub modified_at: u128,
    pub max_edge: u32,
    pub cache_limit_mb: u64,
    pub prune_cache: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameRequest {
    pub paths: Vec<String>,
    pub species_name: String,
}

#[derive(Serialize)]
pub struct RenameResult {
    pub old_path: String,
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_at: u128,
}
