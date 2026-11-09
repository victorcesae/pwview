// Follow in terminal: shows a command's output as it is written. A read-only terminal with no shell,
// because other extensions type into shells (the Python extension's "source .venv/bin/activate"
// would land in the middle of the output) and because there is nothing to run here.
import * as fs from 'fs';
import { StringDecoder } from 'string_decoder';
import * as vscode from 'vscode';

const TAIL_BYTES = 64 * 1024;
const POLL_MS = 400;
const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');

export function followPty(file: string, label: string): vscode.Pseudoterminal {
  const write = new vscode.EventEmitter<string>();
  const close = new vscode.EventEmitter<number | void>();
  let at = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let seen = false;
  let decoder = new StringDecoder('utf8');

  const read = () => {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      if (!seen) return;
      write.fire('\r\n\x1b[2m[The output file was removed: the command has finished.]\x1b[0m\r\n');
      clearInterval(timer);
      return;
    }
    if (!seen) {
      seen = true;
      at = Math.max(0, size - TAIL_BYTES);
      if (at) write.fire('\x1b[2m[…earlier output cut…]\x1b[0m\r\n');
    }
    if (size < at) {
      at = 0; // the file started over
      decoder = new StringDecoder('utf8');
    }
    if (size === at) return;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - at);
      const n = fs.readSync(fd, buf, 0, buf.length, at);
      at += n;
      write.fire(crlf(decoder.write(buf.subarray(0, n))));
    } finally {
      fs.closeSync(fd);
    }
  };

  return {
    onDidWrite: write.event,
    onDidClose: close.event,
    open() {
      if (label) write.fire(`\x1b[2m${crlf(label)}\x1b[0m\r\n\r\n`);
      read();
      timer = setInterval(read, POLL_MS);
    },
    close() {
      clearInterval(timer);
    },
    handleInput(data) {
      // read-only: only Ctrl+C does something, it closes this view (the command keeps running)
      if (data === '\x03') {
        clearInterval(timer);
        close.fire();
      }
    },
  };
}
