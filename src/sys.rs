use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

static STDERR_ONLY: AtomicBool = AtomicBool::new(false);

pub fn stderr_only() {
    STDERR_ONLY.store(true, Ordering::Relaxed);
}

pub fn say_str(s: &str) {
    use std::io::Write;
    // Ignore write errors (e.g. `pwview status | head`) instead of panicking.
    let _ = if STDERR_ONLY.load(Ordering::Relaxed) {
        writeln!(std::io::stderr(), "{s}")
    } else {
        writeln!(std::io::stdout(), "{s}")
    };
}

/// Find an executable on PATH. On Windows this honours PATHEXT, so `npx` finds `npx.cmd`.
pub fn which(name: &str) -> Option<PathBuf> {
    let p = Path::new(name);
    if p.components().count() > 1 || p.is_absolute() {
        return p.is_file().then(|| p.to_path_buf());
    }
    let names: Vec<String> = if cfg!(windows) && p.extension().is_none() {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .filter(|e| !e.is_empty())
            .map(|e| format!("{name}{}", e.to_ascii_lowercase()))
            .collect()
    } else {
        vec![name.to_string()]
    };
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|c| c.is_file())
}

pub fn port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

#[cfg(unix)]
pub fn is_root() -> bool {
    unsafe { libc::geteuid() == 0 }
}

#[cfg(not(unix))]
pub fn is_root() -> bool {
    false
}
