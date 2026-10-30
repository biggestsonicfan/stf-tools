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
 *   node record-previews.mjs --game hotdp --build hotdp hotd.zip   (a merged set)
 *   node record-previews.mjs --game daytona daytona.zip
 *   node record-previews.mjs --game vcop vcop.zip     (likewise vf2, doa)
 *   node record-previews.mjs --game von vonj.zip von.zip
 *   node record-previews.mjs --game srallyc srallyc.zip (likewise dynamcop,
 *                                       airwlkrs, powsled, lastbrnx, pltkids,
 *                                       motoraid, vcop2, vstriker, manxtt,
 *                                       stcc, sgt24h, dynabb, gunblade, zerogun,
 *                                       skytargt, skisuprg, waverunr, segawski,
 *                                       topskatr, bel, desert)
 *   node record-previews.mjs --game indy500 indy500d.zip indy500.zip (likewise
 *                                       overrev with overrevb.zip, overrev.zip)
 *   node record-previews.mjs --game stf --list sfight.zip
 *
 * --list prints the stages, characters and motions the set loaded with, which
 * is what the shot tables below index, and --stills saves every stage as the
 * explorer frames it, to pick shots from (with --models A-B, the models in that
 * range, or every S-th of it with A-B/S, for a game with only a Models tab).
 * --only NAME records one shot. Needs
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
 * pickStage and pickMotion take a list position or a pattern on the text.
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
            /* Sonic playing a string as the game strings it — a sidestep that
             * leaves afterimages, then three kicks, each taking over at the
             * last one's cancel frame — the camera circling him. */
            setup: `await pickTab('anim'); await pickChar(1); await pickChar(0);
                check('#char-skel', false); await pickMotion(/^yokel_kkk /);`,
            cam: `(t, f) => { const c = track();
                return { eye: [c[0] + f.r * 1.7 * Math.sin(t * 0.8), c[1] + f.r * 0.15, c[2] + f.r * 1.7 * Math.cos(t * 0.8)],
                         at: [c[0], c[1] + f.r * 0.1, c[2]] }; }`,
        },
    ],
    hotd: [
        {
            name: 'mansion', seconds: 6,
            /* Low over Stage 1's third set: the mansion's lit rooms. */
            setup: `await pickStage(1);`,
            cam: `(t, f) => ({ eye: ring(f, 0.5 + t * 0.15, 0.6, 0.25), at: f.c })`,
        },
        {
            name: 'stage2', seconds: 6,
            /* Chapter 2's sixth set under its band of cloud. */
            setup: `await pickStage(5);`,
            cam: `(t, f) => ({ eye: ring(f, 1.2 + t * 0.12, 1.0, 0.4), at: f.c })`,
        },
        {
            name: 'body', seconds: 6,
            /* BO_tetuman, the zombie with a blade for an arm. */
            setup: `await pickTab('anim'); await pickChar(1); await pickChar(53);
                check('#char-skel', false); await pickMotion(0);`,
            cam: `(t, f) => { const c = track();
                return { eye: [c[0] + f.r * 0.75 * Math.sin(t * 0.8), c[1] + f.r * 0.05, c[2] + f.r * 0.75 * Math.cos(t * 0.8)],
                         at: [c[0], c[1] + f.r * 0.1, c[2]] }; }`,
        },
    ],
    daytona: [
        {
            name: 'speedway', seconds: 6,
            /* Three-Seven Speedway, the grid on the line, circling low. */
            setup: `await pickStage(0);`,
            cam: `(t, f) => ({ eye: ring(f, 0.3 + t * 0.12, 0.3, 0.07), at: f.c })`,
        },
        {
            name: 'canyon', seconds: 6,
            /* Dinosaur Canyon from above its rock. */
            setup: `await pickStage(2);`,
            cam: `(t, f) => ({ eye: ring(f, 2.0 + t * 0.1, 0.45, 0.12), at: f.c })`,
        },
        {
            name: 'seaside', seconds: 6,
            /* Seaside Street Galaxy along the water. */
            setup: `await pickStage(1);`,
            cam: `(t, f) => ({ eye: ring(f, 4.0 + t * 0.1, 0.4, 0.1), at: f.c })`,
        },
    ],
    fvipers: [
        {
            name: 'arena', seconds: 6,
            /* The first arena's walled yard, circled from just over the wall. */
            setup: `await pickStage(0);`,
            cam: `(t, f) => ({ eye: ring(f, 0.6 + t * 0.2, 0.75, 0.25), at: f.c })`,
        },
        {
            name: 'sunset', seconds: 6,
            /* The same yard at sunset, as another arena's record draws it. */
            setup: `await pickStage(4);`,
            cam: `(t, f) => ({ eye: ring(f, 2.4 - t * 0.2, 0.7, 0.2), at: f.c })`,
        },
        {
            name: 'ring', seconds: 6,
            /* A roped ring under its signs. */
            setup: `await pickStage(8);`,
            cam: `(t, f) => ({ eye: ring(f, 1.0 + t * 0.2, 1.5, 0.5), at: f.c })`,
        },
    ],
    /* Virtua Cop opens a stage on its rail rather than framed from outside,
     * so its clips ride the rail: `rail(n)` is the camera at count n, which
     * the board steps once a frame at 60 Hz, so two counts a clip frame. */
    vcop: [
        {
            name: 'warehouse', seconds: 6,
            /* Stage 1 from the start, into the warehouse yard. */
            setup: `await pickStage(0);`,
            cam: `(t) => rail(t * 60)`,
        },
        {
            name: 'site', seconds: 6,
            /* Stage 2 across the building site under its red sky. */
            setup: `await pickStage(1);`,
            cam: `(t) => rail(t * 60)`,
        },
        {
            name: 'tower', seconds: 6,
            /* Stage 3 up to the tower. */
            setup: `await pickStage(2);`,
            cam: `(t) => rail(t * 60)`,
        },
    ],
    vf2: [
        {
            name: 'islands', seconds: 6,
            /* The Islands' ring on its spit of sand. */
            setup: `await pickStage(6);`,
            cam: `(t, f) => ({ eye: ring(f, 0.6 + t * 0.15, 0.55, 0.25), at: f.c })`,
        },
        {
            name: 'wall', seconds: 6,
            /* Ban-ri, the ring on the Great Wall. */
            setup: `await pickStage(5);`,
            cam: `(t, f) => ({ eye: ring(f, 1.6 + t * 0.15, 0.6, 0.25), at: f.c })`,
        },
        {
            name: 'snow', seconds: 6,
            /* Yuki-yama's ring cut into the snow mountain. */
            setup: `await pickStage(9);`,
            cam: `(t, f) => ({ eye: ring(f, 0.3 + t * 0.15, 0.6, 0.3), at: f.c })`,
        },
        {
            name: 'fighter', seconds: 6,
            /* Akira on his own rig. */
            setup: `await pickTab('anim'); await pickChar(1); await pickChar(0);
                check('#char-skel', false); await pickMotion(14);`,
            cam: `(t, f) => { const c = track();
                return { eye: [c[0] + f.r * 1.4 * Math.sin(t * 0.8), c[1] + f.r * 0.1, c[2] + f.r * 1.4 * Math.cos(t * 0.8)],
                         at: [c[0], c[1] + f.r * 0.1, c[2]] }; }`,
        },
    ],
    doa: [
        {
            name: 'palace', seconds: 6,
            /* Stage 3's walled court under the clouds. */
            setup: `await pickStage(3);`,
            cam: `(t, f) => ({ eye: ring(f, 0.6 + t * 0.15, 0.6, 0.25), at: f.c })`,
        },
        {
            name: 'sunset', seconds: 6,
            /* Stage 11's ring of rock against the orange sky. */
            setup: `await pickStage(11);`,
            cam: `(t, f) => ({ eye: ring(f, 1.2 + t * 0.15, 0.6, 0.2), at: f.c })`,
        },
        {
            name: 'city', seconds: 6,
            /* Stage 10's rooftop over the city at night. */
            setup: `await pickStage(10);`,
            cam: `(t, f) => ({ eye: ring(f, 0.4 + t * 0.12, 0.6, 0.25), at: f.c })`,
        },
        {
            name: 'fighter', seconds: 6,
            /* Kasumi on her own rig. The list skips the fighters the set
             * has no rig for, so she is picked by her place in it. */
            setup: `await pickTab('anim'); await pickChar($('#char-select').options[4].value);
                check('#char-skel', false); await pickMotion(30);`,
            cam: `(t, f) => { const c = track();
                return { eye: [c[0] + f.r * 1.0 * Math.sin(t * 0.8), c[1] + f.r * 0.1, c[2] + f.r * 1.0 * Math.cos(t * 0.8)],
                         at: [c[0], c[1] + f.r * 0.1, c[2]] }; }`,
        },
    ],
    srallyc: [
        {
            name: 'forest', seconds: 6,
            /* The Forest course winding through its trees, low over the road. */
            setup: `await pickStage(2);`,
            cam: `(t, f) => ({ eye: ring(f, 0.5 + t * 0.12, 0.45, 0.12), at: f.c })`,
        },
        {
            name: 'desert', seconds: 6,
            /* The Desert course under its blue sky. */
            setup: `await pickStage(0);`,
            cam: `(t, f) => ({ eye: ring(f, 1.0 + t * 0.12, 0.35, 0.18), at: [f.c[0], f.c[1] + f.r * 0.1, f.c[2]] })`,
        },
        {
            name: 'mountain', seconds: 6,
            /* The Mountain course against its snowy peaks. */
            setup: `await pickStage(1);`,
            cam: `(t, f) => ({ eye: ring(f, 2.6 + t * 0.12, 0.35, 0.18), at: [f.c[0], f.c[1] + f.r * 0.1, f.c[2]] })`,
        },
    ],
    /* Virtual-On's fields, from inside their walls. vonj is a clone: drop
     * von.zip on beside it. */
    von: [
        {
            name: 'airport', seconds: 6,
            setup: `await pickStage(/airport/i);`,
            cam: `(t, f) => ({ eye: ring(f, 0.6 + t * 0.15, 0.45, 0.12), at: f.c })`,
        },
        {
            name: 'deathtrap', seconds: 6,
            setup: `await pickStage(/death trap/i);`,
            cam: `(t, f) => ({ eye: ring(f, 1.6 + t * 0.15, 0.5, 0.2), at: f.c })`,
        },
        {
            name: 'secretbase', seconds: 6,
            setup: `await pickStage(/secret base/i);`,
            cam: `(t, f) => ({ eye: ring(f, 0.3 + t * 0.15, 0.45, 0.15), at: f.c })`,
        },
    ],
    dynamcop: [
        {
            name: 'ballroom', seconds: 6,
            /* Course 2-1, area 18: the ship's ballroom and its tables. */
            setup: `await pickStage(/Course 2-1, area 18$/);`,
            cam: `(t, f) => ({ eye: ring(f, 0.6 + t * 0.15, 0.5, 0.2), at: f.c })`,
        },
        {
            name: 'harbour', seconds: 6,
            /* Course 4-1, area 29: the boats in the cave harbour. */
            setup: `await pickStage(/Course 4-1, area 29$/);`,
            cam: `(t, f) => ({ eye: ring(f, 1.2 + t * 0.12, 0.8, 0.3), at: f.c })`,
        },
        {
            name: 'deck', seconds: 6,
            /* Course 4-2, area 49: out on the deck at night. */
            setup: `await pickStage(/Course 4-2, area 49$/);`,
            cam: `(t, f) => ({ eye: ring(f, 0.8 + t * 0.12, 0.6, 0.25), at: f.c })`,
        },
    ],
    /* Air Walkers' courts, one a team, and a player on the Animation tab. */
    airwlkrs: [
        {
            name: 'court', seconds: 6,
            /* Seattle Velocity's home court, low over the floor. */
            setup: `await pickStage(0);`,
            cam: `(t, f) => ({ eye: ring(f, 0.6 + t * 0.15, 0.45, 0.12), at: f.c })`,
        },
        {
            name: 'stands', seconds: 6,
            /* New York Stars' court from up in the stands. */
            setup: `await pickStage(10);`,
            cam: `(t, f) => ({ eye: ring(f, 2.0 + t * 0.12, 0.6, 0.25), at: f.c })`,
        },
        {
            name: 'player', seconds: 6,
            /* A Seattle Velocity player on his own rig. */
            setup: `await pickTab('anim'); await pickChar(1); await pickChar(0);
                check('#char-skel', false); await pickMotion(9);`,
            cam: `(t, f) => { const c = track();
                return { eye: [c[0] + f.r * 1.2 * Math.sin(t * 0.8), c[1] + f.r * 0.1, c[2] + f.r * 1.2 * Math.cos(t * 0.8)],
                         at: [c[0], c[1] + f.r * 0.05, c[2]] }; }`,
        },
    ],
    /* Power Sled's one course, a scene at a time as the race draws it (the
     * Zone list's views, each framed on its scene), and an attract ride. */
    powsled: [
        {
            name: 'start', seconds: 6,
            /* The start, under the cranes that hold the sleds. */
            setup: `await pickStage(0); await pickView('zone:0');`,
            cam: `(t) => { const f = viewFrame('zone:0'); return { eye: ring(f, 0.6 + t * 0.12, 0.8, 0.3), at: f.c }; }`,
        },
        {
            name: 'tunnel', seconds: 6,
            /* The tunnel through the ice. */
            setup: `await pickStage(0); await pickView('zone:2');`,
            cam: `(t) => { const f = viewFrame('zone:2'); return { eye: ring(f, 2.4 + t * 0.12, 0.8, 0.3), at: f.c }; }`,
        },
        {
            name: 'bridges', seconds: 6,
            /* The bridges over the gorge. */
            setup: `await pickStage(0); await pickView('zone:4');`,
            cam: `(t) => { const f = viewFrame('zone:4'); return { eye: ring(f, 0.8 + t * 0.12, 0.8, 0.3), at: f.c }; }`,
        },
        {
            name: 'ride', seconds: 6,
            /* An attract ride scene: two riders on the yellow sled. */
            setup: `await pickTab('anim'); await pickChar(0); await pickChar(12);
                check('#char-skel', false); await pickMotion(0);`,
            cam: `(t, f) => ({ eye: ring(f, 0.6 + t * 0.3, 1.2, 0.3), at: f.c })`,
        },
    ],
    /* Last Bronx's stages, and a fighter. A stage is framed with its
     * skyline, so the ring is pulled in close to the floor. */
    lastbrnx: [
        {
            name: 'parking', seconds: 6,
            setup: `await pickStage(/parking/i);`,
            cam: `(t, f) => ({ eye: ring(f, 0.6 + t * 0.15, 0.2, 0.06), at: f.c })`,
        },
        {
            name: 'garden', seconds: 6,
            setup: `await pickStage(/garden/i);`,
            cam: `(t, f) => ({ eye: ring(f, 1.6 + t * 0.15, 0.2, 0.06), at: f.c })`,
        },
        {
            name: 'street', seconds: 6,
            setup: `await pickStage(/cross street/i);`,
            cam: `(t, f) => ({ eye: ring(f, 0.3 + t * 0.15, 0.25, 0.1), at: f.c })`,
        },
        {
            name: 'fighter', seconds: 6,
            /* Yoko's win pose on her own rig. */
            setup: `await pickTab('anim'); await pickChar(1); await pickChar(0);
                check('#char-skel', false); await pickMotion(/^ton_win_05/);`,
            cam: `(t, f) => { const c = track();
                return { eye: [c[0] + f.r * 1.2 * Math.sin(t * 0.8), c[1] + f.r * 0.1, c[2] + f.r * 1.2 * Math.cos(t * 0.8)],
                         at: [c[0], c[1] + f.r * 0.05, c[2]] }; }`,
        },
    ],
    /* Pilot Kids has only the Models tab so far: its clips circle one
     * model each. */
    pltkids: [
        {
            name: 'pilot', seconds: 6,
            /* Model 4024, one of the kid pilots. */
            setup: `await pickModel(4024);`,
            cam: `(t, f) => ({ eye: ring(f, 0.6 + t * 0.5, 1.4, 0.2), at: f.c })`,
        },
        {
            name: 'viking', seconds: 6,
            /* Model 2695, the horned boss. */
            setup: `await pickModel(2695);`,
            cam: `(t, f) => ({ eye: ring(f, t * 0.5, 1.4, 0.25), at: f.c })`,
        },
        {
            name: 'dog', seconds: 6,
            /* Model 3418, a dog. */
            setup: `await pickModel(3418);`,
            cam: `(t, f) => ({ eye: ring(f, 0.3 + t * 0.5, 1.4, 0.2), at: f.c })`,
        },
    ],
    /* The racing games below have no rail: most of their clips fly along
     * the road the course draws, a little above it (course(), below). Where
     * that path wanders off the road (Manx TT's TT course, Indy 500's oval,
     * STCC) the clip circles the whole course from high up instead. */
    motoraid: [
        {
            name: 'snow', seconds: 6,
            /* The snowy pass. */
            setup: `await pickStage(0);`,
            cam: `(t, f) => ({ eye: course(0.15 + t * 0.06, f, 0.1), at: course(0.25 + t * 0.06, f, 0) })`,
        },
        {
            name: 'island', seconds: 6,
            /* The island course by the sea. */
            setup: `await pickStage(3);`,
            cam: `(t, f) => ({ eye: course(0.15 + t * 0.06, f, 0.1), at: course(0.25 + t * 0.06, f, 0) })`,
        },
    ],
    vcop2: [
        {
            name: 'city', seconds: 6,
            /* Down the city streets of the first stage. */
            setup: `await pickStage(0);`,
            cam: `(t, f) => ({ eye: course(0.15 + t * 0.06, f, 0.05), at: course(0.25 + t * 0.06, f, 0) })`,
        },
        {
            name: 'pier', seconds: 6,
            /* Along the pier of the second. */
            setup: `await pickStage(2);`,
            cam: `(t, f) => ({ eye: course(0.15 + t * 0.03, f, 0.05), at: course(0.25 + t * 0.03, f, 0) })`,
        },
    ],
    /* Virtua Striker's ground, from the stands and down on the pitch. */
    vstriker: [
        {
            name: 'stands', seconds: 6,
            /* Up in the stands. */
            setup: `await pickStage(0);`,
            cam: `(t, f) => ({ eye: ring(f, 0.6 + t * 0.15, 0.5, 0.15), at: f.c })`,
        },
        {
            name: 'pitch', seconds: 6,
            /* Low over the grass. */
            setup: `await pickStage(0);`,
            cam: `(t, f) => ({ eye: ring(f, 2.0 + t * 0.15, 0.25, 0.06), at: f.c })`,
        },
    ],
    manxtt: [
        {
            name: 'laxey', seconds: 6,
            /* The Laxey course. */
            setup: `await pickStage(0);`,
            cam: `(t, f) => ({ eye: course(0.15 + t * 0.06, f, 0.1), at: course(0.25 + t * 0.06, f, 0) })`,
        },
        {
            name: 'tt', seconds: 6,
            /* The TT course over the island. */
            setup: `await pickStage(1);`,
            cam: `(t, f) => ({ eye: ring(f, 0.6 + t * 0.12, 0.7, 0.35), at: f.c })`,
        },
    ],
    /* indy500d is a clone: drop indy500.zip on beside it. */
    indy500: [
        {
            name: 'bayside', seconds: 6,
            /* The Bayside street circuit. */
            setup: `await pickStage(0);`,
            cam: `(t, f) => ({ eye: course(0.15 + t * 0.06, f, 0.1), at: course(0.25 + t * 0.06, f, 0) })`,
        },
        {
            name: 'speedway', seconds: 6,
            /* Round the Speedway oval. */
            setup: `await pickStage(1);`,
            cam: `(t, f) => ({ eye: ring(f, 0.6 + t * 0.12, 0.7, 0.35), at: f.c })`,
        },
    ],
    stcc: [
        {
            name: 'brickwall', seconds: 6,
            /* The Brickwall Town circuit. */
            setup: `await pickStage(2);`,
            cam: `(t, f) => ({ eye: ring(f, 0.6 + t * 0.12, 0.7, 0.35), at: f.c })`,
        },
        {
            name: 'country', seconds: 6,
            /* The Country circuit. */
            setup: `await pickStage(0);`,
            cam: `(t, f) => ({ eye: ring(f, 0.6 + t * 0.12, 0.7, 0.35), at: f.c })`,
        },
    ],
    sgt24h: [
        {
            name: 'short', seconds: 6,
            /* The short circuit. */
            setup: `await pickStage(0);`,
            cam: `(t, f) => ({ eye: course(0.15 + t * 0.06, f, 0.1), at: course(0.25 + t * 0.06, f, 0) })`,
        },
        {
            name: 'long', seconds: 6,
            /* The long circuit. */
            setup: `await pickStage(1);`,
            cam: `(t, f) => ({ eye: course(0.15 + t * 0.06, f, 0.1), at: course(0.25 + t * 0.06, f, 0) })`,
        },
    ],
    /* overrevb is a clone: drop overrev.zip on beside it. */
    overrev: [
        {
            name: 'shibuya', seconds: 6,
            /* Through Shibuya. */
            setup: `await pickStage(1);`,
            cam: `(t, f) => ({ eye: course(0.15 + t * 0.06, f, 0.1), at: course(0.25 + t * 0.06, f, 0) })`,
        },
        {
            name: 'futou', seconds: 6,
            /* Along the wharf. */
            setup: `await pickStage(3);`,
            cam: `(t, f) => ({ eye: course(0.15 + t * 0.06, f, 0.1), at: course(0.25 + t * 0.06, f, 0) })`,
        },
    ],
    /* Dynamite Baseball's ballpark, from the stands and on the field. */
    dynabb: [
        {
            name: 'dome', seconds: 6,
            /* Up under the dome. */
            setup: `await pickStage(0);`,
            cam: `(t, f) => ({ eye: ring(f, 0.6 + t * 0.15, 0.5, 0.15), at: f.c })`,
        },
        {
            name: 'stadium', seconds: 6,
            /* Low over the diamond. */
            setup: `await pickStage(0);`,
            cam: `(t, f) => ({ eye: ring(f, 2.0 + t * 0.15, 0.25, 0.06), at: f.c })`,
        },
    ],
    /* Gunblade NY's enemies on their own rigs. */
    gunblade: [
        {
            name: 'figure', seconds: 6,
            /* The first figure in the list. */
            setup: `await pickTab('anim'); await pickChar(1); await pickChar(0);
                check('#char-skel', false); await pickMotion(6);`,
            cam: `(t, f) => { const c = track();
                return { eye: [c[0] + f.r * 1.3 * Math.sin(t * 0.8), c[1] + f.r * 0.1, c[2] + f.r * 1.3 * Math.cos(t * 0.8)],
                         at: [c[0], c[1] + f.r * 0.05, c[2]] }; }`,
        },
        {
            name: 'mohawk', seconds: 6,
            /* The punk with the mohawk. */
            setup: `await pickTab('anim'); await pickChar(1); await pickChar(12);
                check('#char-skel', false); await pickMotion(6);`,
            cam: `(t, f) => { const c = track();
                return { eye: [c[0] + f.r * 1.3 * Math.sin(t * 0.8), c[1] + f.r * 0.1, c[2] + f.r * 1.3 * Math.cos(t * 0.8)],
                         at: [c[0], c[1] + f.r * 0.05, c[2]] }; }`,
        },
    ],
    zerogun: [
        {
            name: 'asia', seconds: 6,
            /* Flying over Asia, the first stage. */
            setup: `await pickStage(0);`,
            cam: `(t, f) => ({ eye: course(0.15 + t * 0.06, f, 0.15), at: course(0.25 + t * 0.06, f, 0) })`,
        },
        {
            name: 'america', seconds: 6,
            /* Over America. */
            setup: `await pickStage(6);`,
            cam: `(t, f) => ({ eye: course(0.15 + t * 0.06, f, 0.15), at: course(0.25 + t * 0.06, f, 0) })`,
        },
    ],
    /* Sky Target's stages, circled from above. */
    skytargt: [
        {
            name: 'hokkaido', seconds: 6,
            /* Over Hokkaido. */
            setup: `await pickStage(3);`,
            cam: `(t, f) => ({ eye: ring(f, 0.6 + t * 0.15, 0.5, 0.2), at: f.c })`,
        },
        {
            name: 'gake', seconds: 6,
            /* Over the cliffs. */
            setup: `await pickStage(6);`,
            cam: `(t, f) => ({ eye: ring(f, 1.6 + t * 0.15, 0.5, 0.2), at: f.c })`,
        },
    ],
    /* Ski Super G has only the Models tab so far. */
    skisuprg: [
        {
            name: 'slope', seconds: 6,
            /* Model 4875, a stretch of slope. */
            setup: `await pickModel(4875);`,
            cam: `(t, f) => ({ eye: ring(f, 0.6 + t * 0.15, 1.4, 0.2), at: f.c })`,
        },
        {
            name: 'finish', seconds: 6,
            /* Model 5496, the finish banner. */
            setup: `await pickModel(5496);`,
            cam: `(t, f) => ({ eye: ring(f, 0.3 + t * 0.5, 1.4, 0.2), at: f.c })`,
        },
    ],
    waverunr: [
        {
            name: 'cove', seconds: 6,
            /* Low across the water of the cove. */
            setup: `await pickStage(1);`,
            cam: `(t, f) => ({ eye: course(0.15 + t * 0.06, f, 0.08), at: course(0.25 + t * 0.06, f, 0) })`,
        },
        {
            name: 'bay', seconds: 6,
            /* Across the bay. */
            setup: `await pickStage(2);`,
            cam: `(t, f) => ({ eye: course(0.15 + t * 0.06, f, 0.08), at: course(0.25 + t * 0.06, f, 0) })`,
        },
    ],
    segawski: [
        {
            name: 'park', seconds: 6,
            /* The park course. */
            setup: `await pickStage(2);`,
            cam: `(t, f) => ({ eye: course(0.15 + t * 0.06, f, 0.08), at: course(0.25 + t * 0.06, f, 0) })`,
        },
        {
            name: 'lagoon', seconds: 6,
            /* The lagoon course. */
            setup: `await pickStage(1);`,
            cam: `(t, f) => ({ eye: course(0.15 + t * 0.06, f, 0.08), at: course(0.25 + t * 0.06, f, 0) })`,
        },
    ],
    topskatr: [
        {
            name: 'easy', seconds: 6,
            /* The Easy course. */
            setup: `await pickStage(1);`,
            cam: `(t, f) => ({ eye: course(0.15 + t * 0.06, f, 0.04), at: course(0.25 + t * 0.06, f, 0) })`,
        },
        {
            name: 'hidden', seconds: 6,
            /* Indoors on the Hidden course. */
            setup: `await pickStage(2);`,
            cam: `(t, f) => ({ eye: course(0.15 + t * 0.03, f, 0.04), at: course(0.25 + t * 0.03, f, 0) })`,
        },
    ],
    /* Behind Enemy Lines' soldiers on their own rigs. */
    bel: [
        {
            name: 'run', seconds: 6,
            /* A soldier running. */
            setup: `await pickTab('anim'); await pickChar(1); await pickChar(0);
                check('#char-skel', false); await pickMotion(5);`,
            cam: `(t, f) => { const c = track();
                return { eye: [c[0] + f.r * 1.3 * Math.sin(t * 0.8), c[1] + f.r * 0.1, c[2] + f.r * 1.3 * Math.cos(t * 0.8)],
                         at: [c[0], c[1] + f.r * 0.05, c[2]] }; }`,
        },
        {
            name: 'soldier', seconds: 6,
            /* The same soldier hit and going down. */
            setup: `await pickTab('anim'); await pickChar(1); await pickChar(0);
                check('#char-skel', false); await pickMotion(1);`,
            cam: `(t, f) => { const c = track();
                return { eye: [c[0] + f.r * 1.3 * Math.sin(t * 0.8), c[1] + f.r * 0.1, c[2] + f.r * 1.3 * Math.cos(t * 0.8)],
                         at: [c[0], c[1] + f.r * 0.05, c[2]] }; }`,
        },
    ],
    desert: [
        {
            name: 'desert', seconds: 6,
            /* Across the open desert. */
            setup: `await pickStage(0);`,
            cam: `(t, f) => ({ eye: course(0.15 + t * 0.06, f, 0.12), at: course(0.25 + t * 0.06, f, 0) })`,
        },
        {
            name: 'canyon', seconds: 6,
            /* Through the canyon. */
            setup: `await pickStage(1);`,
            cam: `(t, f) => ({ eye: course(0.15 + t * 0.06, f, 0.12), at: course(0.25 + t * 0.06, f, 0) })`,
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
const build = opt('--build');
const only = opt('--only');
const list = flag('--list');
const gpu = flag('--gpu');
const stills = flag('--stills');
const models = opt('--models');
const OUT = path.resolve(opt('--out') ?? (process.env.STF_SITE
    ? path.join(ROOT, 'media/previews') : path.join(os.tmpdir(), 'stf-previews')));
const zips = argv.map((z) => path.resolve(z));
if (!game || !zips.length || (!list && !stills && !SHOTS[game])) {
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
    /* --gpu draws on the real card through Mesa's D3D12 driver under WSL, far
     * faster than SwiftShader; it needs GALLIUM_DRIVER=d3d12 and
     * LD_LIBRARY_PATH=/usr/lib/wsl/lib in the environment. */
    args: gpu ? ['--ignore-gpu-blocklist', '--use-angle=gl', '--no-sandbox']
        : ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H });
page.on('pageerror', (e) => console.error('page:', e.stack ?? e.message));

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

/* A merged archive loads as one build and offers the rest in the panel's Build
 * picker: --build swaps to another, the way a visitor would. The clock is still
 * free here, so the reload paints and finishes on its own. */
if (build) {
    const ok = await page.evaluate((id) => {
        const sel = document.querySelector('#build-select');
        if (![...sel.options].some((o) => o.value === id)) return [...sel.options].map((o) => o.value).join(', ');
        sel.value = id; sel.dispatchEvent(new Event('change'));
        return true;
    }, build);
    if (ok !== true) { console.error(`no build ${build} in this set (${ok || 'it has one'})`); process.exit(1); }
    await page.waitForFunction((id) => window.stf.rom?.game.id === id && document.querySelector('#loader').hidden
        && window.stf.stages.length, { timeout: 300000 }, build);
}

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
        /* A view of the stage, by its value (Power Sled's `zone:2`): one
         * with a camera of its own frames it. */
        pickView: (v) => select('#view-select', v),
        pickChar: (i) => select('#char-select', i),
        /* A model in the Models tab by its table index, for a game with no
         * stages to fly; `set` picks a texture set where the tab offers one. */
        pickModel: async (i, set) => {
            await pickTab('model');
            if (set !== undefined) await select('#model-texset', set);
            const n = $('#model-search'); n.value = String(i); n.dispatchEvent(new Event('input'));
            await tick();
        },
        /* By position in the list, or by a pattern on the option's text: the
         * list opens with the fighter's moves, so a position shifts whenever
         * what is listed above it does. */
        pickMotion: (which) => {
            const opts = [...$('#motion-select').options];
            const o = typeof which === 'number' ? opts[which] : opts.find((x) => which.test(x.textContent));
            if (!o) throw new Error(`no motion ${which}`);
            return select('#motion-select', o.value);
        },
        /* The sphere a stage view's own camera frames (Power Sled's
         * scenes): its centre where the camera looks, and its radius from
         * how far back the camera stands. */
        viewFrame: (v) => {
            const { eye, at } = window.stf.stages[window.stf.stageIndex].cameras[v];
            return { c: at, r: Math.hypot(eye[0] - at[0], eye[1] - at[1], eye[2] - at[2]) / 2 };
        },
        ring: (f, a, d, h) => [f.c[0] + f.r * d * Math.sin(a), f.c[1] + f.r * h, f.c[2] + f.r * d * Math.cos(a)],
        /* The stage's rail camera at count n, between the counts either side
         * of it, held at the rail's end. */
        rail: (n) => {
            const r = window.stf.stages[window.stf.stageIndex].railPath;
            const i = Math.min(Math.floor(n), r.count - 2), u = Math.min(n - i, 1);
            const a = r.at(i), b = r.at(i + 1);
            const mix = (p, q) => p.map((x, k) => x + (q[k] - x) * u);
            return { eye: mix(a.eye, b.eye), at: mix(a.at, b.at) };
        },
        /* A point on a path through the stage's geometry at u (0..1), for a
         * course too long and thin to circle: the drawn vertices cut into
         * slices along the stage's longest level axis, each slice's median
         * point, smoothed. Built once per stage. `lift` raises it by that
         * much of the framed radius. */
        course: (u, f, lift = 0) => {
            const st = window.stf.stages[window.stf.stageIndex];
            if (window.__course?.stage !== st) {
                const pts = [];
                const v = new window.stf.viewer.camera.position.constructor();
                window.stf.viewer.scene.traverse((o) => {
                    if (!o.isMesh || !o.visible || !o.geometry?.attributes?.position) return;
                    const a = o.geometry.attributes.position;
                    o.updateWorldMatrix(true, false);
                    for (let i = 0; i < a.count; i += 3) {
                        v.fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld);
                        pts.push([v.x, v.y, v.z]);
                    }
                });
                const span = (k) => { let lo = Infinity, hi = -Infinity; for (const p of pts) { lo = Math.min(lo, p[k]); hi = Math.max(hi, p[k]); } return [lo, hi]; };
                const sx = span(0), sz = span(2);
                const k = sx[1] - sx[0] >= sz[1] - sz[0] ? 0 : 2, [lo, hi] = k ? sz : sx;
                const N = 48, bins = Array.from({ length: N }, () => []);
                for (const p of pts) bins[Math.min(N - 1, Math.floor((p[k] - lo) / (hi - lo) * N))].push(p);
                const med = (b, j) => b.map((p) => p[j]).sort((x, y) => x - y)[b.length >> 1];
                let path = bins.filter((b) => b.length > 8).map((b) => [0, 1, 2].map((j) => med(b, j)));
                for (let pass = 0; pass < 3; pass++)
                    path = path.map((p, i) => p.map((x, j) => (path[Math.max(0, i - 1)][j] + x * 2 + path[Math.min(path.length - 1, i + 1)][j]) / 4));
                window.__course = { stage: st, path };
            }
            const path = window.__course.path, s = Math.max(0, Math.min(1, u)) * (path.length - 1);
            const i = Math.min(Math.floor(s), path.length - 2), w = s - i;
            const p = path[i].map((x, j) => x + (path[i + 1][j] - x) * w);
            p[1] += f.r * lift;
            return p;
        },
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
    /* --models A-B: the models in that range instead, each named with its
     * face count, for a game whose only tab is Models. A-B/S takes every
     * S-th, to skim a big table. */
    if (models) {
        const [range, step] = models.split('/');
        const [lo, hi] = range.split('-').map(Number);
        for (let i = lo; i <= (hi ?? lo); i += Number(step ?? 1)) {
            const got = await page.evaluate(async (i) => {
                await pickModel(i); window.__clock.step(1000 / 30);
                const faces = +($('#model-info').textContent.match(/(\d+) faces/)?.[1] ?? 0);
                return faces && [faces, window.stf.viewer.canvas.toDataURL('image/jpeg', 0.8).split(',')[1]];
            }, i);
            if (got) fs.writeFileSync(`${dir}/${game}-m${String(i).padStart(5, '0')}-f${got[0]}.jpg`, Buffer.from(got[1], 'base64'));
        }
        console.log(`stills in ${dir}`);
        await browser.close(); server.close();
        process.exit(0);
    }
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
            /* The pose first, then the camera on it, then the picture drawn
             * again at the same instant: a camera placed ahead of the step
             * tracks the last frame's pose, a whole move behind where a
             * motion snaps back to its start. */
            if (t > 0) window.__clock.step(1000 / 30);
            const { eye, at } = eval(src)(t, window.__frame);
            v.camera.position.set(...eye);
            v.camera.lookAt(...at);
            v.frameFar();
            window.__clock.step(0);
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
