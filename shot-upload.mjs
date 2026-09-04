/* Verifies the upload path: the page must sit on the drop zone until a zip is
 * handed to the file input, then boot from it. */
import puppeteer from 'puppeteer-core';
const EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const outDir=process.argv[2];
const browser=await puppeteer.launch({executablePath:EDGE,headless:'new',
  args:['--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--no-sandbox'],
  defaultViewport:{width:1600,height:900}});
const page=await browser.newPage();
page.on('pageerror',e=>console.log('[pageerror]',e.message));
page.on('console',m=>{if(m.type()==='error')console.log('[err]',m.text());});
page.on('request',r=>{ if(r.url().endsWith('.zip')) console.log('[FETCHED A ZIP]',r.url()); });

await page.goto('http://localhost:8173/',{waitUntil:'load',timeout:60000});
await new Promise(r=>setTimeout(r,2500));
console.log('app hidden after load:', await page.evaluate('document.getElementById("app").hidden'));
console.log('drop zone visible:', await page.evaluate('!!document.getElementById("loader-drop").offsetParent'));
await page.screenshot({path:`${outDir}/upload-1-idle.png`});

/* The picker stays disabled until the AI-assistance box is ticked. */
await page.click('#loader-ack');
const input = await page.$('#loader-file');
await input.uploadFile('sfight.zip');
try {
  await page.waitForFunction('!document.getElementById("app").hidden',{timeout:120000});
  console.log('[ok] booted from uploaded file');
} catch { console.log('[FAIL] did not boot'); }
await new Promise(r=>setTimeout(r,2500));
await page.screenshot({path:`${outDir}/upload-2-loaded.png`});
await browser.close();
