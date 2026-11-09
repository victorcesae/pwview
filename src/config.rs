use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const FILE: &str = "pwview.toml";
pub const LOCAL_FILE: &str = "pwview.local.toml";
pub const STATE_DIR: &str = ".pwview";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// vnc on Linux when the tools are installed, otherwise cdp
    #[default]
    Auto,
    /// Headed browser on a virtual display, streamed through noVNC (Linux)
    Vnc,
    /// Headless browser, watched per tab through DevTools screencast (any OS)
    Cdp,
}

impl std::fmt::Display for Mode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Mode::Auto => "auto",
            Mode::Vnc => "vnc",
            Mode::Cdp => "cdp",
        })
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub mode: Mode,
    pub ports: Ports,
    pub display: Display,
    pub browser: Browser,
    pub mcp: Mcp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Ports {
    pub ui: u16,
    pub report: u16,
    pub cdp: u16,
    pub novnc: u16,
    pub vnc: u16,
}

impl Default for Ports {
    fn default() -> Self {
        Ports { ui: 8080, report: 9323, cdp: 9222, novnc: 6080, vnc: 5900 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Display {
    pub number: u16,
    pub resolution: String,
    pub window_manager: bool,
}

impl Default for Display {
    fn default() -> Self {
        Display { number: 99, resolution: "1920x1080x24".into(), window_manager: true }
    }
}

impl Display {
    pub fn size(&self) -> (u32, u32) {
        let mut it = self.resolution.split('x').filter_map(|p| p.parse().ok());
        (it.next().unwrap_or(1920), it.next().unwrap_or(1080))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Browser {
    pub executable: Option<String>,
    pub start_url: String,
    pub args: Vec<String>,
}

impl Default for Browser {
    fn default() -> Self {
        Browser { executable: None, start_url: "about:blank".into(), args: vec![] }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Mcp {
    pub package: String,
    pub args: Vec<String>,
}

impl Default for Mcp {
    fn default() -> Self {
        Mcp { package: "@playwright/mcp@latest".into(), args: vec![] }
    }
}

pub const TEMPLATE: &str = r#"# pwview: watch Playwright (and the AI driving it) from your browser.
# Shared by the whole team. Personal overrides (e.g. other ports when several
# devs share one SSH host) go in pwview.local.toml, which is git-ignored.

# auto: vnc on Linux when Xvfb/x11vnc/noVNC are installed, otherwise cdp
# vnc:  real headed browser on a virtual display, live at http://localhost:<novnc>
# cdp:  headless browser, each tab watchable through chrome://inspect (any OS)
mode = "auto"

[ports]
ui = 8080       # pwview ui     -> Playwright UI mode
report = 9323   # pwview report -> HTML report
cdp = 9222      # shared browser; Claude's Playwright MCP attaches here
novnc = 6080    # live view in your browser (vnc mode)
vnc = 5900      # raw VNC, bound to localhost (vnc mode)

[display]
number = 99
resolution = "1920x1080x24"
window_manager = true   # run fluxbox if installed, so windows can be moved/resized

[browser]
# executable = "chrome"   # your installed Google Chrome; "msedge" for Edge; "default" for this
#                          # computer's default browser (if Chromium-based); or a full path
#                          # default: Playwright's Chromium, else the installed Google Chrome
start_url = "about:blank"
args = []               # e.g. ["--no-sandbox"] inside containers

[mcp]
package = "@playwright/mcp@latest"
args = []               # extra Playwright MCP flags, e.g. ["--save-trace"]
"#;

fn absolute(p: PathBuf) -> Result<PathBuf> {
    Ok(if p.is_absolute() { p } else { std::env::current_dir()?.join(p) })
}

pub fn find_root(start: Option<PathBuf>) -> Result<PathBuf> {
    let start = absolute(start.unwrap_or(std::env::current_dir()?))?;
    for marker in [FILE, "package.json"] {
        if let Some(dir) = start.ancestors().find(|d| d.join(marker).is_file()) {
            return Ok(dir.to_path_buf());
        }
    }
    Ok(start)
}

fn merge(a: &mut toml::Value, b: toml::Value) {
    match (a, b) {
        (toml::Value::Table(at), toml::Value::Table(bt)) => {
            for (k, v) in bt {
                match at.get_mut(&k) {
                    Some(existing) => merge(existing, v),
                    None => {
                        at.insert(k, v);
                    }
                }
            }
        }
        (a, b) => *a = b,
    }
}

pub fn load(root: &Path) -> Result<Config> {
    let mut merged = toml::Value::Table(Default::default());
    for name in [FILE, LOCAL_FILE] {
        let path = root.join(name);
        if path.is_file() {
            let text = std::fs::read_to_string(&path)?;
            let value: toml::Value =
                toml::from_str(&text).with_context(|| format!("invalid {}", path.display()))?;
            merge(&mut merged, value);
        }
    }
    merged.try_into().context("invalid pwview configuration")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_parses_to_defaults() {
        let cfg: Config = toml::from_str(TEMPLATE).unwrap();
        assert_eq!(cfg.mode, Mode::Auto);
        assert_eq!(cfg.ports.cdp, 9222);
        assert_eq!(cfg.display.size(), (1920, 1080));
    }

    #[test]
    fn local_overrides_merge() {
        let mut a: toml::Value = toml::from_str(TEMPLATE).unwrap();
        merge(&mut a, toml::from_str("[ports]\ncdp = 9300").unwrap());
        let cfg: Config = a.try_into().unwrap();
        assert_eq!(cfg.ports.cdp, 9300);
        assert_eq!(cfg.ports.ui, 8080);
    }
}
