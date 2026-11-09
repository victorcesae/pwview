use crate::config::{self, Config, Mode, STATE_DIR};
use crate::procs::{self, State};
use crate::{http, sys};
use anyhow::{bail, Context, Result};
use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command};
use std::time::{Duration, Instant};

pub struct Ctx {
    pub root: PathBuf,
    pub cfg: Config,
}

// ---------------------------------------------------------------- init

pub fn init(root: &Path, force: bool, no_mcp: bool) -> Result<()> {
    let cfg_path = root.join(config::FILE);
    if cfg_path.exists() && !force {
        say!("  keep    {} (already exists, --force to overwrite)", config::FILE);
    } else {
        fs::write(&cfg_path, config::TEMPLATE)?;
        say!("  write   {}", config::FILE);
    }

    let gi = root.join(".gitignore");
    let existing = fs::read_to_string(&gi).unwrap_or_default();
    let missing: Vec<&str> = [".pwview/", config::LOCAL_FILE]
        .into_iter()
        .filter(|e| !existing.lines().any(|l| l.trim() == *e))
        .collect();
    if !missing.is_empty() {
        let mut text = existing.clone();
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str("\n# pwview\n");
        for e in &missing {
            text.push_str(e);
            text.push('\n');
        }
        fs::write(&gi, text)?;
        say!("  update  .gitignore (+{})", missing.join(", "));
    }

    if !no_mcp {
        register_mcp(root, force)?;
    }

    say!("\nDone. Next:");
    say!("  pwview doctor      check dependencies");
    say!("  pwview setup       install Playwright's Chromium (--system on Linux for Xvfb/noVNC)");
    say!("  pwview up          start the shared browser and live view");
    Ok(())
}

fn register_mcp(root: &Path, force: bool) -> Result<()> {
    let path = root.join(".mcp.json");
    let mut doc: serde_json::Value = match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).with_context(|| format!("invalid {}", path.display()))?,
        Err(_) => serde_json::json!({}),
    };
    let entry = serde_json::json!({ "command": "pwview", "args": ["mcp"] });
    let servers = doc
        .as_object_mut()
        .context(".mcp.json is not a JSON object")?
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .context("mcpServers is not an object")?;
    match servers.get("playwright") {
        Some(v) if *v == entry => {
            say!("  keep    .mcp.json (playwright -> pwview mcp)");
            return Ok(());
        }
        Some(_) if !force => {
            say!("  skip    .mcp.json already has a different \"playwright\" server (--force to replace)");
            return Ok(());
        }
        _ => {}
    }
    servers.insert("playwright".into(), entry);
    fs::write(&path, serde_json::to_string_pretty(&doc)? + "\n")?;
    say!("  update  .mcp.json (playwright -> pwview mcp)");
    Ok(())
}

// ---------------------------------------------------------------- tools

fn npx() -> Result<PathBuf> {
    sys::which("npx").context("npx not found: install Node.js 18+")
}

const RESOLVE_CHROMIUM_JS: &str = "for (const m of ['playwright-core','playwright','@playwright/test']) { try { const p = require(m).chromium.executablePath(); if (p) { console.log(p); process.exit(0); } } catch (e) {} } process.exit(3);";

/// Where Google Chrome / Microsoft Edge are installed, for `executable = "chrome"` / `"msedge"`.
fn installed_browser(name: &str) -> Option<PathBuf> {
    let name = name.to_ascii_lowercase();
    let chrome = matches!(name.as_str(), "chrome" | "google-chrome" | "chrome-stable");
    let edge = matches!(name.as_str(), "msedge" | "edge" | "microsoft-edge");
    if !chrome && !edge {
        return None;
    }
    let mut c: Vec<PathBuf> = vec![];
    if cfg!(windows) {
        let rel = if chrome { r"Google\Chrome\Application\chrome.exe" } else { r"Microsoft\Edge\Application\msedge.exe" };
        for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Ok(base) = std::env::var(var) {
                c.push(PathBuf::from(base).join(rel));
            }
        }
    } else if cfg!(target_os = "macos") {
        c.push(PathBuf::from(if chrome {
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        } else {
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
        }));
    } else {
        let names: &[&str] = if chrome { &["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"] } else { &["microsoft-edge", "microsoft-edge-stable"] };
        for n in names {
            if let Some(p) = sys::which(n) {
                c.push(p);
            }
        }
    }
    c.into_iter().find(|p| p.is_file())
}

/// The computer's default web browser, as "chrome" / "msedge", when it is one pwview can drive
/// (Chromium-based, over CDP). Firefox, Safari and others give None.
fn default_browser() -> Option<&'static str> {
    let out = if cfg!(windows) {
        Command::new("reg")
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice",
                "/v",
                "ProgId",
            ])
            .output()
            .ok()?
    } else if cfg!(target_os = "macos") {
        return None;
    } else {
        Command::new("xdg-settings").args(["get", "default-web-browser"]).output().ok()?
    };
    let s = String::from_utf8_lossy(&out.stdout).to_ascii_lowercase();
    if s.contains("chrome") || s.contains("chromium") {
        Some("chrome")
    } else if s.contains("msedge") || s.contains("microsoft-edge") {
        Some("msedge")
    } else {
        None
    }
}

fn chromium(ctx: &Ctx) -> Result<PathBuf> {
    if let Some(exe) = &ctx.cfg.browser.executable {
        if exe.eq_ignore_ascii_case("default") {
            return default_browser()
                .and_then(installed_browser)
                .or_else(|| installed_browser("chrome"))
                .or_else(|| installed_browser("msedge"))
                .context("browser.executable = \"default\": the default browser is not Chromium-based (pwview drives Chrome/Edge/Chromium) and neither Chrome nor Edge is installed");
        }
        if let Some(p) = installed_browser(exe) {
            return Ok(p);
        }
        return sys::which(exe)
            .or_else(|| Some(PathBuf::from(exe)).filter(|p| p.is_file()))
            .with_context(|| format!("browser.executable not found: {exe}"));
    }
    let node = sys::which("node").context("node not found: install Node.js 18+")?;
    let out = Command::new(node)
        .args(["-e", RESOLVE_CHROMIUM_JS])
        .current_dir(&ctx.root)
        .output()?;
    // the project's own Playwright browser, else an installed Chrome, else any downloaded Chromium
    let project = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    if out.status.success() && project.is_file() {
        return Ok(project);
    }
    installed_browser("chrome")
        .or_else(cached_chromium)
        .context("no browser found: run `pwview setup` to download Playwright's Chromium")
}

/// Where Playwright keeps the browsers it downloads.
fn playwright_cache() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("PLAYWRIGHT_BROWSERS_PATH").filter(|p| !p.is_empty() && p != "0") {
        return Some(PathBuf::from(p));
    }
    if cfg!(windows) {
        return std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("ms-playwright"));
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    Some(if cfg!(target_os = "macos") { home.join("Library/Caches/ms-playwright") } else { home.join(".cache/ms-playwright") })
}

/// The newest Chromium in Playwright's download folder, whichever project downloaded it.
fn cached_chromium() -> Option<PathBuf> {
    let mut builds: Vec<(u64, PathBuf)> = fs::read_dir(playwright_cache()?)
        .ok()?
        .flatten()
        .filter_map(|e| Some((e.file_name().to_str()?.strip_prefix("chromium-")?.parse().ok()?, e.path())))
        .collect();
    builds.sort_by(|a, b| b.0.cmp(&a.0));
    builds.iter().find_map(|(_, dir)| chromium_in(dir))
}

fn chromium_in(build: &Path) -> Option<PathBuf> {
    const CANDIDATES: &[&str] = &[
        "chrome-linux64/chrome",
        "chrome-linux/chrome",
        "chrome-win64/chrome.exe",
        "chrome-win/chrome.exe",
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    ];
    CANDIDATES.iter().map(|c| build.join(c)).find(|p| p.is_file())
}

/// The browser's disk cache, per project.
const CACHE_BYTES: u64 = 100 * 1024 * 1024;

/// How long to wait for another process that is starting the browser (it may be downloading it).
const UP_LOCK_MAX: Duration = Duration::from_secs(600);

struct VncTools {
    xvfb: PathBuf,
    x11vnc: PathBuf,
    websockify: PathBuf,
    novnc_dir: PathBuf,
    wm: Option<PathBuf>,
}

fn novnc_dir() -> Option<PathBuf> {
    ["/usr/share/novnc", "/usr/local/share/novnc", "/opt/novnc", "/snap/novnc/current/usr/share/novnc"]
        .iter()
        .map(PathBuf::from)
        .find(|d| d.join("vnc.html").is_file())
}

fn vnc_tools() -> std::result::Result<VncTools, Vec<&'static str>> {
    let xvfb = sys::which("Xvfb");
    let x11vnc = sys::which("x11vnc");
    let websockify = sys::which("websockify");
    let novnc = novnc_dir();
    match (xvfb, x11vnc, websockify, novnc) {
        (Some(xvfb), Some(x11vnc), Some(websockify), Some(novnc_dir)) => Ok(VncTools {
            xvfb,
            x11vnc,
            websockify,
            novnc_dir,
            wm: sys::which("fluxbox"),
        }),
        (a, b, c, d) => {
            let mut missing = vec![];
            if a.is_none() { missing.push("Xvfb"); }
            if b.is_none() { missing.push("x11vnc"); }
            if c.is_none() { missing.push("websockify"); }
            if d.is_none() { missing.push("noVNC"); }
            Err(missing)
        }
    }
}

fn resolve_mode(requested: Mode) -> Result<Mode> {
    let linux = cfg!(target_os = "linux");
    Ok(match requested {
        Mode::Auto if linux && vnc_tools().is_ok() => Mode::Vnc,
        Mode::Auto => Mode::Cdp,
        Mode::Vnc if !linux => bail!("vnc mode needs Linux; use mode = \"cdp\" here"),
        Mode::Vnc => {
            if let Err(missing) = vnc_tools() {
                bail!("vnc mode needs {}: run `pwview setup --system`", missing.join(", "));
            }
            Mode::Vnc
        }
        Mode::Cdp => Mode::Cdp,
    })
}

fn display_env(ctx: &Ctx, state: &State) -> Vec<(&'static str, String)> {
    let mut env = vec![("PWVIEW_CDP_ENDPOINT", format!("http://127.0.0.1:{}", ctx.cfg.ports.cdp))];
    if state.has("xvfb") {
        env.push(("DISPLAY", format!(":{}", ctx.cfg.display.number)));
    }
    env
}

fn wait_until(timeout: Duration, mut ok: impl FnMut() -> Result<bool>) -> Result<bool> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if ok()? {
            return Ok(true);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Ok(false)
}

// ---------------------------------------------------------------- doctor / setup

pub fn doctor(ctx: &Ctx) -> Result<i32> {
    let mut problems = 0;
    let mut line = |ok: bool, what: &str, detail: String| {
        if !ok {
            problems += 1;
        }
        say!("  [{}] {:<22} {}", if ok { " ok " } else { "MISS" }, what, detail);
    };
    say!("pwview doctor · {}\n", ctx.root.display());

    let node = sys::which("node");
    line(node.is_some(), "node", node.map(|p| p.display().to_string()).unwrap_or("install Node.js 18+".into()));
    let n = sys::which("npx");
    line(n.is_some(), "npx", n.map(|p| p.display().to_string()).unwrap_or("comes with Node.js".into()));
    match chromium(ctx) {
        Ok(p) => line(true, "browser", p.display().to_string()),
        Err(e) => line(false, "browser", format!("{e:#}")),
    }
    let mcp_ok = ctx.root.join(".mcp.json").is_file();
    line(mcp_ok, ".mcp.json", if mcp_ok { "Claude Code -> pwview mcp".into() } else { "run `pwview init` to register the MCP server".into() });
    if sys::which("claude").is_none() {
        say!("  [info] {:<22} Claude Code CLI not on PATH (only needed for the AI part)", "claude");
    }

    if cfg!(target_os = "linux") {
        match vnc_tools() {
            Ok(t) => line(true, "live view (vnc)", format!("noVNC at {}{}", t.novnc_dir.display(), if t.wm.is_some() { ", fluxbox" } else { "" })),
            Err(missing) => {
                say!("  [info] {:<22} missing {}: falls back to cdp mode; `pwview setup --system` installs them", "live view (vnc)", missing.join(", "));
            }
        }
    } else {
        say!("  [info] {:<22} cdp mode (watch tabs via chrome://inspect)", "live view");
    }

    let p = &ctx.cfg.ports;
    for (name, port) in [("ui", p.ui), ("report", p.report), ("cdp", p.cdp), ("novnc", p.novnc), ("vnc", p.vnc)] {
        if !sys::port_free(port) {
            say!("  [info] port {name} {port} is in use (fine if `pwview up` is running; otherwise set it in {})", config::LOCAL_FILE);
        }
    }
    say!("");
    if problems == 0 {
        say!("All good.");
        Ok(0)
    } else {
        say!("{problems} problem(s). `pwview setup` fixes most of them.");
        Ok(1)
    }
}

fn package_manager() -> Option<(&'static str, &'static [&'static str])> {
    if sys::which("apt-get").is_some() {
        Some(("apt-get", &["xvfb", "x11vnc", "novnc", "websockify", "fluxbox"]))
    } else if sys::which("dnf").is_some() {
        Some(("dnf", &["xorg-x11-server-Xvfb", "x11vnc", "novnc", "python3-websockify", "fluxbox"]))
    } else {
        None
    }
}

pub fn setup(ctx: &Ctx, system: bool) -> Result<i32> {
    let linux = cfg!(target_os = "linux");
    if system && linux {
        let Some((pm, pkgs)) = package_manager() else {
            bail!("unsupported package manager: install Xvfb, x11vnc, noVNC, websockify, fluxbox manually");
        };
        let mut argv: Vec<String> = vec![];
        if !sys::is_root() {
            argv.push("sudo".into());
        }
        argv.push(pm.into());
        if pm == "apt-get" {
            let mut update = argv.clone();
            update.push("update".into());
            say!("$ {}", update.join(" "));
            run_argv(&ctx.root, &update)?;
        }
        argv.extend(["install", "-y"].map(String::from));
        argv.extend(pkgs.iter().map(|s| s.to_string()));
        say!("$ {}", argv.join(" "));
        let code = run_argv(&ctx.root, &argv)?;
        if code != 0 {
            return Ok(code);
        }
    }
    let mut args: Vec<String> = ["-y", "playwright", "install"].map(String::from).to_vec();
    if system && linux {
        args.push("--with-deps".into());
    }
    args.push("chromium".into());
    say!("$ npx {}", args.join(" "));
    procs::run_foreground(&ctx.root, &npx()?, &args, &[])
}

fn run_argv(root: &Path, argv: &[String]) -> Result<i32> {
    let prog = sys::which(&argv[0]).with_context(|| format!("{} not found", argv[0]))?;
    procs::run_foreground(root, &prog, &argv[1..], &[])
}

// ---------------------------------------------------------------- up / down

/// Start the browser if it isn't running, downloading Chromium first when there is no browser.
/// Holds a lock, so several chats asking at once start one browser.
pub fn ensure_browser(ctx: &Ctx, mode: Option<Mode>) -> Result<()> {
    if State::load(&ctx.root).is_running() {
        return Ok(());
    }
    let dir = ctx.root.join(STATE_DIR);
    fs::create_dir_all(&dir)?;
    let lock = dir.join("up.lock");
    let free = wait_until(UP_LOCK_MAX, || {
        if fs::OpenOptions::new().write(true).create_new(true).open(&lock).is_ok() {
            return Ok(true);
        }
        // left behind by a crash: nothing holds it this long
        let stale = fs::metadata(&lock).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > UP_LOCK_MAX);
        if stale {
            let _ = fs::remove_file(&lock);
        }
        Ok(false)
    })?;
    if !free {
        bail!("another pwview is still starting the browser ({} exists)", lock.display());
    }
    let result = (|| {
        if State::load(&ctx.root).is_running() {
            return Ok(()); // started while we waited for the lock
        }
        if ctx.cfg.browser.executable.is_none() && chromium(ctx).is_err() {
            say!("  install Playwright's Chromium");
            // stdout may be the MCP protocol channel: keep the installer's output off it
            let args = ["-y", "playwright", "install", "chromium"].map(String::from);
            if procs::run_quiet(&ctx.root, &npx()?, &args)? != 0 {
                bail!("downloading Chromium failed (npx playwright install chromium)");
            }
        }
        up(ctx, mode)
    })();
    let _ = fs::remove_file(&lock);
    result
}

pub fn up(ctx: &Ctx, mode_override: Option<Mode>) -> Result<()> {
    let old = State::load(&ctx.root);
    if old.is_running() {
        say!("Already running.");
        return Ok(());
    }
    if !old.services.is_empty() {
        old.stop_all(); // half-dead leftovers from a previous run
        State::clear(&ctx.root);
    }

    let mode = resolve_mode(mode_override.unwrap_or(ctx.cfg.mode))?;
    let browser = chromium(ctx)?;
    let ports = &ctx.cfg.ports;
    let mut needed = vec![("cdp", ports.cdp)];
    if mode == Mode::Vnc {
        needed.extend([("novnc", ports.novnc), ("vnc", ports.vnc)]);
    }
    for (name, port) in needed {
        if !sys::port_free(port) {
            bail!("port {port} ({name}) is busy: change ports.{name} in {}", config::LOCAL_FILE);
        }
    }

    let mut state = State { mode: Some(mode), services: vec![] };
    let result = start_services(ctx, mode, &browser, &mut state);
    if let Err(e) = result {
        state.stop_all();
        State::clear(&ctx.root);
        return Err(e);
    }
    state.save(&ctx.root)?;
    Ok(())
}

fn start(ctx: &Ctx, state: &mut State, name: &str, prog: &Path, args: Vec<String>, env: &[(&str, String)]) -> Result<std::process::Child> {
    say!("  start   {name}");
    let child = procs::spawn_detached(&ctx.root, name, prog, &args, env)?;
    state.services.push(procs::Service { name: name.into(), pid: child.id() });
    state.save(&ctx.root)?;
    Ok(child)
}

fn died(child: &mut std::process::Child, ctx: &Ctx, name: &str) -> Result<()> {
    if let Some(status) = child.try_wait()? {
        bail!("{name} exited ({status}); see {}", procs::log_path(&ctx.root, name).display());
    }
    Ok(())
}

fn start_services(ctx: &Ctx, mode: Mode, browser: &Path, state: &mut State) -> Result<()> {
    let c = &ctx.cfg;
    let (w, h) = c.display.size();
    let mut env: Vec<(&str, String)> = vec![];

    if mode == Mode::Vnc {
        let t = vnc_tools().map_err(|m| anyhow::anyhow!("missing {}", m.join(", ")))?;
        let n = c.display.number;
        let socket = PathBuf::from(format!("/tmp/.X11-unix/X{n}"));
        if socket.exists() {
            bail!("display :{n} is already in use: set display.number in {}", config::LOCAL_FILE);
        }
        let mut xvfb = start(ctx, state, "xvfb", &t.xvfb, vec![
            format!(":{n}"), "-screen".into(), "0".into(), c.display.resolution.clone(),
            "-nolisten".into(), "tcp".into(),
        ], &[])?;
        if !wait_until(Duration::from_secs(10), || { died(&mut xvfb, ctx, "xvfb")?; Ok(socket.exists()) })? {
            bail!("Xvfb did not come up on :{n}");
        }
        env.push(("DISPLAY", format!(":{n}")));
        if c.display.window_manager {
            if let Some(wm) = &t.wm {
                start(ctx, state, "fluxbox", wm, vec![], &env)?;
            }
        }
        let mut vnc = start(ctx, state, "x11vnc", &t.x11vnc, vec![
            "-display".into(), format!(":{n}"), "-localhost".into(), "-rfbport".into(),
            c.ports.vnc.to_string(), "-forever".into(), "-shared".into(), "-nopw".into(), "-quiet".into(),
        ], &env)?;
        let mut ws = start(ctx, state, "novnc", &t.websockify, vec![
            "--web".into(), t.novnc_dir.display().to_string(),
            format!("127.0.0.1:{}", c.ports.novnc), format!("127.0.0.1:{}", c.ports.vnc),
        ], &[])?;
        std::thread::sleep(Duration::from_millis(500));
        died(&mut vnc, ctx, "x11vnc")?;
        died(&mut ws, ctx, "novnc")?;
    }

    let profile = ctx.root.join(STATE_DIR).join("profile");
    let mut args = vec![
        format!("--remote-debugging-port={}", c.ports.cdp),
        "--remote-debugging-address=127.0.0.1".into(),
        format!("--user-data-dir={}", profile.display()),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        // the profile is kept per project: without a cap its cache grows to gigabytes
        format!("--disk-cache-size={CACHE_BYTES}"),
        format!("--window-size={w},{h}"),
        "--window-position=0,0".into(),
    ];
    if mode == Mode::Cdp {
        args.push("--headless=new".into());
    }
    if sys::is_root() && !c.browser.args.iter().any(|a| a == "--no-sandbox") {
        args.push("--no-sandbox".into()); // Chromium refuses to run as root otherwise
    }
    args.extend(c.browser.args.iter().cloned());
    args.push(c.browser.start_url.clone());

    let first = start_browser(ctx, state, browser, &args, &env);
    if first.is_err() && !args.iter().any(|a| a == "--no-sandbox") && sandbox_blocked(ctx) {
        // Ubuntu 23.10+ blocks unprivileged user namespaces, which Chromium's sandbox needs.
        say!("  note    this system blocks Chromium's sandbox: starting it with --no-sandbox");
        state.services.retain(|s| s.name != "browser");
        args.insert(0, "--no-sandbox".into());
        return start_browser(ctx, state, browser, &args, &env);
    }
    first
}

fn sandbox_blocked(ctx: &Ctx) -> bool {
    fs::read_to_string(procs::log_path(&ctx.root, "browser")).is_ok_and(|log| log.contains("No usable sandbox"))
}

fn start_browser(ctx: &Ctx, state: &mut State, browser: &Path, args: &[String], env: &[(&str, String)]) -> Result<()> {
    let mut chrome = start(ctx, state, "browser", browser, args.to_vec(), env)?;
    let port = ctx.cfg.ports.cdp;
    let ready = wait_until(Duration::from_secs(30), || {
        died(&mut chrome, ctx, "browser")?;
        Ok(http::get(port, "/json/version").is_ok())
    })?;
    if !ready {
        bail!("browser did not open its DevTools port {port}; see {}", procs::log_path(&ctx.root, "browser").display());
    }
    Ok(())
}

pub fn down(ctx: &Ctx) -> Result<()> {
    let state = State::load(&ctx.root);
    if state.services.is_empty() {
        say!("Nothing running.");
        return Ok(());
    }
    for s in state.services.iter().rev() {
        say!("  stop    {} (pid {})", s.name, s.pid);
        procs::kill_tree(s.pid);
    }
    State::clear(&ctx.root);
    Ok(())
}

// ---------------------------------------------------------------- status / pages

pub fn status(ctx: &Ctx) -> Result<()> {
    let state = State::load(&ctx.root);
    let p = &ctx.cfg.ports;
    say!("pwview · {}", ctx.root.display());
    if state.services.is_empty() {
        say!("Not running. Start it with `pwview up`.");
        return Ok(());
    }
    say!("mode: {}", state.mode.unwrap_or_default());
    for s in &state.services {
        let alive = procs::is_alive(s.pid);
        say!("  [{}] {:<10} pid {}", if alive { " up " } else { "DEAD" }, s.name, s.pid);
    }
    say!("\nWatch it (forward these ports; VS Code Remote-SSH does it automatically):");
    if state.has("novnc") {
        say!("  live screen   http://localhost:{}/vnc.html?autoconnect=true&resize=scale", p.novnc);
    }
    say!("  each tab      `pwview pages`, or chrome://inspect -> Configure -> localhost:{}", p.cdp);
    say!("  test runs     `pwview ui`     -> http://localhost:{}", p.ui);
    say!("  last report   `pwview report` -> http://localhost:{}", p.report);
    say!("\nClaude Code's Playwright MCP (`pwview mcp`) drives this same browser.");
    say!("Plain ssh: ssh -L {0}:localhost:{0} -L {1}:localhost:{1} -L {2}:localhost:{2} <host>", p.novnc, p.cdp, p.ui);
    Ok(())
}

pub fn status_json(ctx: &Ctx) -> Result<()> {
    let state = State::load(&ctx.root);
    let running = state.is_running();
    let doc = serde_json::json!({
        "root": ctx.root,
        "running": running,
        "mode": if running { state.mode } else { None },
        "ports": ctx.cfg.ports,
        "display": ctx.cfg.display.number,
    });
    say!("{doc}");
    Ok(())
}

pub fn pages(ctx: &Ctx) -> Result<()> {
    let port = ctx.cfg.ports.cdp;
    let list = http::get_json(port, "/json/list")
        .with_context(|| format!("no browser on port {port}: run `pwview up`"))?;
    let pages: Vec<_> = list
        .as_array()
        .map(|a| a.iter().filter(|t| t["type"] == "page").collect())
        .unwrap_or_default();
    if pages.is_empty() {
        say!("No pages open.");
        return Ok(());
    }
    say!("Open each link in Chrome/Edge to watch and drive that tab (screencast + DevTools):\n");
    for (i, t) in pages.iter().enumerate() {
        let title = t["title"].as_str().unwrap_or("");
        say!("{:>2}. {}", i + 1, if title.is_empty() { "(untitled)" } else { title });
        say!("    {}", t["url"].as_str().unwrap_or(""));
        say!(
            "    devtools://devtools/bundled/inspector.html?ws=localhost:{port}/devtools/page/{}",
            t["id"].as_str().unwrap_or("")
        );
    }
    Ok(())
}

// ---------------------------------------------------------------- passthrough commands

pub fn ui(ctx: &Ctx, extra: &[String]) -> Result<i32> {
    let state = State::load(&ctx.root);
    let port = ctx.cfg.ports.ui;
    let mut args: Vec<String> = vec![
        "playwright".into(), "test".into(), "--ui-host=127.0.0.1".into(), format!("--ui-port={port}"),
    ];
    args.extend(extra.iter().cloned());
    say!("Playwright UI mode -> http://localhost:{port}   (Ctrl+C to stop)");
    procs::run_foreground(&ctx.root, &npx()?, &args, &display_env(ctx, &state))
}

pub fn report(ctx: &Ctx, extra: &[String]) -> Result<i32> {
    let port = ctx.cfg.ports.report;
    let mut args: Vec<String> = vec![
        "playwright".into(), "show-report".into(), "--host".into(), "127.0.0.1".into(),
        "--port".into(), port.to_string(),
    ];
    args.extend(extra.iter().cloned());
    say!("HTML report -> http://localhost:{port}   (Ctrl+C to stop)");
    procs::run_foreground(&ctx.root, &npx()?, &args, &[])
}

pub fn run(ctx: &Ctx, command: &[String]) -> Result<i32> {
    let state = State::load(&ctx.root);
    let prog = sys::which(&command[0]).with_context(|| format!("{} not found on PATH", command[0]))?;
    procs::run_foreground(&ctx.root, &prog, &command[1..], &display_env(ctx, &state))
}

pub fn mcp(ctx: &Ctx) -> Result<i32> {
    let out_dir = ctx.root.join(STATE_DIR).join("mcp-output");
    let mut args: Vec<String> = vec![
        "-y".into(),
        ctx.cfg.mcp.package.clone(),
        "--cdp-endpoint".into(),
        format!("http://127.0.0.1:{}", ctx.cfg.ports.cdp),
        "--output-dir".into(),
        out_dir.display().to_string(),
    ];
    args.extend(ctx.cfg.mcp.args.iter().cloned());
    let mut child = procs::spawn_with_stdin(&ctx.root, &npx()?, &args)?;
    let to_server = child.stdin.take().context("no stdin for the MCP server")?;
    let owned = Ctx { root: ctx.root.clone(), cfg: ctx.cfg.clone() };
    // when the server exits, so do we; this thread may still be blocked reading stdin
    std::thread::spawn(move || forward_to_mcp(&owned, to_server));
    Ok(child.wait()?.code().unwrap_or(1))
}

/// A JSON-RPC request for an MCP tool: its id, when this line is one.
fn tool_call_id(line: &str) -> Option<serde_json::Value> {
    let msg: serde_json::Value = serde_json::from_str(line).ok()?;
    (msg["method"] == "tools/call").then(|| msg["id"].clone())
}

/// Passes the client's messages to the Playwright MCP server. Opening a chat costs nothing: the
/// browser only starts when a tool is called. If it can't start, the agent gets the reason.
fn forward_to_mcp(ctx: &Ctx, mut to_server: ChildStdin) {
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if let Some(id) = tool_call_id(&line) {
            if let Err(e) = ensure_browser(ctx, None) {
                let text = format!("pwview could not start the browser: {e:#}. On Linux, missing system libraries are installed by `pwview setup --system`.");
                let reply = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": { "content": [{ "type": "text", "text": text }], "isError": true } });
                let mut out = std::io::stdout().lock();
                let _ = writeln!(out, "{reply}");
                let _ = out.flush();
                continue;
            }
        }
        if writeln!(to_server, "{line}").and_then(|_| to_server.flush()).is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_tool_calls_need_the_browser() {
        assert_eq!(tool_call_id(r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"browser_navigate"}}"#), Some(serde_json::json!(7)));
        assert_eq!(tool_call_id(r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#), None);
        assert_eq!(tool_call_id(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#), None);
        assert_eq!(tool_call_id(r#"{"text":"tools/call"}"#), None);
        assert_eq!(tool_call_id("not json"), None);
    }

    #[test]
    fn finds_chromium_in_a_playwright_build() {
        let dir = std::env::temp_dir().join(format!("pwview-test-{}", std::process::id()));
        let exe = dir.join("chrome-linux64");
        fs::create_dir_all(&exe).unwrap();
        assert_eq!(chromium_in(&dir), None);
        fs::write(exe.join("chrome"), "").unwrap();
        assert_eq!(chromium_in(&dir), Some(exe.join("chrome")));
        fs::remove_dir_all(&dir).unwrap();
    }
}
