/* Capture several views in one browser session. */
import puppeteer from 'puppeteer-core';
const EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const outDir=process.argv[2];
const browser=await puppeteer.launch({executablePath:EDGE,headless:'new',
  args:['--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--no-sandbox'],
  defaultViewport:{width:1600,height:900}});
const page=await browser.newPage();
page.on('pageerror',e=>console.log('[pageerror]',e.message));
page.on('console',m=>{if(m.type()==='error')console.log('[err]',m.text());});
await page.goto('http://localhost:8173/',{waitUntil:'load',timeout:60000});
/* The picker stays disabled until the AI-assistance box is ticked. */
await page.click('#loader-ack');
const input=await page.$('#loader-file');
await input.uploadFile('sfight.zip');
await page.waitForFunction('document.getElementById("app") && !document.getElementById("app").hidden',{timeout:120000});
if (process.env.TEXRAM) {
  const t = await page.$('#tex-file');
  await t.uploadFile(...process.env.TEXRAM.split(','));
  await page.waitForFunction("document.getElementById('tex-drop').classList.contains('loaded')",{timeout:60000});
}
await new Promise(r=>setTimeout(r,1500));
const shots=JSON.parse(process.argv[3]);
for(const s of shots){
  await page.evaluate(`(function(){${s.js}})()`);
  await new Promise(r=>setTimeout(r,s.wait||1400));
  await page.screenshot({path:`${outDir}/${s.name}.png`});
  console.log('shot',s.name);
}
await browser.close();
