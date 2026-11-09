// Your sessions on your phone (or any browser): a small web page served by AgentLens, protected by a
// secret key in the link. It lists sessions, shows each conversation as it happens, and sends
// Steer / Queue / Send now. Runs on the machine where the agents run (the SSH host when remote).
import * as crypto from 'crypto';
import * as http from 'http';
import * as os from 'os';
import type { Session } from './engine';

export type SendMode = 'steer' | 'queue' | 'now';

export interface RemoteDeps {
  sessions: () => Session[];
  send: (id: string, text: string, mode: SendMode) => Promise<string>;
}

/** Constant-time comparison of the secret key. */
export function sameKey(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** The key from the Authorization header, the "al" cookie, or ?k= on the first visit. */
export function keyFrom(req: { headers: http.IncomingHttpHeaders; url?: string }): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const cookie = /(?:^|;\s*)al=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1];
  if (cookie) return cookie;
  return new URL(req.url ?? '/', 'http://x').searchParams.get('k') ?? undefined;
}

export function sessionList(sessions: Session[]) {
  return sessions
    .map((s) => ({
      id: s.info.id,
      title: s.info.title,
      project: s.info.project.replace(/\\/g, '/').split('/').pop(),
      state: s.info.state,
      updated: s.info.updated,
      model: s.info.model,
      last: s.t.events.at(-1)?.text?.slice(0, 160),
    }))
    .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
}

export function sessionDetail(s: Session, limit = 200) {
  return {
    id: s.info.id,
    title: s.info.title,
    project: s.info.project,
    state: s.info.state,
    model: s.info.model,
    branch: s.info.branch,
    events: s.t.events.filter((e) => !e.agentId).slice(-limit).map((e) => ({ ts: e.ts, kind: e.kind, text: e.text.slice(0, 4000), tool: e.tool, midTurn: e.midTurn })),
  };
}

/** A LAN address other devices can reach (first non-internal IPv4). */
export function lanAddress(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return undefined;
}

export class RemoteServer {
  private server?: http.Server;
  readonly key = crypto.randomBytes(24).toString('base64url');
  port = 0;
  host = '127.0.0.1';

  constructor(private deps: RemoteDeps) {}

  get running() {
    return !!this.server;
  }

  async start(host: '127.0.0.1' | '0.0.0.0', port = 0): Promise<number> {
    await this.stop();
    this.host = host;
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => this.json(res, 500, { error: String(e?.message ?? e) })));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => resolve());
    });
    this.port = (this.server.address() as { port: number }).port;
    return this.port;
  }

  async stop() {
    const s = this.server;
    this.server = undefined;
    if (!s) return;
    // a phone that keeps polling holds keep-alive connections open: close them too, or Stop hangs
    const closed = new Promise<void>((r) => s.close(() => r()));
    s.closeAllConnections?.();
    await closed;
  }

  private json(res: http.ServerResponse, code: number, body: unknown) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const key = keyFrom(req);
    if (!key || !sameKey(key, this.key)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('AgentLens: open the link with its key (run "AgentLens: Open on Phone" again to get it).');
    }
    // the key moves from the link into a cookie, so it is not left in the address bar
    if (url.searchParams.has('k')) {
      res.writeHead(302, { 'Set-Cookie': `al=${this.key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`, Location: '/' });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
      });
      return res.end(PAGE);
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') return this.json(res, 200, sessionList(this.deps.sessions()));
    const m = /^\/api\/sessions\/([\w-]+)(\/message)?$/.exec(url.pathname);
    const s = m && this.deps.sessions().find((x) => x.info.id === m[1]);
    if (m && !s) return this.json(res, 404, { error: 'no such session' });
    if (req.method === 'GET' && m && !m[2]) return this.json(res, 200, sessionDetail(s!));
    if (req.method === 'POST' && m && m[2]) {
      const body = await readBody(req, 64 * 1024);
      const { text, mode } = JSON.parse(body || '{}');
      if (typeof text !== 'string' || !text.trim()) return this.json(res, 400, { error: 'empty message' });
      const how: SendMode = mode === 'now' || mode === 'queue' ? mode : 'steer';
      const result = await this.deps.send(s!.info.id, text, how);
      return this.json(res, 200, { result });
    }
    this.json(res, 404, { error: 'not found' });
  }
}

function readBody(req: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > max) return reject(new Error('message too large')), req.destroy();
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// The page: plain HTML/JS, phone first, light and dark.
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>AgentLens</title>
<style>
:root{--bg:#fff;--fg:#18181b;--mut:#71717a;--card:#f4f4f5;--bd:#e4e4e7;--acc:#2563eb;--ok:#16a34a;--warn:#d97706}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0d;--fg:#f4f4f5;--mut:#a1a1aa;--card:#18181b;--bd:#27272a;--acc:#60a5fa;--ok:#4ade80;--warn:#fbbf24}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--bd);padding:12px 16px;display:flex;gap:10px;align-items:center;z-index:2}
header h1{font-size:16px;margin:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button{font:inherit;border:1px solid var(--bd);background:var(--card);color:var(--fg);border-radius:10px;padding:8px 12px}
main{padding:12px 16px 120px}
.s{display:block;width:100%;text-align:left;margin:0 0 8px;padding:12px;border-radius:12px}
.s b{display:block;font-weight:600}.s small{color:var(--mut);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:var(--mut)}.dot.working{background:var(--acc)}.dot.recent{background:var(--ok)}
.e{margin:8px 0;white-space:pre-wrap;word-wrap:break-word}.e.prompt{background:var(--card);border-radius:14px;padding:8px 12px;margin-left:15%}
.e.tool,.e.change{color:var(--mut);font-size:13px}.e.mid{border-left:3px solid var(--warn)}
form{position:fixed;left:0;right:0;bottom:0;background:var(--bg);border-top:1px solid var(--bd);padding:10px 12px calc(10px + env(safe-area-inset-bottom));display:flex;gap:8px;align-items:flex-end}
textarea{flex:1;font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:9px 11px;resize:none;max-height:40vh}
select{font:inherit;background:var(--card);color:var(--fg);border:1px solid var(--bd);border-radius:10px;padding:8px}
.send{background:var(--acc);color:#fff;border-color:var(--acc)}.hidden{display:none}.note{color:var(--mut);font-size:13px}
</style></head><body>
<header><button id="back" class="hidden" aria-label="All sessions">‹</button><h1 id="title">AgentLens</h1><span id="st" class="note"></span></header>
<main id="main"><p class="note">Loading…</p></main>
<form id="f" class="hidden"><textarea id="t" rows="1" placeholder="Message the agent…"></textarea>
<select id="mode" aria-label="Delivery"><option value="steer">Steer</option><option value="queue">Queue</option><option value="now">Send now</option></select>
<button class="send" type="submit">Send</button></form>
<script>
const $=id=>document.getElementById(id);let cur=null,timer=null,lastLen=-1;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ago=t=>{if(!t)return'';const m=Math.round((Date.now()-new Date(t))/60000);return m<1?'now':m<60?m+'m':m<1440?Math.round(m/60)+'h':Math.round(m/1440)+'d'};
async function api(p,o){const r=await fetch(p,Object.assign({credentials:'same-origin',headers:{'Content-Type':'application/json'}},o));if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||r.status);return r.json()}
async function list(){cur=null;lastLen=-1;$('back').classList.add('hidden');$('f').classList.add('hidden');$('title').textContent='AgentLens';$('st').textContent='';
 const ss=await api('/api/sessions');$('main').innerHTML=ss.length?ss.map(s=>'<button class="s" data-id="'+esc(s.id)+'"><b><span class="dot '+esc(s.state)+'"></span>'+esc(s.title)+'</b><small>'+esc(s.project)+' · '+ago(s.updated)+(s.last?' · '+esc(s.last):'')+'</small></button>').join(''):'<p class="note">No sessions yet.</p>';
 for(const b of document.querySelectorAll('.s'))b.onclick=()=>open(b.dataset.id)}
async function open(id){cur=id;lastLen=-1;$('back').classList.remove('hidden');$('f').classList.remove('hidden');await refresh(true)}
async function refresh(scroll){if(!cur)return list();const d=await api('/api/sessions/'+encodeURIComponent(cur));$('title').textContent=d.title;$('st').textContent=d.state==='working'?'working…':'';
 if(d.events.length===lastLen)return;const atEnd=innerHeight+scrollY>=document.body.scrollHeight-80;lastLen=d.events.length;
 $('main').innerHTML=d.events.map(e=>'<div class="e '+esc(e.kind)+(e.midTurn?' mid':'')+'">'+(e.kind==='tool'?'⚙ ':e.kind==='change'?'✎ ':'')+esc(e.text)+'</div>').join('')||'<p class="note">Nothing yet.</p>';
 if(scroll||atEnd)scrollTo(0,document.body.scrollHeight)}
$('back').onclick=()=>list();
$('f').onsubmit=async e=>{e.preventDefault();const text=$('t').value.trim();if(!text||!cur)return;$('t').value='';try{const r=await api('/api/sessions/'+encodeURIComponent(cur)+'/message',{method:'POST',body:JSON.stringify({text,mode:$('mode').value})});$('st').textContent=r.result}catch(x){$('st').textContent='Not sent: '+x.message;$('t').value=text}};
$('t').oninput=()=>{$('t').style.height='auto';$('t').style.height=$('t').scrollHeight+'px'};
const tick=()=>(cur?refresh(false):list()).catch(()=>{}).finally(()=>timer=setTimeout(tick,3000));tick();
</script></body></html>`;
