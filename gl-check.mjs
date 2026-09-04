/* Boot the viewer under a given ANGLE backend and report GL info + any shader
 * or page errors. usage: node gl-check.mjs */
import puppeteer from 'puppeteer-core';
const EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const backend=process.argv[2]||'default';
const args=['--no-sandbox','--enable-unsafe-swiftshader'];
if(backend!=='default'){args.push('--use-gl=angle','--use-angle='+backend);}
const browser=await puppeteer.launch({executablePath:EDGE,headless:'new',args,
  defaultViewport:{width:1200,height:700}});
const page=await browser.newPage();
const errs=[];
page.on('pageerror',e=>errs.push('pageerror: '+e.message));
page.on('console',m=>{if(m.type()==='error'||m.type()==='warning')errs.push(m.type()+': '+m.text().slice(0,600));});
await page.goto('http://localhost:8173/',{waitUntil:'load'});
console.log('backend', backend, '->', await page.evaluate(()=>{
  const c=document.createElement('canvas');
  const g2=c.getContext('webgl2'), g=g2||c.getContext('webgl');
  if(!g) return 'no webgl at all';
  const d=g.getExtension('WEBGL_debug_renderer_info');
  return (g2?'WebGL2':'WebGL1')+' | '+(d?g.getParameter(d.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER));
}));
/* The picker stays disabled until the AI-assistance box is ticked. */
await page.click('#loader-ack');
const input=await page.$('#loader-file');
await input.uploadFile('sfight.zip');
try{
  await page.waitForFunction('!document.getElementById("app").hidden',{timeout:90000});
  await new Promise(r=>setTimeout(r,2500));
  const stats=await page.evaluate('document.getElementById("stats").textContent');
  console.log('booted; stats =', stats);
}catch{
  console.log('DID NOT BOOT; err =', await page.evaluate('document.getElementById("loader-error").textContent'));
}
if(errs.length) console.log('--- errors ---\n' + errs.slice(0,6).join('\n'));
else console.log('no console errors');
await browser.close();
