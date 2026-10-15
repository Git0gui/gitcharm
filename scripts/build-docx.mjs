import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Turn the CSDN article into a self-contained .docx with the images embedded.
 *
 * Markdown -> Word is deliberately hand-rolled: the article only uses a small
 * block vocabulary, and this way the typography (East Asian font, table
 * borders, caption colour) is decided here instead of by a generic converter.
 *
 * sharp and docx are NOT dependencies of the extension. Install them in a
 * scratch folder and point NODE_PATH at their node_modules:
 *   npm i sharp docx --registry=https://registry.npmmirror.com
 *   NODE_PATH=<scratch>/node_modules node scripts/build-docx.mjs
 */

const require = createRequire(import.meta.url);
let sharp;
let docx;
try {
    sharp = require('sharp');
    docx = require('docx');
} catch (e) {
    console.error('missing tooling: ' + e.message);
    console.error('run: npm i sharp docx --registry=https://registry.npmmirror.com   (then set NODE_PATH to its node_modules)');
    process.exit(1);
}

const {
    Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel,
    Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType, ShadingType, VerticalAlign
} = docx;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const docsDir = path.join(root, 'docs');
const source = path.join(docsDir, 'CSDN-GitCharm使用说明.md');
const target = path.join(docsDir, 'GitCharm-CSDN使用说明.docx');

/** Word shows the article at roughly 6.5in wide; 2800px shots are 4x that. */
const IMAGE_MAX_WIDTH = 1400;
const PAGE_CONTENT_PX = 620;

const CN_FONT = 'Microsoft YaHei';
const CODE_FONT = 'Consolas';

/** Inline palette: body text is near-black, code and captions are muted. */
const INK = '1A1A1A';
const CODE_INK = '9A3A5B';
const MUTED = '777777';

const imageCache = new Map();

/** Downscale + quantise on the fly; the committed PNGs are sized for screens. */
async function loadImage(rel) {
    if (imageCache.has(rel)) return imageCache.get(rel);
    const file = path.join(docsDir, rel);
    if (!statSync(file).isFile()) throw new Error('image not found: ' + file);
    const meta = await sharp(file).metadata();
    const scale = Math.min(1, IMAGE_MAX_WIDTH / meta.width);
    const width = Math.round(meta.width * scale);
    const height = Math.round(meta.height * scale);
    const buffer = await sharp(file)
        .resize({ width })
        .png({ palette: true, quality: 82, effort: 10, colours: 128 })
        .toBuffer();
    const shown = {
        buffer,
        width: PAGE_CONTENT_PX,
        height: Math.round(PAGE_CONTENT_PX * (meta.height / meta.width))
    };
    imageCache.set(rel, shown);
    return shown;
}

const TOKEN = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/;

/** Markdown inline spans -> Word runs. */
function inline(text, extra = {}) {
    const runs = [];
    let rest = text;
    while (rest.length) {
        const m = TOKEN.exec(rest);
        if (!m) {
            runs.push(new TextRun({ text: rest, ...extra }));
            break;
        }
        if (m.index) runs.push(new TextRun({ text: rest.slice(0, m.index), ...extra }));
        const token = m[0];
        if (token.startsWith('`')) {
            runs.push(new TextRun({ text: token.slice(1, -1), font: CODE_FONT, color: CODE_INK, ...extra }));
        } else if (token.startsWith('**')) {
            // Recurse: the article writes **bold with `code` inside**, and the
            // inner span has to keep its monospace face instead of backticks.
            runs.push(...inline(token.slice(2, -2), { ...extra, bold: true }));
        } else if (token.startsWith('*')) {
            runs.push(...inline(token.slice(1, -1), { ...extra, italics: true }));
        } else {
            const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
            runs.push(...inline(link[1], { ...extra, color: '2B5A8C', underline: {} }));
        }
        rest = rest.slice(m.index + token.length);
    }
    return runs;
}

function body(text, opts = {}) {
    return new Paragraph({ children: inline(text), spacing: { after: 140, line: 300 }, ...opts });
}

function codeBlock(lines) {
    return lines.map((line, i) => new Paragraph({
        children: [new TextRun({ text: line.length ? line : ' ', font: CODE_FONT, size: 18, color: '3B4A5A' })],
        shading: { type: ShadingType.CLEAR, fill: 'F4F5F7' },
        spacing: { after: i === lines.length - 1 ? 160 : 0, line: 240 },
        indent: { left: 160, right: 160 }
    }));
}

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };

function dataTable(rows) {
    const cells = rows.map((cells_, ri) => new TableRow({
        tableHeader: ri === 0,
        children: cells_.map(text => new TableCell({
            verticalAlign: VerticalAlign.CENTER,
            shading: ri === 0 ? { type: ShadingType.CLEAR, fill: 'EDEFF2' } : undefined,
            margins: { top: 60, bottom: 60, left: 110, right: 110 },
            children: [new Paragraph({
                children: inline(text, ri === 0 ? { bold: true } : {}),
                spacing: { after: 0, line: 260 }
            })]
        }))
    }));
    return new Table({
        rows: cells,
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
            top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER, insideHorizontal: NO_BORDER,
            insideVertical: { style: BorderStyle.SINGLE, size: 2, color: 'D8DCE2' }
        }
    });
}

function splitRow(line) {
    return line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
}

async function build(md) {
    const lines = md.split(/\r?\n/);
    const children = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        if (!line.trim()) { i++; continue; }

        if (/^```/.test(line)) {
            const buf = [];
            i++;
            while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
            i++;
            children.push(...codeBlock(buf));
            continue;
        }

        if (/^---\s*$/.test(line)) {
            children.push(new Paragraph({
                children: [], spacing: { after: 200 },
                border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D8DCE2', space: 1 } }
            }));
            i++;
            continue;
        }

        const img = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
        if (img) {
            const shot = await loadImage(img[2]);
            children.push(new Paragraph({
                children: [new ImageRun({ type: 'png', data: shot.buffer, transformation: { width: shot.width, height: shot.height } })],
                spacing: { before: 120, after: 60 },
                alignment: AlignmentType.CENTER
            }));
            i++;
            continue;
        }

        const caption = /^\*([^*].*[^*])\*\s*$/.exec(line);
        if (caption) {
            children.push(new Paragraph({
                children: inline(caption[1], { italics: true, color: MUTED, size: 18 }),
                spacing: { after: 200 },
                alignment: AlignmentType.CENTER
            }));
            i++;
            continue;
        }

        if (line.startsWith('|')) {
            const rows = [];
            while (i < lines.length && lines[i].startsWith('|')) {
                const cells = splitRow(lines[i]);
                if (!/^[:|-]+$/.test(cells.join(''))) rows.push(cells);
                i++;
            }
            children.push(dataTable(rows));
            children.push(new Paragraph({ children: [], spacing: { after: 160 } }));
            continue;
        }

        if (/^>\s?/.test(line)) {
            const buf = [];
            while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
            children.push(new Paragraph({
                children: inline(buf.join(' '), { color: '44506A' }),
                spacing: { after: 160, line: 300 },
                indent: { left: 260 },
                border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'C9D2E0', space: 12 } }
            }));
            continue;
        }

        const heading = /^(#{1,4})\s+(.*)$/.exec(line);
        if (heading) {
            const level = heading[1].length;
            const map = { 1: HeadingLevel.TITLE, 2: HeadingLevel.HEADING_1, 3: HeadingLevel.HEADING_2, 4: HeadingLevel.HEADING_3 };
            children.push(new Paragraph({
                children: inline(heading[2]),
                heading: map[level],
                pageBreakBefore: level === 2 && children.length > 3,
                spacing: { before: level === 1 ? 0 : 200, after: 120 }
            }));
            i++;
            continue;
        }

        const bullet = /^[-*]\s+(.*)$/.exec(line);
        const numbered = /^\d+\.\s+(.*)$/.exec(line);
        if (bullet || numbered) {
            children.push(new Paragraph({
                children: inline((bullet || numbered)[1]),
                bullet: bullet ? { level: 0 } : undefined,
                numbering: numbered ? { reference: 'article-steps', level: 0 } : undefined,
                spacing: { after: 80, line: 300 }
            }));
            i++;
            continue;
        }

        children.push(body(line));
        i++;
    }
    return children;
}

const md = readFileSync(source, 'utf8');
const children = await build(md);

const doc = new Document({
    creator: 'GitCharm',
    title: '把 IntelliJ IDEA 的 Git 界面搬进 VSCode：GitCharm 使用说明',
    description: '由 docs/CSDN-GitCharm使用说明.md 生成，图片已内嵌。',
    numbering: {
        config: [{
            reference: 'article-steps',
            levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 460, hanging: 260 } } } }]
        }]
    },
    styles: {
        default: {
            document: { run: { font: CN_FONT, size: 21, color: INK }, paragraph: { spacing: { line: 300 } } },
            title: { run: { font: CN_FONT, size: 40, bold: true, color: '10243F' } },
            heading1: { run: { font: CN_FONT, size: 30, bold: true, color: '10243F' } },
            heading2: { run: { font: CN_FONT, size: 25, bold: true, color: '2B5A8C' } },
            heading3: { run: { font: CN_FONT, size: 22, bold: true, color: '3B4A5A' } }
        }
    },
    sections: [{
        properties: { page: { margin: { top: 1134, bottom: 1134, left: 1247, right: 1247 } } },
        children
    }]
});

mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, await Packer.toBuffer(doc));
console.log(`${path.relative(root, target)}  ${(statSync(target).size / 1024 / 1024).toFixed(2)} MB  ${children.length} blocks  ${imageCache.size} images embedded`);
