import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Render the standalone preview to PNG with headless Chrome/Edge.
 * Usage: node docs/preview/shot.mjs [scene...]
 */

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(dir, 'out');
mkdirSync(out, { recursive: true });

const browsers = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
];
const browser = browsers.find((b) => spawnSync(b, ['--version']).status === 0);
if (!browser) throw new Error('no Chrome/Edge found');

const scenes = process.argv.slice(2);
const list = scenes.length ? scenes : ['main', 'conflict', 'multiRepo'];

for (const scene of list) {
    const args = [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=2',
        '--window-size=1400,780',
        '--virtual-time-budget=4000',
        `--screenshot=${path.join(out, `${scene}.png`)}`,
        `file:///${dir.replace(/\\/g, '/')}/preview.html?scene=${scene}`
    ];
    const r = spawnSync(browser, args, { encoding: 'utf8' });
    const ok = r.status === 0 && /bytes written/.test(r.stderr + r.stdout);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${scene}.png`);
    if (!ok) console.log((r.stderr || r.stdout).split('\n').filter(l => /error|failed/i.test(l)).slice(0, 3).join('\n'));
}

/**
 * Chrome writes 32-bit PNGs (~500KB each); these shots are committed to git, so
 * quantise them to a palette. sharp is deliberately NOT a dependency of the
 * extension — install it in a scratch folder and point NODE_PATH at its
 * node_modules (require() honours NODE_PATH, dynamic import() does not).
 */
try {
    const sharp = createRequire(import.meta.url)('sharp');
    for (const scene of list) {
        const p = path.join(out, `${scene}.png`);
        const before = statSync(p).size;
        const tmp = p + '.quantised';
        await sharp(p).png({ palette: true, quality: 80, effort: 10, colours: 128 }).toFile(tmp);
        renameSync(tmp, p);
        console.log(`   ${scene}.png ${(before / 1024) | 0}KB -> ${(statSync(p).size / 1024) | 0}KB`);
    }
} catch {
    console.log('skip quantising (sharp not resolvable; npm i sharp in a scratch dir and set NODE_PATH)');
}
