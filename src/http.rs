//! Tiny HTTP GET for the browser's local DevTools endpoints (no extra dependencies).
use anyhow::{bail, Result};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

pub fn get(port: u16, path: &str) -> Result<String> {
    let t = Duration::from_secs(2);
    let mut s = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), t)?;
    s.set_read_timeout(Some(t))?;
    // Chrome's DevTools server only speaks HTTP/1.1 and may keep the socket open,
    // so read the headers, then exactly Content-Length bytes.
    write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let header_end = loop {
        let n = s.read(&mut chunk)?;
        if n == 0 {
            bail!("connection closed before headers");
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let status = head.split_whitespace().nth(1).unwrap_or("");
    if status != "200" {
        bail!("GET {path} -> HTTP {status}");
    }
    let len = head
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case("content-length").then(|| v.trim().parse::<usize>().ok())?
        });
    let mut body = buf[header_end..].to_vec();
    match len {
        Some(len) => {
            while body.len() < len {
                let n = s.read(&mut chunk)?;
                if n == 0 {
                    break;
                }
                body.extend_from_slice(&chunk[..n]);
            }
            body.truncate(len);
        }
        None => {
            let _ = s.read_to_end(&mut body);
        }
    }
    Ok(String::from_utf8_lossy(&body).to_string())
}

pub fn get_json(port: u16, path: &str) -> Result<serde_json::Value> {
    Ok(serde_json::from_str(&get(port, path)?)?)
}
