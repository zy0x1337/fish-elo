// Renders small square thumbnails for the rankings/daily tables and the favourites list,
// so those views stop pulling full-size photos to draw a 40px image. Dependency-free:
// Chromium decodes each committed photo, draws it cover-cropped onto a canvas, and hands
// back a JPEG. Output lands in frontend/images/thumbs/<id>.jpg and is committed.
//
// Run: node tools/thumbs.mjs   (Chromium comes from PLAYWRIGHT_MODULE / PLAYWRIGHT_BROWSERS_PATH)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 96;                 // 2x the largest on-screen thumbnail (48px)
const QUALITY = 0.82;

const catalog = JSON.parse(readFileSync(resolve(root, 'backend/data/fish.json'), 'utf8')).fish;
const outDir = resolve(root, 'frontend/images/thumbs');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');

let done = 0;
for (const fish of catalog) {
    const rel = (fish.image || '').replace(/^\//, '');           // "images/neon-tetra.jpg"
    const src = resolve(root, 'frontend', rel);
    if (!rel || !existsSync(src)) { console.warn(`skip ${fish.id}: no source`); continue; }

    const mime = MIME[extname(src).toLowerCase()] || 'image/jpeg';
    const dataUrl = `data:${mime};base64,${readFileSync(src).toString('base64')}`;

    const jpeg = await page.evaluate(async ({ dataUrl, size, quality }) => {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        const scale = Math.max(size / img.width, size / img.height);   // cover
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        return canvas.toDataURL('image/jpeg', quality);
    }, { dataUrl, size: SIZE, quality: QUALITY });

    writeFileSync(resolve(outDir, `${fish.id}.jpg`), Buffer.from(jpeg.split(',')[1], 'base64'));
    done += 1;
}

await browser.close();
console.log(`wrote ${done} thumbnails to frontend/images/thumbs/`);
