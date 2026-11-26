// Syntax highlighting for code blocks: highlight.js core with a few common languages (loaded on demand).
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const langs = { bash, c, cpp, csharp, css, diff, go, java, javascript, json, markdown, php, python, ruby, rust, shell, sql, typescript, xml, yaml };
for (const [name, def] of Object.entries(langs)) hljs.registerLanguage(name, def);
hljs.registerAliases(['tsx', 'mts', 'cts'], { languageName: 'typescript' });
hljs.registerAliases(['jsx', 'mjs', 'cjs'], { languageName: 'javascript' });
hljs.registerAliases(['html', 'svg', 'vue'], { languageName: 'xml' });
hljs.registerAliases(['jsonc', 'json5'], { languageName: 'json' });
hljs.registerAliases(['console', 'zsh', 'sh'], { languageName: 'bash' });

/** Highlighted HTML (highlight.js escapes the code), or undefined for languages not loaded. */
export function highlight(code: string, lang: string): string | undefined {
  if (!hljs.getLanguage(lang)) return undefined;
  return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
}
