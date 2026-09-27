/*
 * record-previews.mjs — the clips the loading screen plays.
 *
 * The splash shows what each game looks like once its ROM set is dropped, and
 * the only honest way to show that is the explorer itself drawing it. So this
 * loads a set into the real page in headless Chrome, takes the camera away from
 * the mouse, flies it along a scripted path one fixed step at a time, and hands
 * the frames to ffmpeg. Nothing is staged: the stage, the rig and the motion are
 * whatever the page builds from the zips, exactly as a visitor would get them.
 *
 * The clock is the page's own clock replaced. requestAnimationFrame is queued
 * rather than run and performance.now reads a counter this script advances, so
 * a stage's frame tables and a fighter's motion step by exactly one clip frame
 * per picture however long SwiftShader takes to draw it.
 *
 *   node record-previews.mjs --game stf  sfight.zip [schamp.zip]
 *   node record-previews.mjs --game hotdp hotdp.zip
 *   node record-previews.mjs --game stf --list sfight.zip
 *
 * --list prints the stages, characters and motions the set loaded with, which
 * is what the shot tables below index, and --stills saves every stage as the
 * explorer frames it, to pick shots from. --only NAME records one shot. Needs
 * puppeteer-core (a dev dependency), Chrome or Edge ($CHROME overrides the
 * search) and ffmpeg with libx264 on the PATH.
 *
 * The page is the explorer's, served out of vendor/noclip or, like serve.mjs,
 * out of the working checkout $STF_SITE names. The clips are that explorer's to
 * publish, so with $STF_SITE set they go to its media/previews/<game>-<shot>.mp4
 * with a .jpg poster beside it, ready to commit there. Without it they go to a
 * temp directory: the submodule is a pinned commit and nothing is written into
 * it. --out names another directory.
 *
 * The ROM set is read from disk by the browser's file input and nowhere else:
 * the server below refuses a .zip like serve.mjs does.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(process.env.STF_SITE
    || path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor/noclip'));
const W = 640, H = 360, FPS = 30;

/*
 * A shot: what to open, and where the camera is at time t seconds.
 *
 * `setup` runs in the page against the helpers installed further down —
 * pickStage, pickTab, pickChar, pickMotion, check — and picks what is shown.
 * `cam` runs in the page every frame and returns { eye, at } in world units;
 * both are source, since they are shipped over to the page as text. `f` is the
 * bounding sphere the explorer framed the setup on, { c, r }, captured once, so
 * a path is written against the scene's own size rather than each stage's
 * units. `ring(f, angle, distance, height)` is a point circling it, and
 * `track()` is the middle of the rig as it stands this frame.
 */
const SHOTS = {
    stf: [
        {
            name: 'carpet', seconds: 6,
            /* Flying Carpet in the board's own frame: the arena held still and
             * the desert wheeling past it. */
            setup: `await pickStage(/carpet/i); check('#opt-ride', true); await tick();`,
            cam: `(t, f) => ({ eye: ring(f, 0.6 + t * 0.3, 1.3, 0.38), at: f.c })`,
        },
        {
            name: 'canyon', seconds: 6,
            /* Canyon Cruise the same way: the boat held and the canyon going by. */
            setup: `await pickStage(/canyon/i); check('#opt-ride', true); await tick();`,
            cam: `(t, f) => ({ eye: ring(f, 2.2 - t * 0.2, 0.45, 0.1), at: f.c })`,
        },
        {
            name: 'giantwing', seconds: 6,
            /* Giant Wing's deck, out among the clouds. */
            setup: `await pickStage(/giant wing/i);`,
            cam: `(t, f) => ({ eye: ring(f, 0.4 + t * 0.15, 0.8, 0.22), at: f.c })`,
        },
        {
            name: 'noclip', seconds: 6,
            /* A noclip dive: in from outside Casino Night's wall, over it and
             * down into the ring. */
            setup: `await pickStage(/casino/i);`,
            cam: `(t, f) => { const u = t / 6, e = u * u * (3 - 2 * u);
                return { eye: ring(f, 0.9, 1.1 - 0.85 * e, 0.45 - 0.38 * e),
                         at: [f.c[0], f.c[1] - f.r * 0.08 * e, f.c[2]] }; }`,
        },
        {
            name: 'fighter', seconds: 6,
            /* Sonic in a move that leaves afterimages, the camera circling him. */
            setup: `await pickTab('anim'); await pickChar(1); await pickChar(0);
                check('#char-skel', false); await pickMotion(72);`,
            cam: `(t, f) => { const c = track();
                return { eye: [c[0] + f.r * 1.4 * Math.sin(t * 0.8), c[1] + f.r * 0.15, c[2] + f.r * 1.4 * Math.cos(t * 0.8)],
                         at: [c[0], c[1] + f.r * 0.1, c[2]] }; }`,
        },
    ],
    hotdp: [
        {
            name: 'room', seconds: 6,
            /* Standing in the lit room of Stage 1's fourth set and turning. */
            setup: `await pickStage(2);`,
            cam: `(t, f) => ({ eye: ring(f, 0.8 + t * 0.35, 0.3, 0.1), at: [f.c[0], f.c[1] - f.r * 0.05, f.c[2]] })`,
        },
        {
            name: 'set3', seconds: 6,
            /* Low over Stage 1's third set. */
            setup: `await pickStage(1);`,
            cam: `(t, f) => ({ eye: ring(f, 0.6 + t * 0.15, 0.7, 0.3), at: f.c })`,
        },
        {
            name: 'body', seconds: 6,
            /* An enemy body playing a motion baked for its joint count. */
            setup: `await pickTab('anim'); await pickChar(1); await pickChar(15);
                check('#char-skel', false); await pickMotion(0);`,
            cam: `(t, f) => { const c = track();
                return { eye: [c[0] + f.r * 0.75 * Math.sin(t * 0.8), c[1] + f.r * 0.05, c[2] + f.r * 0.75 * Math.cos(t * 0.8)],
                         at: [c[0], c[1] + f.r * 0.1, c[2]] }; }`,
        },
    ],
};

/* ---- arguments ---------------------------------------------------------- */

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i < 0 ? null : argv.splice(i, 2)[1]; };
const flag = (k) => { const i = argv.indexOf(k); return i < 0 ? false : (argv.splice(i, 1), true); };
const game = opt('--game');
const only = opt('--only');
const list = flag('--list');
const stills = flag('--stills');
const OUT = path.resolve(opt('--out') ?? (process.env.STF_SITE
    ? path.join(ROOT, 'media/previews') : path.join(os.tmpdir(), 'stf-previews')));
const zips = argv.map((z) => path.resolve(z));
if (!game || !zips.length || (!list && !SHOTS[game])) {
    console.error('usage: node record-previews.mjs --game <stf|hotdp|...> [--list] [--stills] [--only shot] [--out dir] zip...');
    process.exit(2);
}

/* ---- the page ----------------------------------------------------------- */

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4' };
const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || /\.zip$/i.test(file)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' }).end(buf);
    });
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const url = `http://127.0.0.1:${server.address().port}/?desktop`;

const chrome = process.env.CHROME ?? [
    '/usr/bin/google-chrome', '/usr/bin/chromium',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));
const browser = await puppeteer.launch({
    executablePath: chrome, headless: true,
    args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H });
page.on('pageerror', (e) => console.error('page:', e.message));

/* The clock, replaced before any of the page's modules run. It runs free while
 * the set loads, since the loader yields to a frame to paint its progress, and
 * is held from the first step() on. */
await page.evaluateOnNewDocument(() => {
    const realNow = performance.now.bind(performance), realRaf = window.requestAnimationFrame.bind(window);
    let now = null;
    let queue = [];
    performance.now = () => now ?? realNow();
    window.requestAnimationFrame = (f) => {
        if (now === null) return realRaf(f);
        queue.push(f); return queue.length;
    };
    window.__clock = {
        step(ms) {
            if (now === null) now = realNow();
            now += ms; const q = queue; queue = []; for (const f of q) f(now);
        },
    };
});
await page.goto(url);
await page.evaluate(() => {
    const ack = document.querySelector('#loader-ack');
    ack.checked = true;
    ack.dispatchEvent(new Event('change'));
});
await (await page.$('#loader-file')).uploadFile(...zips);
await page.waitForFunction(() => window.stf?.viewer || !document.querySelector('#loader-error').hidden,
    { timeout: 300000 });
const failed = await page.evaluate(() => !document.querySelector('#loader-error').hidden
    && document.querySelector('#loader-error').textContent);
if (failed) { console.error('load failed:', failed); process.exit(1); }

/* Only the view: the panel, the corner tools and the HUD are not the preview. */
await page.addStyleTag({ content: '#sidebar, #tools, #hud, #fly-hint, #link-note { display: none !important; }' });
await page.evaluate(() => window.stf.viewer.resize());

/* In-page helpers the shot setups are written against. */
await page.evaluate(() => {
    const $ = (q) => document.querySelector(q);
    const tick = () => new Promise((ok) => { window.__clock.step(1000 / 30); setTimeout(ok, 0); });
    const select = async (q, v) => { const n = $(q); n.value = String(v); n.dispatchEvent(new Event('change')); await tick(); };
    Object.assign(window, {
        $, tick,
        check: (q, on) => { const n = $(q); if (n.checked !== on) { n.checked = on; n.dispatchEvent(new Event('change')); } },
        pickTab: async (t) => { $(`#tabs button[data-tab="${t}"]`).click(); await tick(); },
        pickStage: async (which) => {
            const opts = [...$('#stage-select').options];
            const o = typeof which === 'number' ? opts[which] : opts.find((x) => which.test(x.textContent));
            if (!o) throw new Error(`no stage ${which}`);
            await select('#stage-select', o.value);
        },
        pickChar: (i) => select('#char-select', i),
        pickMotion: (i) => select('#motion-select', $('#motion-select').options[i].value),
        ring: (f, a, d, h) => [f.c[0] + f.r * d * Math.sin(a), f.c[1] + f.r * h, f.c[2] + f.r * d * Math.cos(a)],
        track: () => {
            /* A fighter's part is one mesh; a HOTD body's part keeps a slot
             * per model it has drawn. */
            const meshes = window.stf.motion.parts.flatMap((p) => p.mesh ? [p.mesh]
                : p.slots.filter((x) => x.decoded && x.mesh.visible).map((x) => x.mesh));
            const c = [0, 0, 0];
            for (const m of meshes) {
                const w = m.getWorldPosition(m.position.clone());
                c[0] += w.x / meshes.length; c[1] += w.y / meshes.length; c[2] += w.z / meshes.length;
            }
            return c;
        },
    });
});

/* Every stage from where the explorer frames it, to pick the shots from. */
if (stills) {
    const dir = path.join(os.tmpdir(), 'noclip-stills');
    fs.mkdirSync(dir, { recursive: true });
    const n = await page.evaluate(() => $('#stage-select').options.length);
    for (let i = 0; i < n; i++) {
        const jpg = await page.evaluate(async (i) => {
            await pickStage(i); window.__clock.step(1000 / 30);
            return window.stf.viewer.canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
        }, i);
        fs.writeFileSync(`${dir}/${game}-${String(i).padStart(2, '0')}.jpg`, Buffer.from(jpg, 'base64'));
    }
    console.log(`stills in ${dir}`);
    await browser.close(); server.close();
    process.exit(0);
}

if (list) {
    console.log(await page.evaluate(() => {
        const names = (q) => [...document.querySelectorAll(`${q} option`)].map((o, i) => `  ${i}: ${o.textContent}`).join('\n');
        return `stages:\n${names('#stage-select')}\ncharacters:\n${names('#char-select')}`;
    }));
    for (const c of await page.evaluate(() => [...document.querySelectorAll('#char-select option')].map((o) => o.value)).then((v) => v.slice(0, 3))) {
        console.log(await page.evaluate(async (c) => {
            await pickTab('anim'); await pickChar(c);
            return `motions for ${$('#char-select').selectedOptions[0].textContent}:\n`
                + [...document.querySelectorAll('#motion-select option')].map((o, i) => `  ${i}: ${o.textContent}`).join('\n');
        }, c));
    }
    await browser.close(); server.close();
    process.exit(0);
}

/* ---- recording ---------------------------------------------------------- */

fs.mkdirSync(OUT, { recursive: true });
for (const shot of SHOTS[game]) {
    if (only && shot.name !== only) continue;
    const base = path.join(OUT, `${game}-${shot.name}`);
    console.log(`${game}-${shot.name}: setting up`);
    await page.evaluate(`(async () => { ${shot.setup} })()`);
    /* The sphere the setup framed on, read back off the camera it placed. */
    await page.evaluate(() => {
        const v = window.stf.viewer;
        const c = v.orbit.target;
        window.__frame = { c: [c.x, c.y, c.z], r: v.camera.position.distanceTo(c) / (1.15 / Math.sin((v.camera.fov * Math.PI) / 360)) };
        v.setMode('fly');
        v.fly.enabled = false;
    });
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
        '-vf', 'scale=640:360', '-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', '-an', `${base}.mp4`], { stdio: ['pipe', 'inherit', 'inherit'] });
    const frames = Math.round(shot.seconds * FPS);
    for (let i = 0; i < frames; i++) {
        const jpg = await page.evaluate((src, t) => {
            const v = window.stf.viewer;
            const { eye, at } = eval(src)(t, window.__frame);
            v.camera.position.set(...eye);
            v.camera.lookAt(...at);
            v.frameFar();
            window.__clock.step(1000 / 30);
            return v.canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
        }, shot.cam, i / FPS);
        const buf = Buffer.from(jpg, 'base64');
        if (!ff.stdin.write(buf)) await new Promise((ok) => ff.stdin.once('drain', ok));
        if (i === Math.floor(frames / 2)) fs.writeFileSync(`${base}.jpg`, buf);
        if (i % 30 === 0) process.stdout.write(`\r  frame ${i}/${frames}`);
    }
    ff.stdin.end();
    await new Promise((ok) => ff.on('close', ok));
    console.log(`\r  ${base}.mp4 ${(fs.statSync(`${base}.mp4`).size / 1024).toFixed(0)} KB`);
}
await browser.close();
server.close();
