// One-off codemod: the answer avatar is the model's mark (+ editor badge), not a generic robot.
const fs = require('fs');
const f = 'webview/src/views/Chat.tsx';
let s = fs.readFileSync(f, 'utf8');
const R = (a, b) => {
  if (!s.includes(a)) {
    console.error('MISSING: ' + a.slice(0, 80));
    process.exit(1);
  }
  s = s.split(a).join(b);
};
R(
  `          <div className="bg-primary text-primary-foreground mt-0.5 grid size-5 shrink-0 place-items-center rounded-md">
            <Bot className="size-3" />
          </div>`,
  '          <AgentAvatar />',
);
R(
  '// ---------------------------------------------------------------- page',
  `/** Which model and editor this chat runs on, for the answer avatars. */
const AgentCtx = createContext<{ model?: string; host?: string }>({});

/** The model's mark (Claude, GPT, Llama…) with a small editor badge (Cursor, VS Code…). */
function AgentAvatar() {
  const { model, host } = useContext(AgentCtx);
  const vendor = vendorOf(model);
  return (
    <span className="relative mt-0.5 inline-flex shrink-0" title={\`\${vendorName(vendor)}\${model ? ' · ' + model : ''}\${host ? ' · ' + hostName(host) : ''}\`}>
      <VendorMark vendor={vendor} className="size-5 rounded-md text-[9px]" />
      {host && <HostMark host={host} className="ring-background absolute -right-1.5 -bottom-1 size-3 rounded-[3px] text-[5px] ring-2" />}
    </span>
  );
}

// ---------------------------------------------------------------- page`,
);
R('    <LightboxProvider>\n    <div className="flex h-screen flex-col">', '    <LightboxProvider>\n    <AgentCtx.Provider value={{ model: chat.model, host: chat.host }}>\n    <div className="flex h-screen flex-col">');
{
  const i = s.lastIndexOf('    </div>\n    </LightboxProvider>');
  if (i < 0) {
    console.error('MISSING provider end');
    process.exit(1);
  }
  s = s.slice(0, i) + '    </div>\n    </AgentCtx.Provider>\n    </LightboxProvider>' + s.slice(i + '    </div>\n    </LightboxProvider>'.length);
}
R("import { useEffect, useMemo, useRef, useState } from 'react';", "import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';");
fs.writeFileSync(f, s);
console.log('ok');
