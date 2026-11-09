// Pull requests the agents opened: their links in tool output and answers, and their live status
// (open, draft, merged, closed). GitHub status comes from the gh CLI on the host the agent runs on
// (so it works over SSH and for private repos), else from GitHub's public API.
import { execFile } from 'child_process';
import { which } from './util';

export type PrState = 'open' | 'draft' | 'merged' | 'closed' | 'unknown';
export interface PrStatus {
  state: PrState;
  title?: string;
  /** when it was last checked (ms) */
  checked: number;
}

const PR_RE = /https:\/\/(?:github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|gitlab\.[\w.-]+\/[\w./-]+\/-\/merge_requests\/\d+|dev\.azure\.com\/[\w./-]+\/pullrequest\/\d+|bitbucket\.org\/[\w.-]+\/[\w.-]+\/pull-requests\/\d+)/g;

export const findPrUrls = (text: string): string[] => [...new Set(text.match(PR_RE) ?? [])];

/** gh's answer (state OPEN / CLOSED / MERGED, isDraft) or the REST API's (state open/closed, merged, draft). */
export function toPrState(x: { state?: string; isDraft?: boolean; draft?: boolean; merged?: boolean; merged_at?: string | null }): PrState {
  const s = (x.state ?? '').toLowerCase();
  if (s === 'merged' || x.merged || x.merged_at) return 'merged';
  if (s === 'closed') return 'closed';
  if (s === 'open') return x.isDraft || x.draft ? 'draft' : 'open';
  return 'unknown';
}

const gh = () => which('gh');

function viaGh(url: string): Promise<PrStatus | undefined> {
  const exe = gh();
  if (!exe) return Promise.resolve(undefined);
  return new Promise((resolve) =>
    execFile(exe, ['pr', 'view', url, '--json', 'state,isDraft,title'], { timeout: 15_000, windowsHide: true }, (err, out) => {
      if (err) return resolve(undefined);
      try {
        const j = JSON.parse(out);
        resolve({ state: toPrState(j), title: j.title, checked: Date.now() });
      } catch {
        resolve(undefined);
      }
    }),
  );
}

async function viaApi(url: string): Promise<PrStatus | undefined> {
  const m = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(url);
  if (!m) return undefined;
  try {
    const r = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/pulls/${m[3]}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agentlens' } });
    if (!r.ok) return undefined;
    const j: any = await r.json();
    return { state: toPrState(j), title: j.title, checked: Date.now() };
  } catch {
    return undefined;
  }
}

export async function prStatus(url: string): Promise<PrStatus> {
  if (/github\.com/.test(url)) return (await viaGh(url)) ?? (await viaApi(url)) ?? { state: 'unknown', checked: Date.now() };
  return { state: 'unknown', checked: Date.now() };
}

/** Keeps the status of every PR seen in open chats fresh: open ones every minute, finished ones every 10. */
export class PrTracker {
  private status = new Map<string, PrStatus>();
  private inFlight = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private onChange: () => void,
    private fetchStatus: (url: string) => Promise<PrStatus> = prStatus,
  ) {}

  get(url: string) {
    return this.status.get(url);
  }

  /** Start watching these links (new ones are checked right away). */
  track(urls: Iterable<string>) {
    for (const u of urls) if (!this.status.has(u)) this.check(u);
    this.timer ??= setInterval(() => this.tick(), 60_000);
  }

  private tick() {
    const now = Date.now();
    for (const [u, s] of this.status) {
      const final = s.state === 'merged' || s.state === 'closed';
      if (now - s.checked >= (final ? 600_000 : 55_000)) this.check(u);
    }
  }

  async check(url: string) {
    if (this.inFlight.has(url)) return;
    this.inFlight.add(url);
    if (!this.status.has(url)) this.status.set(url, { state: 'unknown', checked: 0 });
    try {
      const next = await this.fetchStatus(url);
      const prev = this.status.get(url);
      this.status.set(url, next);
      if (prev?.state !== next.state || prev?.title !== next.title) this.onChange();
    } finally {
      this.inFlight.delete(url);
    }
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
  }
}
