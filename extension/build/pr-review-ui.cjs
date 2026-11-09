// One-off codemod: Files (with GitHub "viewed" marks) and Merge on each PR row.
const fs = require('fs');
const f = 'webview/src/components/PrList.tsx';
let s = fs.readFileSync(f, 'utf8');
const R = (a, b) => {
  if (!s.includes(a)) throw new Error('MISSING ' + a.slice(0, 90));
  s = s.replace(a, b);
};
R(`import { useState } from 'react';`, `import { useEffect, useState } from 'react';
import { post } from '@/bridge';`);
R(`import { Check, ChevronRight, `, `import { Check, ChevronRight, FileText, `);
R(
  `function PrRow({ url, label, st }: { url: string; label: string; st?: Status }) {
  const [open, setOpen] = useState(false);`,
  `type PrFile = { path: string; additions: number; deletions: number; viewed: boolean };
type FilesState = { id?: string; files: PrFile[]; error?: string; loading?: boolean };

/** The PR's changed files with your viewed marks, fetched from the extension when opened. */
function usePrFiles(url: string, open: boolean): [FilesState | undefined, (s: FilesState) => void] {
  const [state, setState] = useState<FilesState>();
  useEffect(() => {
    const on = (e: MessageEvent) => e.data?.type === 'prFilesResult' && e.data.url === url && setState({ id: e.data.id, files: e.data.files ?? [], error: e.data.error });
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [url]);
  useEffect(() => {
    if (!open) return;
    setState((s) => ({ ...(s ?? { files: [] }), loading: true }));
    post({ type: 'prFiles', url });
  }, [open, url]);
  return [state, setState];
}

function PrRow({ url, label, st }: { url: string; label: string; st?: Status }) {
  const [open, setOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [files, setFiles] = usePrFiles(url, filesOpen);
  const github = /github\\.com\\/[^/]+\\/[^/]+\\/pull\\/\\d+/.test(url);
  const canMerge = github && st?.state === 'open';`,
);
R(`      {(st?.tasks || S || st?.review) && (`, `      {(st?.tasks || S || st?.review || github) && (`);
R(
  `          {st?.review && (
            <span className="rounded px-1.5 font-medium" style={pill(REVIEW[st.review].color)}>
              {t(REVIEW[st.review].label)}
            </span>
          )}
        </div>
      )}`,
  `          {st?.review && (
            <span className="rounded px-1.5 font-medium" style={pill(REVIEW[st.review].color)}>
              {t(REVIEW[st.review].label)}
            </span>
          )}
          {github && (
            <span className="ml-auto inline-flex items-center gap-1">
              <button className="hover:bg-accent text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5" onClick={() => setFilesOpen(!filesOpen)} aria-expanded={filesOpen} data-pr-files>
                <FileText className="size-3" /> {t('Files')}
                {files && files.files.length > 0 && <span className="tabular-nums">{files.files.filter((x) => x.viewed).length}/{files.files.length}</span>}
              </button>
              {canMerge && (
                <button className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-medium text-white" style={{ background: '#8250df' }} onClick={() => post({ type: 'prMerge', url })} data-pr-merge>
                  <GitMerge className="size-3" /> {t('Merge')}
                </button>
              )}
            </span>
          )}
        </div>
      )}
      {filesOpen && (
        <div className="mb-1 ml-7 border-l pl-2 text-[11.5px]" aria-label={t('Files changed')}>
          {files?.loading && !files.files.length && <div className="text-muted-foreground py-1">{t('Loading…')}</div>}
          {files?.error && <div className="text-removed py-1">{files.error}</div>}
          {files && files.files.length > 0 && (
            <div className="text-muted-foreground flex items-center gap-2 py-0.5">
              <span>{t('{0} of {1} viewed', files.files.filter((x) => x.viewed).length, files.files.length)}</span>
              <span className="bg-muted h-1 flex-1 overflow-hidden rounded-full">
                <span className="block h-full" style={{ width: \`\${(files.files.filter((x) => x.viewed).length / files.files.length) * 100}%\`, background: '#8250df' }} />
              </span>
            </div>
          )}
          <ul className="flex flex-col">
            {files?.files.map((fl) => (
              <li key={fl.path} className="flex items-center gap-1.5 py-0.5" data-file={fl.path} data-viewed={fl.viewed}>
                <input
                  type="checkbox"
                  className="accent-[#8250df] cursor-pointer"
                  checked={fl.viewed}
                  title={t('Viewed')}
                  aria-label={t('Viewed')}
                  onChange={(e) => {
                    if (!files.id) return;
                    // show it at once; the extension confirms with GitHub and sends the list again
                    setFiles({ ...files, files: files.files.map((x) => (x.path === fl.path ? { ...x, viewed: e.target.checked } : x)) });
                    post({ type: 'prViewed', url, prId: files.id, path: fl.path, viewed: e.target.checked });
                  }}
                />
                <button className={cn('min-w-0 flex-1 cursor-pointer truncate text-left font-mono hover:underline', fl.viewed && 'text-muted-foreground')} title={fl.path} onClick={() => post({ type: 'prOpenFile', url, path: fl.path })}>
                  {fl.path}
                </button>
                <span className="text-added tabular-nums">+{fl.additions}</span>
                <span className="text-removed tabular-nums">−{fl.deletions}</span>
              </li>
            ))}
          </ul>
        </div>
      )}`,
);
fs.writeFileSync(f, s);
const i = 'webview/src/i18n.ts';
let t = fs.readFileSync(i, 'utf8');
t = t.replace(`  Context: 'Contexto',`, `  Context: 'Contexto',\n  Files: 'Arquivos',\n  Merge: 'Mesclar',\n  'Files changed': 'Arquivos alterados',\n  'Loading…': 'Carregando…',\n  '{0} of {1} viewed': '{0} de {1} vistos',\n  Viewed: 'Visto',`);
fs.writeFileSync(i, t);
console.log('ok');
