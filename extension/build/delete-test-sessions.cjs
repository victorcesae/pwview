// Delete the session folders that Steerhouse' own end-to-end tests left in ~/.claude/projects.
// Only folders whose name ends in "-steerhouse-e2e-XXXXXX" or "-steerhouse-steer-XXXXXX".
const fs = require('fs');
const os = require('os');
const path = require('path');

const projects = path.join(os.homedir(), '.claude', 'projects');
const targets = fs
  .readdirSync(projects, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /-steerhouse-(e2e|steer)-[A-Za-z0-9]{6}$/.test(d.name))
  .map((d) => path.join(projects, d.name));

console.log(`${targets.length} test session folder(s):`);
for (const t of targets) console.log('  ' + path.basename(t));
if (process.argv[2] === '--delete') {
  for (const t of targets) fs.rmSync(t, { recursive: true, force: true });
  const left = targets.filter((t) => fs.existsSync(t)).length;
  console.log(`deleted ${targets.length - left}, left ${left}`);
}
