// One-off codemod: "Cursor + Claude" marks in the chat header and vendor marks in the session list.
const fs = require('fs');
const R = (f, a, b) => {
  const s = fs.readFileSync(f, 'utf8');
  if (!s.includes(a)) {
    console.error('MISSING ' + f + ': ' + a.slice(0, 80));
    process.exit(1);
  }
  fs.writeFileSync(f, s.split(a).join(b));
};
const C = 'webview/src/views/Chat.tsx';
R(C, "import { Composer, PRIORITY } from './Composer';", "import { Composer, PRIORITY } from './Composer';\nimport { HostMark, hostName, VendorMark, vendorName, vendorOf } from '@/components/VendorMark';");
R(
  C,
  '        <h1 className="min-w-0 flex-1 truncate text-[14px] font-semibold">{chat.title}</h1>',
  `        <span className="inline-flex items-center gap-0.5" title={\`\${hostName(chat.host)}\${chat.host ? ' + ' : ''}\${vendorName(vendorOf(chat.model))}\${chat.model ? ' · ' + chat.model : ''}\`}>
          <HostMark host={chat.host} />
          {chat.host && <span className="text-muted-foreground text-[10px]">+</span>}
          <VendorMark vendor={vendorOf(chat.model)} />
        </span>
        <h1 className="min-w-0 flex-1 truncate text-[14px] font-semibold">{chat.title}</h1>`,
);
const O = 'webview/src/views/Overview.tsx';
R(O, "import { GraphView } from './Graph';", "import { GraphView } from './Graph';\nimport { VendorMark, vendorOf } from '@/components/VendorMark';");
R(O, '      <StateDot state={s.state} />\n      <div className="min-w-0 flex-1">', '      <StateDot state={s.state} />\n      <VendorMark vendor={vendorOf(s.model)} title={s.model} />\n      <div className="min-w-0 flex-1">');
console.log('ok');
