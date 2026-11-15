/**
 * Renders assets/icon.svg to the PNG sizes required by Chrome.
 * Uses the Playwright Chromium build that is already installed locally.
 *
 * Usage: node tools/generate-icons.mjs
 */
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svgPath = path.join(root, 'assets', 'icon.svg');
const outputDir = path.join(root, 'assets', 'icons');
const sizes = [16, 32, 48, 128];

function chromiumExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium-1243', 'chrome-win', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('No Chromium executable found. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE.');
  return found;
}

const svg = await readFile(svgPath, 'utf8');
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: chromiumExecutable(),
  headless: true
});

try {
  for (const size of sizes) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><html><head><style>
        html,body{margin:0;padding:0;background:transparent;width:${size}px;height:${size}px;overflow:hidden}
        svg{display:block;width:${size}px;height:${size}px}
      </style></head><body>${svg}</body></html>`,
      { waitUntil: 'load' }
    );
    const file = path.join(outputDir, `icon${size}.png`);
    await page.screenshot({ path: file, omitBackground: true, type: 'png' });
    await page.close();
    console.log(`Created ${path.relative(root, file)}`);
  }
} finally {
  await browser.close();
}
