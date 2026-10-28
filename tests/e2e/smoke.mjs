// Quick visual smoke: load the built app, collect console errors, screenshot each workspace.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const PORT = 8771;
const BASE = `http://localhost:${PORT}/aperture/`;
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE); if ((await r.text()).includes('APERTURE')) break; } catch {} await sleep(250); }
const browser = await chromium.launch({ executablePath: join(homedir(), 'Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'), headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 940 } })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(BASE);
await sleep(2500);
await page.screenshot({ path: `${OUT}smoke-draw.png` });
for (const ws of process.argv.slice(2)) {
  await page.click(`.ws-tab:has-text("${ws}")`);
  await sleep(1500);
  await page.screenshot({ path: `${OUT}smoke-${ws}.png` });
}
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
server.kill();
