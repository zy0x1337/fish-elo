// Rasterises the brand SVGs into the PNG assets the PWA manifest needs.
// Run with: node tools/render.mjs   (Chromium comes from PLAYWRIGHT_BROWSERS_PATH)
// Playwright is a dev-only dependency; resolve it from wherever it is installed.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const jobs = JSON.parse(process.argv[2] || '[]');

const browser = await chromium.launch();
for (const job of jobs) {
  const svg = readFileSync(resolve(root, job.src), 'utf8');
  const page = await browser.newPage({
    viewport: { width: job.w, height: job.h },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${job.w}px;height:${job.h}px}</style>${svg}`,
    { waitUntil: 'load' },
  );
  const buf = await page.screenshot({ omitBackground: !!job.transparent, type: 'png' });
  writeFileSync(resolve(root, job.out), buf);
  await page.close();
  console.log(`${job.out}  ${job.w}x${job.h}`);
}
await browser.close();
