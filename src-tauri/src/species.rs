//! Optional offline inference. No Node or system Python is required by the installed app.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

#[derive(Default)]
pub struct SpeciesState {
    busy: AtomicBool,
    stopping: AtomicBool,
    progress: Mutex<String>,
    error: Mutex<String>,
    child: Mutex<Option<Child>>,
}
struct BusyGuard<'a>(&'a SpeciesState);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::SeqCst);
    }
}
impl SpeciesState {
    fn acquire(&self) -> Result<BusyGuard<'_>, String> {
        self.busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "処理中です。完了してから操作してください。".to_string())?;
        Ok(BusyGuard(self))
    }
    fn stage(&self, message: &str) {
        *self.progress.lock().unwrap() = message.into();
    }
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
fn supported() -> bool {
    cfg!(all(target_os = "macos", target_arch = "aarch64"))
        || cfg!(all(target_os = "windows", target_arch = "x86_64"))
}
fn base(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("species-option"))
}
fn read_json(path: &Path) -> Result<Value, String> {
    match fs::read(path) {
        Ok(data) => serde_json::from_slice(&data).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e.to_string()),
    }
}
fn write_json(path: &Path, data: &Value) -> Result<(), String> {
    fs::write(path, serde_json::to_vec_pretty(data).unwrap()).map_err(|e| e.to_string())
}
fn safe_base(base: &Path) -> Result<(), String> {
    for p in [base.parent().unwrap(), base] {
        if fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("専用保存先にシンボリックリンクは使用できません。".into());
        }
    }
    Ok(())
}
fn python(base: &Path) -> PathBuf {
    base.join(if cfg!(windows) {
        "venv/Scripts/python.exe"
    } else {
        "venv/bin/python"
    })
}
fn installed(base: &Path) -> bool {
    let info = read_json(&base.join("installed.json")).unwrap_or(Value::Null);
    info["version"] == 1
        && info["os"] == std::env::consts::OS
        && info["arch"] == std::env::consts::ARCH
        && python(base).is_file()
        && base.join("assets.json").is_file()
}
fn enabled(base: &Path) -> bool {
    installed(base)
        && read_json(&base.join("settings.json")).unwrap_or(Value::Null)["enabled"] == true
}
fn private_command(program: &Path, base: &Path, offline: bool) -> Command {
    let mut cmd = Command::new(program);
    for (name, _) in std::env::vars_os() {
        let key = name.to_string_lossy().to_uppercase();
        if [
            "PYTHON",
            "PIP_",
            "UV_",
            "HF_",
            "HUGGINGFACE_",
            "TORCH_",
            "CONDA_",
            "VIRTUAL_ENV",
            "XDG_",
        ]
        .iter()
        .any(|p| key.starts_with(p))
        {
            cmd.env_remove(name);
        }
    }
    for (key, value) in [
        ("UV_NO_CONFIG", "1"),
        ("UV_PYTHON_NO_REGISTRY", "1"),
        ("UV_PYTHON_INSTALL_REGISTRY", "0"),
        ("UV_PYTHON_INSTALL_BIN", "0"),
        ("UV_NO_MODIFY_PATH", "1"),
        ("UV_MANAGED_PYTHON", "1"),
        ("UV_LINK_MODE", "copy"),
        ("PYTHONNOUSERSITE", "1"),
        ("PYTHONDONTWRITEBYTECODE", "1"),
        ("PYTHONUTF8", "1"),
        ("PYTHONUNBUFFERED", "1"),
        ("HF_HUB_DISABLE_TELEMETRY", "1"),
        ("HF_HUB_DISABLE_XET", "1"),
        ("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1"),
        ("HF_HUB_DOWNLOAD_TIMEOUT", "120"),
        ("TOKENIZERS_PARALLELISM", "false"),
    ] {
        cmd.env(key, value);
    }
    for (key, dir) in [
        ("UV_PYTHON_INSTALL_DIR", "python"),
        ("UV_PYTHON_BIN_DIR", "bin"),
        ("UV_CACHE_DIR", "uv-cache"),
        ("UV_CREDENTIALS_DIR", "credentials"),
        ("HF_HOME", "huggingface"),
        ("TORCH_HOME", "torch"),
        ("XDG_CACHE_HOME", "cache"),
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_DATA_HOME", "data"),
        ("TMPDIR", "tmp"),
        ("TMP", "tmp"),
        ("TEMP", "tmp"),
    ] {
        cmd.env(key, base.join(dir));
    }
    cmd.env("HF_HUB_OFFLINE", if offline { "1" } else { "0" });
    cmd.current_dir(base);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}
fn execute(
    state: &SpeciesState,
    mut cmd: Command,
    base: &Path,
    input: Option<&Value>,
    seconds: u64,
) -> Result<String, String> {
    if state.stopping.load(Ordering::SeqCst) {
        return Err("処理を終了しました。".into());
    }
    let stdout = base.join("tmp/output.log");
    let stderr = base.join("tmp/error.log");
    cmd.stdout(Stdio::from(
        fs::File::create(&stdout).map_err(|e| e.to_string())?,
    ));
    cmd.stderr(Stdio::from(
        fs::File::create(&stderr).map_err(|e| e.to_string())?,
    ));
    cmd.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("処理を開始できませんでした: {e}"))?;
    if let Some(value) = input {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = writeln!(stdin, "{value}");
        }
    }
    *state.child.lock().unwrap() = Some(child);
    let start = Instant::now();
    loop {
        let mut slot = state.child.lock().unwrap();
        let child = slot.as_mut().ok_or("処理が終了しました。")?;
        if state.stopping.load(Ordering::SeqCst) || start.elapsed() > Duration::from_secs(seconds) {
            let _ = child.kill();
            let _ = child.wait();
            *slot = None;
            return Err("処理を中断しました。時間がかかる場合はCPUでも再試行できます。".into());
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            *slot = None;
            if !status.success() {
                let detail = fs::read_to_string(stderr).unwrap_or_default();
                return Err(format!(
                    "処理に失敗しました。再試行できます。\n{}",
                    detail
                        .chars()
                        .rev()
                        .take(2000)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect::<String>()
                ));
            }
            return fs::read_to_string(stdout)
                .map(|s| s.trim().to_string())
                .map_err(|e| e.to_string());
        }
        drop(slot);
        std::thread::sleep(Duration::from_millis(100));
    }
}
fn embed_scripts(base: &Path) -> Result<(), String> {
    fs::write(base.join("worker.py"), include_str!("../species/worker.py"))
        .map_err(|e| e.to_string())?;
    fs::write(
        base.join("prepare.py"),
        include_str!("../species/prepare.py"),
    )
    .map_err(|e| e.to_string())
}
fn install_inner(base: &Path, state: &SpeciesState, backend: &str) -> Result<(), String> {
    if !supported() {
        return Err("対応環境はApple Silicon MacとWindows x64です。".into());
    }
    if !["cpu", "cuda"].contains(&backend) || (backend == "cuda" && !cfg!(windows)) {
        return Err("実行方式を選び直してください。".into());
    }
    safe_base(base)?;
    if enabled(base) {
        return Err("再導入する前に無効にしてください。".into());
    }
    fs::create_dir_all(base.join("tmp")).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(base.join("installed.json"));
    embed_scripts(base)?;
    let (platform, suffix, digest) = if cfg!(windows) {
        (
            "x86_64-pc-windows-msvc",
            "zip",
            "a252121d5b59398fcb137c6ea448176459a44010f33f67e0072305a637119ca7",
        )
    } else {
        (
            "aarch64-apple-darwin",
            "tar.gz",
            "85f00cbdc6dd3e97eba4c31b4d014375a9fdfe8f570023b84e5102fc3456896b",
        )
    };
    let archive = base.join(format!("uv.{suffix}"));
    let system =
        PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
            .join("System32");
    let curl = if cfg!(windows) {
        system.join("curl.exe")
    } else {
        PathBuf::from("/usr/bin/curl")
    };
    state.stage("専用の導入ツールを取得しています");
    let mut cmd = private_command(&curl, base, false);
    cmd.args([
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--max-time",
        "300",
        "--output",
    ])
    .arg(&archive)
    .arg(format!(
        "https://github.com/astral-sh/uv/releases/download/0.12.17/uv-{platform}.{suffix}"
    ));
    execute(state, cmd, base, None, 310)?;
    let mut hash = Sha256::new();
    let mut file = fs::File::open(&archive).map_err(|e| e.to_string())?;
    let mut chunk = [0u8; 65536];
    loop {
        let n = file.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&chunk[..n]);
    }
    if format!("{:x}", hash.finalize()) != digest {
        return Err("導入ツールの検証に失敗しました。".into());
    }
    let tools = base.join("tools");
    fs::create_dir_all(&tools).map_err(|e| e.to_string())?;
    let mut cmd;
    if cfg!(windows) {
        cmd = private_command(
            &system.join("WindowsPowerShell/v1.0/powershell.exe"),
            base,
            false,
        );
        cmd.args(["-NoProfile","-NonInteractive","-Command","Expand-Archive -LiteralPath $env:DIGIVIEWER_ARCHIVE -DestinationPath $env:DIGIVIEWER_TOOLS -Force"]);
        cmd.env("DIGIVIEWER_ARCHIVE", &archive)
            .env("DIGIVIEWER_TOOLS", &tools);
    } else {
        cmd = private_command(Path::new("/usr/bin/tar"), base, false);
        cmd.arg("-xzf").arg(&archive).arg("-C").arg(&tools);
    }
    execute(state, cmd, base, None, 120)?;
    let uv = if cfg!(windows) {
        tools.join("uv.exe")
    } else {
        tools.join(format!("uv-{platform}/uv"))
    };
    // Windows release archives may also have a containing directory.
    let uv = if uv.is_file() {
        uv
    } else {
        tools.join(format!("uv-{platform}/uv.exe"))
    };
    state.stage("専用Pythonを準備しています");
    let mut cmd = private_command(&uv, base, false);
    cmd.args(["python", "install", "3.12", "--no-bin"]);
    execute(state, cmd, base, None, 1200)?;
    let mut cmd = private_command(&uv, base, false);
    cmd.args(["python", "find", "--managed-python", "3.12"]);
    let managed = PathBuf::from(execute(state, cmd, base, None, 60)?);
    if !managed
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(
            base.join("python")
                .canonicalize()
                .map_err(|e| e.to_string())?,
        )
    {
        return Err("専用Pythonの保存先が不正です。".into());
    }
    let mut cmd = private_command(&uv, base, false);
    cmd.args(["venv", "--python"])
        .arg(&managed)
        .arg(base.join("venv"))
        .arg("--allow-existing");
    execute(state, cmd, base, None, 120)?;
    state.stage("画像判定用ライブラリを準備しています（数分かかります）");
    let mut cmd = private_command(&uv, base, false);
    cmd.args(["pip", "install", "--python"])
        .arg(python(base))
        .args([
            "--only-binary",
            ":all:",
            "--reinstall-package",
            "torch",
            "--reinstall-package",
            "torchvision",
        ]);
    if cfg!(windows) {
        cmd.args([
            "--torch-backend",
            if backend == "cuda" { "cu128" } else { "cpu" },
        ]);
    }
    cmd.args([
        "torch==2.8.0",
        "torchvision==0.23.0",
        "open_clip_torch==3.3.0",
        "numpy==2.2.6",
        "Pillow==11.3.0",
        "huggingface_hub==0.34.4",
    ]);
    execute(state, cmd, base, None, 3600)?;
    state.stage("判定モデルと日本の記録を取得しています（約4.5GB）");
    let mut cmd = private_command(&python(base), base, false);
    cmd.arg("-s").arg(base.join("prepare.py")).arg(base);
    execute(state, cmd, base, None, 7200)?;
    state.stage("専用環境の動作を確認しています");
    let mut cmd = private_command(&python(base), base, true);
    cmd.arg("-s")
        .arg(base.join("worker.py"))
        .arg(base)
        .arg("--check");
    execute(state, cmd, base, None, 600)?;
    write_json(
        &base.join("installed.json"),
        &json!({"version":1,"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"backend":backend}),
    )?;
    state.stage("導入が完了しました。有効にすると利用できます。");
    Ok(())
}
#[tauri::command]
pub fn species_status(
    app: tauri::AppHandle,
    state: tauri::State<SpeciesState>,
) -> Result<Value, String> {
    let base = base(&app)?;
    Ok(
        json!({"supported":supported(),"windows":cfg!(windows),"installed":installed(&base),"enabled":enabled(&base),"busy":state.busy.load(Ordering::SeqCst),"progress":state.progress.lock().unwrap().clone(),"error":state.error.lock().unwrap().clone(),"geography":read_json(&base.join("assets.json"))?["geography"],"backend":read_json(&base.join("installed.json"))?["backend"]}),
    )
}
#[tauri::command]
pub fn species_install(app: tauri::AppHandle, backend: String) -> Result<(), String> {
    let state = app.state::<SpeciesState>();
    // Reserve the operation before returning to prevent two simultaneous installs.
    state
        .busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "処理中です。")?;
    state.stage("導入を開始しています");
    *state.error.lock().unwrap() = String::new();
    std::thread::spawn(move || {
        let state = app.state::<SpeciesState>();
        let _guard = BusyGuard(&state);
        let result = base(&app).and_then(|base| install_inner(&base, &state, &backend));
        if let Err(error) = result {
            *state.error.lock().unwrap() = error;
        }
    });
    Ok(())
}
#[tauri::command]
pub fn species_enable(
    app: tauri::AppHandle,
    state: tauri::State<SpeciesState>,
    value: bool,
) -> Result<(), String> {
    let _guard = state.acquire()?;
    let base = base(&app)?;
    safe_base(&base)?;
    if !installed(&base) {
        return Err("先に種名推測を導入してください。".into());
    }
    write_json(&base.join("settings.json"), &json!({"enabled":value}))
}
#[tauri::command]
pub async fn species_uninstall(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SpeciesState>();
        let _guard = state.acquire()?;
        let base = base(&app)?;
        safe_base(&base)?;
        if base.exists() {
            fs::remove_dir_all(&base).map_err(|e| e.to_string())?;
        }
        state.stage("");
        *state.error.lock().unwrap() = String::new();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn species_identify(
    app: tauri::AppHandle,
    path: String,
    japan: bool,
    cpu: bool,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SpeciesState>();
        let _guard = state.acquire()?;
        let base = base(&app)?;
        safe_base(&base)?;
        if !enabled(&base) {
            return Err("設定で種名推測を有効にしてください。".into());
        }
        let image = PathBuf::from(path)
            .canonicalize()
            .map_err(|_| "写真が見つかりません。")?;
        let ext = image
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff", "gif"].contains(&ext.as_str())
            || !image.is_file()
        {
            return Err(
                "JPEG・PNG・WebPなどの写真を選んでください。RAW・HEICは判定対象外です。".into(),
            );
        }
        if fs::metadata(&image).map_err(|e| e.to_string())?.len() > 150 * 1024 * 1024 {
            return Err("150MBを超える写真は判定できません。".into());
        }
        embed_scripts(&base)?;
        state.stage("写真を判定しています");
        let mut cmd = private_command(&python(&base), &base, true);
        cmd.arg("-s").arg(base.join("worker.py")).arg(&base);
        let output = execute(
            &state,
            cmd,
            &base,
            Some(&json!({"image":image,"japan":japan,"device":if cpu {"cpu"} else {"auto"}})),
            600,
        )?;
        serde_json::from_str(&output).map_err(|e| format!("判定結果を読み取れませんでした: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_is_disabled_and_read_only() {
        let base = std::env::temp_dir().join(format!("digiviewer-absent-{}", std::process::id()));
        assert!(!base.exists());
        assert!(!enabled(&base));
        assert!(!installed(&base));
        assert!(!base.exists());
    }
    #[test]
    fn operations_are_exclusive_and_release_after_failure() {
        let state = SpeciesState::default();
        let guard = state.acquire().unwrap();
        assert!(state.acquire().is_err());
        drop(guard);
        assert!(state.acquire().is_ok());
    }
    #[test]
    fn environment_is_private_without_replacing_home_or_path() {
        let base = PathBuf::from("private-feature");
        let cmd = private_command(Path::new("python"), &base, true);
        let env: std::collections::HashMap<_, _> = cmd
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().to_string(),
                    v.map(|x| x.to_string_lossy().to_string()),
                )
            })
            .collect();
        for (key, value) in [
            ("UV_PYTHON_NO_REGISTRY", "1"),
            ("UV_PYTHON_INSTALL_BIN", "0"),
            ("HF_HUB_OFFLINE", "1"),
            ("PYTHONNOUSERSITE", "1"),
        ] {
            assert_eq!(env.get(key).unwrap().as_deref(), Some(value));
        }
        assert!(!env.contains_key("HOME"));
        assert!(!env.contains_key("PATH"));
        assert_eq!(
            env["UV_PYTHON_INSTALL_DIR"],
            Some(base.join("python").to_string_lossy().to_string())
        );
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    #[test]
    #[ignore = "Downloads private Python and model; requires explicit local smoke-test paths"]
    fn native_install_and_offline_inference() {
        let base = PathBuf::from(
            std::env::var("DIGIVIEWER_SPECIES_SMOKE_BASE").expect("temporary smoke-test directory"),
        );
        let photo =
            PathBuf::from(std::env::var("DIGIVIEWER_SPECIES_SMOKE_PHOTO").expect("test photo"));
        assert!(
            base.starts_with(std::env::temp_dir())
                || fs::canonicalize("/tmp").is_ok_and(|tmp| base.starts_with(tmp))
        );
        let before = fs::read(&photo).unwrap();
        let state = SpeciesState::default();
        install_inner(&base, &state, "cpu").unwrap();
        assert!(installed(&base));
        assert!(!enabled(&base));
        write_json(&base.join("settings.json"), &json!({"enabled":true})).unwrap();
        assert!(enabled(&base));
        for device in ["cpu", "auto"] {
            let mut cmd = private_command(&python(&base), &base, true);
            cmd.arg("-s").arg(base.join("worker.py")).arg(&base);
            let result: Value = serde_json::from_str(
                &execute(
                    &state,
                    cmd,
                    &base,
                    Some(&json!({"image":photo,"japan":true,"device":device})),
                    600,
                )
                .unwrap(),
            )
            .unwrap();
            assert_eq!(result["candidates"].as_array().unwrap().len(), 5);
            assert_eq!(result["candidates"][0]["scientificName"], "Papilio xuthus");
            println!(
                "{}: {} seconds, {}",
                device, result["seconds"], result["device"]
            );
        }
        assert_eq!(fs::read(photo).unwrap(), before);
        write_json(&base.join("settings.json"), &json!({"enabled":false})).unwrap();
        assert!(!enabled(&base));
    }
}
