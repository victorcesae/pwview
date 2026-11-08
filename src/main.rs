/// Print a line to stdout, or to stderr while running as an MCP server
/// (stdout is the MCP protocol channel there).
macro_rules! say {
    ($($t:tt)*) => { $crate::sys::say_str(&format!($($t)*)) };
}

mod commands;
mod config;
mod http;
mod procs;
mod sys;

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "pwview",
    version,
    about = "Watch Playwright (and the AI driving it) from your browser. Everything runs on the host; you only open a page."
)]
struct Cli {
    /// Project directory (default: nearest folder with pwview.toml, else package.json)
    #[arg(short = 'C', long = "dir", global = true)]
    dir: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Add pwview to this project (pwview.toml, .gitignore, .mcp.json)
    Init {
        /// Overwrite an existing pwview.toml / playwright MCP entry
        #[arg(long)]
        force: bool,
        /// Don't register the Playwright MCP server for Claude Code
        #[arg(long)]
        no_mcp: bool,
    },
    /// Check that everything needed is installed
    Doctor,
    /// Install Playwright's Chromium (and with --system, the Linux display tools)
    Setup {
        /// Also install system packages (Xvfb, x11vnc, noVNC, browser deps) with sudo
        #[arg(long)]
        system: bool,
    },
    /// Start the shared browser (plus virtual display + noVNC on Linux)
    Up {
        #[arg(long, value_enum)]
        mode: Option<config::Mode>,
    },
    /// Stop everything `up` started
    Down,
    /// Show what is running and where to watch it
    Status,
    /// List the pages open in the shared browser, each with its own DevTools link
    Pages,
    /// Playwright UI mode (timeline, DOM snapshots, watch mode) served on localhost
    Ui {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Serve the last HTML report on localhost
    Report {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Run a command with DISPLAY and PWVIEW_CDP_ENDPOINT set (e.g. pwview run npx playwright test --headed)
    Run {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true, required = true)]
        command: Vec<String>,
    },
    /// stdio MCP server for Claude Code: Playwright MCP attached to the shared browser
    Mcp,
}

fn main() {
    let cli = Cli::parse();
    match run(cli) {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            eprintln!("pwview: {e:#}");
            std::process::exit(1);
        }
    }
}

fn run(cli: Cli) -> Result<i32> {
    if matches!(cli.cmd, Cmd::Mcp) {
        sys::stderr_only();
    }
    let root = config::find_root(cli.dir)?;
    if let Cmd::Init { force, no_mcp } = cli.cmd {
        commands::init(&root, force, no_mcp)?;
        return Ok(0);
    }
    let ctx = commands::Ctx { cfg: config::load(&root)?, root };
    match cli.cmd {
        Cmd::Init { .. } => unreachable!(),
        Cmd::Doctor => commands::doctor(&ctx),
        Cmd::Setup { system } => commands::setup(&ctx, system),
        Cmd::Up { mode } => {
            commands::up(&ctx, mode)?;
            commands::status(&ctx)?;
            Ok(0)
        }
        Cmd::Down => commands::down(&ctx).map(|_| 0),
        Cmd::Status => commands::status(&ctx).map(|_| 0),
        Cmd::Pages => commands::pages(&ctx).map(|_| 0),
        Cmd::Ui { args } => commands::ui(&ctx, &args),
        Cmd::Report { args } => commands::report(&ctx, &args),
        Cmd::Run { command } => commands::run(&ctx, &command),
        Cmd::Mcp => commands::mcp(&ctx),
    }
}
