//! Background services: spawn detached, remember pids, stop process trees.
use crate::config::{Mode, STATE_DIR};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Service {
    pub name: String,
    pub pid: u32,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct State {
    pub mode: Option<Mode>,
    pub services: Vec<Service>,
}

impl State {
    fn path(root: &Path) -> PathBuf {
        root.join(STATE_DIR).join("state.json")
    }

    pub fn load(root: &Path) -> State {
        fs::read_to_string(Self::path(root))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, root: &Path) -> Result<()> {
        fs::create_dir_all(root.join(STATE_DIR))?;
        fs::write(Self::path(root), serde_json::to_string_pretty(self)?)?;
        Ok(())
    }

    pub fn clear(root: &Path) {
        let _ = fs::remove_file(Self::path(root));
    }

    pub fn is_running(&self) -> bool {
        !self.services.is_empty() && self.services.iter().all(|s| is_alive(s.pid))
    }

    pub fn has(&self, name: &str) -> bool {
        self.services.iter().any(|s| s.name == name && is_alive(s.pid))
    }

    /// Stop services in reverse start order.
    pub fn stop_all(&self) {
        for s in self.services.iter().rev() {
            kill_tree(s.pid);
        }
    }
}

pub fn log_path(root: &Path, name: &str) -> PathBuf {
    root.join(STATE_DIR).join("logs").join(format!("{name}.log"))
}

pub fn spawn_detached(
    root: &Path,
    name: &str,
    program: &Path,
    args: &[String],
    envs: &[(&str, String)],
) -> Result<Child> {
    let log_file = log_path(root, name);
    fs::create_dir_all(log_file.parent().unwrap())?;
    let log = File::create(&log_file)?;
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    detach_spawn(&mut cmd).with_context(|| format!("failed to start {}", program.display()))
}

pub fn run_foreground(
    root: &Path,
    program: &Path,
    args: &[String],
    envs: &[(&str, String)],
) -> Result<i32> {
    let mut cmd = Command::new(program);
    cmd.args(args).current_dir(root);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let status = cmd.status().with_context(|| format!("failed to run {}", program.display()))?;
    Ok(status.code().unwrap_or(1))
}

// ---------- unix ----------

#[cfg(unix)]
fn detach_spawn(cmd: &mut Command) -> std::io::Result<Child> {
    use std::os::unix::process::CommandExt;
    // New session: survives the SSH/terminal closing, and pid == process group id.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cmd.spawn()
}

#[cfg(unix)]
pub fn is_alive(pid: u32) -> bool {
    // Reap it first if it is our own exited child, so a zombie doesn't look alive.
    unsafe { libc::waitpid(pid as libc::pid_t, std::ptr::null_mut(), libc::WNOHANG) };
    if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(unix)]
pub fn kill_tree(pid: u32) {
    let group = -(pid as libc::pid_t);
    unsafe { libc::kill(group, libc::SIGTERM) };
    for _ in 0..30 {
        if !is_alive(pid) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    unsafe { libc::kill(group, libc::SIGKILL) };
}

// ---------- windows ----------

#[cfg(windows)]
fn detach_spawn(cmd: &mut Command) -> std::io::Result<Child> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    // Break away from the SSH session's job so closing the session doesn't kill us;
    // fall back when the job forbids breakaway.
    cmd.creation_flags(base | CREATE_BREAKAWAY_FROM_JOB);
    match cmd.spawn() {
        Ok(c) => Ok(c),
        Err(_) => {
            cmd.creation_flags(base);
            cmd.spawn()
        }
    }
}

#[cfg(windows)]
pub fn is_alive(pid: u32) -> bool {
    Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\"")))
        .unwrap_or(false)
}

#[cfg(windows)]
pub fn kill_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}
