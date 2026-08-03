// Dev helper: screenshots of the running app for eyeballing the layout.
// Usage: node tools/shots.mjs http://127.0.0.1:8123 /tmp/out
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const base = process.argv[2] || 'http://127.0.0.1:8123';
const out = process.argv[3] || '/tmp';
const shots = [
  { name: 'desktop-vote', w: 1280, h: 900, hash: '', scheme: 'light' },
  { name: 'desktop-vote-dark', w: 1280, h: 900, hash: '', scheme: 'dark' },
  { name: 'desktop-rankings', w: 1280, h: 1000, hash: '#rankings', scheme: 'light' },
  { name: 'desktop-daily', w: 1280, h: 1000, hash: '#daily', scheme: 'dark' },
  { name: 'desktop-you', w: 1280, h: 900, hash: '#you', scheme: 'light' },
  { name: 'mobile-vote', w: 390, h: 844, hash: '', scheme: 'light' },
];

const browser = await chromium.launch();
for (const s of shots) {
  const page = await browser.newPage({
    viewport: { width: s.w, height: s.h },
    colorScheme: s.scheme,
    deviceScaleFactor: 2,
  });
  await page.goto(base + '/' + s.hash, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/${s.name}.png` });
  await page.close();
  console.log(s.name);
}
await browser.close();
