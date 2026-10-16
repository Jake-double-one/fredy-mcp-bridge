// Erzeugt LICENSE.txt: eigene Lizenz, Hinweis zu Fredy und alle Lizenzen der Laufzeit-Abhängigkeiten.
// Aufruf nach Paket-Updates: npm run licenses
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dirs = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8' })
  .trim()
  .split('\n')
  .slice(1);

const packages = new Map();
for (const dir of dirs) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const license =
    typeof pkg.license === 'string' ? pkg.license : pkg.license?.type || (pkg.licenses || []).map((l) => l.type).join(' OR ') || 'UNKNOWN';
  const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f));
  let copyright = '';
  if (file) {
    const match = fs
      .readFileSync(path.join(dir, file), 'utf8')
      .match(/^\s*copyright\s+(?:\(c\)|©)?\s*(?:\d{4}|\w).*$/im);
    if (match) copyright = match[0].trim();
  }
  packages.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, license, copyright, url: pkg.repository?.url || pkg.homepage || '' });
}
const list = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));

const MIT = `MIT License

Copyright (c) 2026 Jake-double-one

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const FREDY = `Fredy MCP Bridge is an unofficial, independent add-on for "Fredy", the
real-estate search tool by Christian Kellner (https://github.com/orangecoding/fredy).
It is not affiliated with, endorsed by or supported by the Fredy project.

The bridge contains no source code from Fredy. It talks to a separately running,
unmodified Fredy instance only over Fredy's HTTP interfaces. Fredy itself is
licensed under "Apache-2.0 with Commons Clause and Attribution/Naming Clause"
(Copyright (c) 2026 Christian Kellner); that license applies to Fredy, not to
this bridge. The name "Fredy" is used only to describe what the bridge connects
to; all credit for Fredy goes to its author(s).`;

const counts = list.reduce((acc, p) => ((acc[p.license] = (acc[p.license] || 0) + 1), acc), {});
const rows = list
  .map((p) => `${`${p.name}@${p.version}`.padEnd(48)} ${p.license.padEnd(14)} ${p.copyright}`.trimEnd())
  .join('\n');

const text = `Fredy MCP Bridge – Lizenzen / Licenses
${'='.repeat(38)}

1. Lizenz dieses Projekts / License of this project
---------------------------------------------------

${MIT}


2. Hinweis zu Fredy / Note on Fredy
-----------------------------------

${FREDY}


3. Drittanbieter-Software / Third-party software
------------------------------------------------

The bridge (and its Docker image) ships the following npm packages at runtime.
Each package keeps its full license text in node_modules/<package>/LICENSE*.
Summary: ${Object.entries(counts)
  .sort()
  .map(([l, n]) => `${n}× ${l}`)
  .join(', ')}.

${'Package'.padEnd(48)} ${'License'.padEnd(14)} Copyright
${'-'.repeat(48)} ${'-'.repeat(14)} ---------
${rows}

The Docker image is based on the official "node:22-bookworm-slim" image, which
contains Node.js (MIT, https://github.com/nodejs/node/blob/main/LICENSE) and
Debian GNU/Linux packages under their respective licenses
(see /usr/share/doc/*/copyright inside the image).
`;

fs.writeFileSync(path.join(root, 'LICENSE.txt'), text);
console.log(`LICENSE.txt geschrieben (${list.length} Pakete).`);
