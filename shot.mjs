/* Headless screenshot + console capture for the explorer.
 * usage: node shot.mjs <outfile.png> [ "<js to run before shot>" ] */
import puppeteer from 'puppeteer-core';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const out = process.argv[2] || 'shot.png';
const script = process.argv[3] || '';

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
         '--window-size=1600,900', '--no-sandbox'],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on('console', m => console.log(`[${m.type()}]`, m.text()));
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('requestfailed', r => console.log('[reqfail]', r.url(), r.failure()?.errorText));

await page.goto('http://localhost:8173/', { waitUntil: 'load', timeout: 60000 });
/* The picker stays disabled until the AI-assistance box is ticked. */
await page.click('#loader-ack');
const input=await page.$('#loader-file');
if (input) await input.uploadFile('sfight.zip');
try {
  await page.waitForFunction('document.getElementById("app") && !document.getElementById("app").hidden', { timeout: 90000 });
  console.log('[ok] app booted');
} catch { console.log('[warn] app did not boot; capturing loader'); }
await new Promise(r => setTimeout(r, 2500));
if (script) { console.log('[eval]', JSON.stringify(await page.evaluate(script))); await new Promise(r => setTimeout(r, 2000)); }
await page.screenshot({ path: out });
console.log('[shot]', out);
await browser.close();
