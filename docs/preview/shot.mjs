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
 * Two post-processing passes. sharp is deliberately NOT a dependency of the
 * extension — install it in a scratch folder and point NODE_PATH at its
 * node_modules (require() honours NODE_PATH, dynamic import() does not).
 *
 * - cropToContent: the panel paints its background all the way down the 780px
 *   viewport even when the commit list ends halfway, so half of every shot is
 *   empty dark space. Cut at the last row that actually holds pixels.
 * - quantise: Chrome writes 32-bit PNGs (~500KB each) and these are committed.
 */
try {
    const sharp = createRequire(import.meta.url)('sharp');

    const contentBottom = (buf, width, height) => {
        const stride = width * 4;
        const differs = (a, b) => Math.abs(buf[a] - buf[b]) + Math.abs(buf[a + 1] - buf[b + 1]) + Math.abs(buf[a + 2] - buf[b + 2]) > 6;
        for (let y = height - 1; y >= 0; y--) {
            const base = y * stride;
            for (let x = stride - 4; x >= 0; x -= 4) {
                if (differs(base, base + x)) return y;
            }
        }
        return height - 1;
    };

    for (const scene of list) {
        const p = path.join(out, `${scene}.png`);
        const before = statSync(p).size;
        const img = sharp(p);
        const { width, height } = await img.metadata();
        const raw = await img.raw().toBuffer();
        const bottom = contentBottom(raw, width, height);
        const keep = Math.min(height, bottom + 24);
        const tmp = p + '.processed';
        await sharp(p).extract({ left: 0, top: 0, width, height: keep })
            .png({ palette: true, quality: 80, effort: 10, colours: 128 }).toFile(tmp);
        renameSync(tmp, p);
        console.log(`   ${scene}.png ${width}x${height} ${(before / 1024) | 0}KB -> ${width}x${keep} ${(statSync(p).size / 1024) | 0}KB`);
    }
} catch {
    console.log('skip post-processing (sharp not resolvable; npm i sharp in a scratch dir and set NODE_PATH)');
}
