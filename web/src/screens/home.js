// Home: the landing, told like a film. There is no stock footage: the "camera" is the real G1
// from physics/ (MuJoCo + three.js), fixed behind the page, and scrolling directs it from shot to
// shot (a close-up, the walk, the training, the legs). Over it, chapters named after the parts of
// the product (Capture, Gym, Policy) bring in the rest of the real material: the source video, the
// PoseClip skeleton from data/ and the training log of training/.
import Lenis from 'lenis';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import * as THREE from 'three';
import '../landing/landing.css';
import { loader } from '../loader.js';
import { dressCity } from '../landing/city.js';
import { dressTelemetry } from '../landing/telemetry.js';
import { savedMotion } from '../motions.js';
import { FINAL_LEVEL, policyUrls } from '../policies.js';
import { PUSH_N as STANDING_PUSH_N, pushWhenReady } from '../push.js';
// The walk being trained (training/): its step count feeds the roadmap, so the page follows the
// training without anyone editing it. Optional: the build works without the file.
const walkPolicy = Object.values(import.meta.glob('../../../training/policies/g1-walk.json', { eager: true, import: 'default' }))[0] ?? null;
import { fetchClip, preloaded } from '../preloaded.js';
import { LOGO, WORDMARK } from '../brand.js';
import { createPushArrow } from '../push-arrow.js';
import { attachRobot, onRobotProgress, robotView } from '../robot-host.js';
import { prefetch } from '../router.js';
import { SkeletonView } from '../skeleton.js';
import { fmt, fmtInt, lang, langSwitch, onLang } from '../i18n.js';
import { A, T } from '../landing/strings.js';
import { createPoseDrawing, VIDEOS } from '../video-overlay.js';

gsap.registerPlugin(ScrollTrigger);

export const title = '';

const REPO = 'https://github.com/Torpass/tridi';
// The walk of Capture: the clip extracted from this very video (data/samples/mixkit-4855.mp4,
// re-encoded small into public/media). Clip and video start together and last the same 11.8 s.
// Capture 2.0's walk (GVHMR, data/capture2): the same Mixkit video and frames as the MediaPipe one it
// replaces, so the robot, the 3D skeleton and the video stay in step. Its RobotMotion is saved in
// physics/motions, so it starts at once.
const WALK = preloaded.find((item) => item.clip === 'clip_caminar-perfil-gvhmr');
const MEDIA = `${import.meta.env.BASE_URL}media/`;
const WALK_VIDEO = `${MEDIA}caminar.mp4`;
const PUSH_N = 250; // physics/ pushes with 250 N for 0.1 s (physics/README.md)
const FALLEN_PELVIS_M = 0.45; // the standing G1 has its pelvis at 0.78 m
const GYM_PUSH_EVERY_S = 3.2; // the Gym pushes the standing robot this often, giving it time to recover its stance
// The first push comes sooner, so a stage shows itself while its stop holds the scroll; never
// before 2 s, the earliest training ever pushes (training/env.py PUSH_EVERY_S): earlier is outside
// what the policies learned, and "Estable" could fall.
const GYM_FIRST_PUSH_S = 2.0;
const GYM_RESTART_S = 1.6; // a fallen robot lies this long before it is stood up again
const AFTER_PUSH_S = 5; // after a push in the hero, the robot stands this long before it is reset
// The Gym in four stops of the real training (stand-300m, training/README.md), each a saved
// checkpoint with what training.evaluate measured for it: seconds standing (of 20) and 250 N
// pushes held (of 4).
const GYM_STAGES = [
  { level: 'g1-stand-step-0', steps: 0, label: '0', up: 1.1, pushes: 0, maxN: 0 },
  { level: 'g1-stand-step-10000000', steps: 10e6, label: '10 M', up: 11.2, pushes: 1.6, maxN: 200 },
  { level: 'g1-stand-step-100000000', steps: 100e6, label: '100 M', up: 20, pushes: 4, maxN: 350 },
  { level: 'g1-stand', steps: 300e6, label: '300 M', up: 20, pushes: 4, maxN: 500 },
];
// The policy decides 50 times a second (training/README.md), for the simulation's readout.
const DECISIONS_PER_S = 50;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
// The film fills the whole screen, so on a retina screen a pixel ratio of 2 drew four times the
// pixels of 1: 1.5 keeps the robot sharp and draws 44 % fewer pixels than 2, every frame.
const FILM_PIXEL_RATIO = 1.5;
const narrow = () => innerWidth < 860;

// The shots. The camera orbits the robot's pelvis: azimuth 0 looks at the robot from the front
// (MuJoCo +x), elevation lifts it, distance in meters, aim is the height it looks at, and shift
// slides the robot across the frame (a share of the width, + to the right) to leave room for words.
// follow is how many seconds the camera takes to catch up with the pelvis (physics/ viewer
// followTau): a still frame instead of the street sliding with every small step; the walk keeps a
// short one so the robot stays in frame. Resets and clip loops still cut (the viewer snaps them).
// Capture looks from the robot's right (az -90): the walk is turned to head +x (faceForward), so
// it is the side the phone filmed, the robot walks the same way as the video, and the far arm is
// the one behind the body. Policy shows the whole robot the network moves, slightly from above.
const SHOTS = {
  hero: { az: 22, el: 3, dist: 1.35, aim: 1.08, shift: 0.2, follow: 0.5 },
  capture: { az: -90, el: 6, dist: 3.3, aim: 0.8, shift: 0.24, follow: 0.15 },
  gym: { az: 38, el: 12, dist: 3.7, aim: 0.75, shift: 0.2, follow: 1 },
  policy: { az: 60, el: 15, dist: 3.3, aim: 0.72, shift: -0.24, follow: 1.5 },
  close: { az: 140, el: 16, dist: 6.5, aim: 0.8, shift: 0, follow: 1.5 },
};
// On phones the words sit low: no sideways shift, farther away, and aimed below the robot so it
// stands in the upper half of the screen.
const narrowShot = (shot) => ({ ...shot, shift: 0, dist: shot.dist * 1.6, aim: shot.aim - 0.4 });

// "3,6 de 4" / "3.6 of 4": pushes held, in the language's own decimal mark.
const T_OF = (n, l) => (l === 'en' ? `${fmt(n, n % 1 ? 1 : 0)(l)} of 4` : `${fmt(n, n % 1 ? 1 : 0)(l)} de 4`);

export function mount(root) {
  document.documentElement.classList.add('is-landing');
  root.innerHTML = `
  <div class="landing">
    <div class="film" aria-hidden="true">
      <div class="boot">
        ${loader('small')}
        <p>mujoco.wasm <b class="boot-files">0/39</b></p>
        <p class="boot-line">${T('boot.world')}</p>
        <div class="boot-track"><i class="boot-bar"></i></div>
      </div>
    </div>
    <div class="film-hud">
      <i class="corner tl" aria-hidden="true"></i><i class="corner tr" aria-hidden="true"></i><i class="corner bl" aria-hidden="true"></i><i class="corner br" aria-hidden="true"></i>
      <div class="sim-readout">
        <span data-sim="rates">MuJoCo</span><span>t <b data-sim="time">0,0</b> s</span><span>${T('sim.contacts')} <b data-sim="contacts">0</b></span>
        <button type="button" class="sim-info-btn" aria-label="Info">ⓘ<span class="sim-tooltip" role="tooltip">${T('sim.info')}</span></button>
      </div>
    </div>
    <div class="film-shade" aria-hidden="true"></div>
    <div class="film-wash" aria-hidden="true"></div>

    <header class="topbar">
      <a class="wordmark" href="#/" ${A({ 'aria-label': 'nav.home' })}>${LOGO}${WORDMARK}</a>
      <nav class="topnav" ${A({ 'aria-label': 'nav.product' })}>
        <a href="#capture">Capture</a>
        <a href="#gym">Gym</a>
        <a href="#policy">Policy</a>
        <a href="#/simulations" data-warm="simulations">${T('nav.simulations')}</a>
        <a href="#/milestones" data-warm="milestones">${T('nav.milestones')}</a>
      </nav>
      ${langSwitch()}
      <a class="btn btn-signal btn-small" href="#try"><span class="only-wide">${T('nav.tryLive')}</span><span class="only-narrow">${T('nav.try')}</span></a>
    </header>

    <section class="chapter hero" id="home" data-shot="hero" data-mode="stand">
      <div class="hero-live"><i class="live-dot"></i>${T('hero.live')}</div>
      <div class="caption hero-caption">
        <h1>${T('hero.title')}</h1>
        <p class="hero-lede"><span class="only-wide">${T('hero.lede')}</span><span class="only-narrow">${T('hero.ledeShort')}</span></p>
        <ol class="hero-steps" ${A({ 'aria-label': 'hero.how' })}>
          <li><b>01</b><span class="only-wide">${T('hero.step1')}</span><span class="only-narrow">${T('hero.step1Short')}</span></li>
          <li><b>02</b>${T('hero.step2')}</li>
          <li><b>03</b><span class="only-wide">${T('hero.step3')}</span><span class="only-narrow">${T('hero.step3Short')}</span></li>
        </ol>
        <div class="cta-row">
          <button class="btn btn-signal hero-push" type="button" disabled>${T('hero.push')} <kbd>${T('key.space')}</kbd></button>
          <a class="btn btn-ghost" href="#capture">${T('hero.howLink')}</a>
        </div>
      </div>
      <div class="hud">
        <p class="state" data-state="stand"><i></i><span>${T('hud.stand')}</span></p>
        <p class="tally">${T('hud.tally', { pushes: '<span data-hud="pushes">0</span>', falls: '<span data-hud="falls">0</span>' })}</p>
      </div>
      <div class="scroll-cue" aria-hidden="true"><span></span></div>
    </section>

    <section class="chapter capture" id="capture" data-shot="capture" data-mode="walk">
      <div class="sticky">
        <div class="capture-media">
          <figure class="frame frame-video">
            <video class="walk-video" src="${WALK_VIDEO}" muted playsinline loop preload="auto"></video>
            <canvas class="walk-overlay" aria-hidden="true"></canvas>
          </figure>
          <figure class="frame frame-skeleton">
            <canvas class="skeleton-canvas"></canvas>
          </figure>
        </div>
        <div class="caption capture-caption panel">
          <p class="product">Tridi Capture</p>
          <h2><span class="only-wide">${T('capture.title')}</span><span class="only-narrow">${T('capture.titleShort')}</span></h2>
          <p><span class="only-wide">${T('capture.text')}</span><span class="only-narrow">${T('capture.textShort')}</span></p>
        </div>
      </div>
    </section>

    <section class="chapter gym" id="gym" data-shot="gym" data-mode="gym" data-hold="0.8">
      <div class="sticky">
        <div class="caption gym-caption panel">
          <p class="product">Tridi Gym</p>
          <h2>${T('gym.title')}</h2>
          <p class="gym-lede"><span class="only-wide">${T('gym.lede')}</span><span class="only-narrow">${T('gym.ledeShort')}</span></p>
          <div class="steps-meter">
            <p class="steps-now"><b data-gym="steps">0</b><span>${T('gym.stepsLabel')}</span></p>
            <div class="steps-axis">
              <div class="axis-track" aria-hidden="true">
                <i class="axis-line"><i class="axis-fill"></i></i>
                ${GYM_STAGES.map((stage) => `<i class="axis-tick" style="--at: ${(100 * stage.steps) / GYM_STAGES.at(-1).steps}%"></i>`).join('')}
              </div>
              <div class="axis-stops" role="group" ${A({ 'aria-label': 'gym.stages' })}>
              ${GYM_STAGES.map((stage, i) => `
                <button class="axis-stop" type="button" data-stage="${i}" style="--at: ${(100 * stage.steps) / GYM_STAGES.at(-1).steps}%">
                  <span class="axis-label">${T('gym.stepsAt', { n: stage.label })}</span>
                  <span class="axis-verdict">${T(`stage.${i}.verdict`)}</span>
                </button>`).join('')}
              </div>
            </div>
            <div class="stage-detail">
              <span class="stage-text" data-gym="text"></span>
              <span class="stage-numbers" data-gym="numbers"></span>
            </div>
          </div>
          <p class="gym-status"><i class="live-dot"></i><span><span data-gym="up">—</span> ${T('gym.standing')} · <span data-gym="status">${T('gym.live')}</span></span></p>
          <div class="gym-controls">
            <button class="btn btn-signal btn-small gym-push" type="button" disabled>${T('hero.push')} <kbd>${T('key.space')}</kbd></button>
            <label class="gym-force">
              <span class="gym-force-head"><span>${T('gym.force')}</span><b data-gym="force">${PUSH_N} N</b></span>
              <div class="gym-force-track">
                <i class="gym-force-zone" data-gym="force-zone"></i>
                <input type="range" class="gym-force-slider" min="50" max="500" step="50" value="${PUSH_N}" />
              </div>
              <span class="gym-force-cap" data-gym="force-cap"></span>
            </label>
          </div>
          <p class="gym-hint">${T('gym.hint')}</p>
        </div>
      </div>
    </section>

    <section class="chapter policy" id="policy" data-shot="policy" data-mode="stand" data-rest="0.6">
      <div class="sticky">
        <div class="caption policy-caption panel">
          <p class="product">Tridi Policy</p>
          <h2><span class="only-wide">${T('policy.title')}</span><span class="only-narrow">${T('policy.titleShort')}</span></h2>
          <p class="policy-lede">${T('policy.lede')}</p>
          <ul class="specs">
            <li><b>150–500 KB</b><span><span class="only-wide">${T('policy.size')}</span><span class="only-narrow">${T('policy.sizeShort')}</span></span></li>
            <li><b>19–51 DOF</b><span><span class="only-wide">${T('policy.motors')}</span><span class="only-narrow">${T('policy.motorsShort')}</span></span></li>
            <li><b>50–250 Hz</b><span><span class="only-wide">${T('policy.rate')}</span><span class="only-narrow">${T('policy.rateShort')}</span></span></li>
            <li><b>&lt; 0.5 ms</b><span><span class="only-wide">${T('policy.latency')}</span><span class="only-narrow">${T('policy.latencyShort')}</span></span></li>
          </ul>
          <p class="policy-note">${T('policy.note')}</p>
          <a class="btn btn-signal btn-small policy-data" href="#/delivery" data-warm="delivery">${T('policy.cta')}</a>
        </div>
      </div>
    </section>

    <nav class="phone-arrows" ${A({ 'aria-label': 'arrows.label' })}>
      <button type="button" class="arrow-up" ${A({ 'aria-label': 'arrows.up' })}>↑</button>
      <button type="button" class="arrow-down" ${A({ 'aria-label': 'arrows.down' })}>↓</button>
    </nav>

    <section class="chapter closing" id="teams" data-shot="close" data-mode="stand">
      <div class="closing-sticky">
        <div class="closing-inner" id="try" data-offset="-112">
          <h2 class="manifesto">${T('close.manifesto')}</h2>
          <p class="closing-text">${T('close.text')}</p>
          <nav class="tries" ${A({ 'aria-label': 'close.tries' })}>
            <a class="try" href="#/simulations" data-warm="simulations">
              <svg class="try-icon" viewBox="0 0 48 48" aria-hidden="true"><path d="M24 6l16 9v18l-16 9-16-9V15z"/><path d="M8 15l16 9 16-9M24 24v18"/></svg>
              <b><span class="only-wide">${T('try.sims')}</span><span class="only-narrow">${T('try.simsShort')}</span></b>
              <span class="try-sub only-narrow">${T('try.simsSub')}</span>
              <span class="try-go">${T('try.simsGo')}</span>
            </a>
            <a class="try" href="#/live" data-warm="live">
              <svg class="try-icon" viewBox="0 0 48 48" aria-hidden="true"><rect x="6" y="14" width="28" height="20" rx="3"/><path d="M34 21l9-5v16l-9-5z"/><circle cx="20" cy="24" r="5"/></svg>
              <b><span class="only-wide">${T('try.live')}</span><span class="only-narrow">${T('try.liveShort')}</span></b>
              <span class="try-sub only-narrow">${T('try.live')}</span>
              <span class="try-go">${T('try.liveGo')}</span>
            </a>
            <a class="try" href="#/upload" data-warm="upload">
              <svg class="try-icon" viewBox="0 0 48 48" aria-hidden="true"><rect x="6" y="10" width="36" height="26" rx="3"/><path d="M24 31V17M18 22l6-6 6 6"/><path d="M14 40h20"/></svg>
              <b><span class="only-wide">${T('try.upload')}</span><span class="only-narrow">${T('try.uploadShort')}</span></b>
              <span class="try-sub only-narrow">${T('try.uploadSub')}</span>
              <span class="try-go">${T('try.uploadGo')}</span>
            </a>
            <a class="try" href="#/delivery" data-warm="delivery">
              <svg class="try-icon" viewBox="0 0 48 48" aria-hidden="true"><rect x="8" y="16" width="32" height="24" rx="2"/><path d="M8 24h32M24 6v14M18 14l6 6 6-6"/></svg>
              <b><span class="only-wide">${T('try.delivery')}</span><span class="only-narrow">${T('try.deliveryShort')}</span></b>
              <span class="try-sub only-narrow">${T('try.deliverySub')}</span>
              <span class="try-go">${T('try.deliveryGo')}</span>
            </a>
          </nav>
        </div>
      </div>
      <footer class="footer">
        <div class="foot-row">
          <span class="wordmark big" aria-label="Tridi">${LOGO}${WORDMARK}</span>
          <dl class="foot-specs">
            <div><dt>${T('foot.madeAt')}</dt><dd>Platanus Hack 26, Caracas</dd></div>
            <div><dt>${T('foot.robot')}</dt><dd>Unitree G1 · Unitree H1 · Luigi Lab 3 (Sim-to-Real)</dd></div>
            <div><dt>${T('foot.milestones')}</dt><dd><a href="#/milestones" data-warm="milestones">${T('foot.milestonesLink')}</a></dd></div>
            <div><dt>${T('foot.code')}</dt><dd><a href="${REPO}" target="_blank" rel="noopener">${T('foot.repo')}</a></dd></div>
          </dl>
        </div>
      </footer>
    </section>
  </div>`;

  const $ = (selector) => root.querySelector(selector);
  const $$ = (selector) => [...root.querySelectorAll(selector)];
  let gone = false;
  const cleanups = [];
  const on = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    cleanups.push(() => target.removeEventListener(type, fn, options));
  };

  // ---- Smooth scroll, and GSAP's scroll triggers driven by it ----
  // gymGate (Gym, below) sees every wheel step first, so a fast scroll stops at each stage.
  // lerp 0.15 settles a wheel step in about a quarter of a second: 0.09 glided for twice that and
  // the page felt heavy.
  const lenis = reducedMotion ? null : new Lenis({ lerp: 0.15, virtualScroll: (data) => gymGate(data) });
  const tick = (time) => lenis?.raf(time * 1000);
  if (lenis) {
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
  }
  // A target's page position, moved by its data-offset (px): "#try" lands below the top bar.
  const anchorTop = (target) => target.getBoundingClientRect().top + scrollY + Number(target.dataset.offset ?? 0);
  const navFlight = { until: 0, chapter: null };
  const scrollTo = (target) => {
    const destChapter = target.closest?.('.chapter') ?? null;
    if (destChapter) {
      navFlight.until = performance.now() + 1650;
      navFlight.chapter = destChapter;
    }
    return lenis ? lenis.scrollTo(anchorTop(target), { duration: 1.6 }) : window.scrollTo({ top: anchorTop(target) });
  };
  on(window, 'wheel', () => (navFlight.until = 0), { passive: true });
  on(window, 'touchstart', () => (navFlight.until = 0), { passive: true });
  const probar = $('#try');

  for (const link of $$('[data-warm]')) {
    const warm = () => prefetch(link.dataset.warm);
    link.addEventListener('pointerenter', warm, { once: true });
    link.addEventListener('focus', warm, { once: true });
  }
  for (const link of $$('a[href^="#"]:not([href^="#/"])')) {
    on(link, 'click', (event) => {
      event.preventDefault();
      const target = root.querySelector(link.getAttribute('href'));
      if (target) scrollTo(target);
    });
  }

  // ---- The film: the one robot, behind everything ----
  const film = $('.film');
  cleanups.push(
    onRobotProgress(({ done, total, compiling, policy }) => {
      $('.boot-files').textContent = `${done}/${total}`;
      $('.boot-bar').style.width = `${(100 * done) / total}%`;
      $('.boot-line').innerHTML = T(policy ? 'boot.policy' : compiling ? 'boot.compiling' : 'boot.world');
    }),
  );
  if (robotView()) film.classList.add('ready');
  const robot = attachRobot(film);
  let view = null;
  let saved = null; // the viewer's camera as the app screens expect it, put back on unmount
  let lights = []; // the landing's extra lights
  let key = null; // the one of them that rides with the camera
  let undressCity = () => {}; // takes the street, the sky and the buildings out again
  let telemetry = null; // the physics drawn into the scene (landing/telemetry.js)

  // The camera eases toward the shot of the chapter on screen, blending between neighbours.
  const shot = { ...SHOTS.hero };
  const chapters = $$('.chapter');
  // Where the chapters and the Gym's stages are, measured once and again on resize (measure(),
  // below). Reading offsetTop every frame made the browser lay the page out again every frame,
  // right after GSAP and the wash had written their styles.
  const layout = { tops: [], gymTop: 0, gymStep: 1 };
  const chapterAt = (y) => chapters[layout.tops.findLastIndex((top) => top <= y)] ?? chapters[0];
  function targetShot() {
    if (navFlight.chapter && performance.now() < navFlight.until) {
      const dest = SHOTS[navFlight.chapter.dataset.shot] ?? SHOTS.close;
      return narrow() ? narrowShot(dest) : dest;
    }
    const mid = scrollY + innerHeight * 0.5;
    let from = chapters[0];
    let to = chapters[0];
    let t = 0;
    for (let i = 0; i < chapters.length; i++) {
      const top = layout.tops[i];
      const next = layout.tops[i + 1] ?? Infinity;
      if (mid >= top && mid < next) {
        from = chapters[i];
        to = chapters[i + 1] ?? chapters[i];
        // Hold the chapter's shot for most of it, and move to the next one in its last stretch.
        // The Gym holds it longer (data-hold): its last stage sits at 75 % of the chapter.
        const span = next - top;
        const hold = Number(chapters[i].dataset.hold ?? 0.7);
        t = Math.min(1, Math.max(0, ((mid - top) / span - hold) / (1 - hold)));
        break;
      }
    }
    const a = SHOTS[from.dataset.shot];
    const b = SHOTS[to.dataset.shot];
    const s = t * t * (3 - 2 * t);
    const blend = Object.fromEntries(Object.keys(a).map((k) => [k, a[k] + (b[k] - a[k]) * s]));
    return narrow() ? narrowShot(blend) : blend;
  }

  // Click-and-drag camera orbiting on the landing background so the user can rotate around the robot.
  const userOrbit = { az: 0, el: 0, dragging: false, lastX: 0, lastY: 0 };
  on(window, 'pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest?.('a, button, input, select, label, video, .panel, .topbar, .try, .sim-readout, .phone-arrows')) return;
    userOrbit.dragging = true;
    userOrbit.lastX = e.clientX;
    userOrbit.lastY = e.clientY;
    document.body.style.cursor = 'grabbing';
  });
  on(window, 'pointermove', (e) => {
    if (!userOrbit.dragging) return;
    const dx = e.clientX - userOrbit.lastX;
    const dy = e.clientY - userOrbit.lastY;
    userOrbit.lastX = e.clientX;
    userOrbit.lastY = e.clientY;
    userOrbit.az -= dx * 0.35;
    userOrbit.el = Math.max(-10, Math.min(28, userOrbit.el + dy * 0.22));
  });
  const endOrbitDrag = () => {
    if (!userOrbit.dragging) return;
    userOrbit.dragging = false;
    document.body.style.cursor = '';
  };
  on(window, 'pointerup', endOrbitDrag);
  on(window, 'pointercancel', endOrbitDrag);

  function directCamera(v) {
    const goal = targetShot();
    const k = reducedMotion ? 1 : 0.06;
    for (const key of Object.keys(shot)) shot[key] += (goal[key] - shot[key]) * k;
    v.viewer.followTau = reducedMotion ? 0 : shot.follow;
    const { camera, controls } = v.viewer;
    const az = ((shot.az + userOrbit.az) * Math.PI) / 180;
    const el = (Math.max(-5, Math.min(42, shot.el + userOrbit.el)) * Math.PI) / 180;
    // The camera is level and the picture is shifted instead (an architect's shift lens): a camera
    // tilted down to the aim made every vertical away from the image's center lean, and with the
    // robot slid to the side for the words (shift) and running ahead of the camera in the walk, the
    // robot leaned visibly at the end of Capture, where the shot rises toward the Gym's.
    const height = shot.aim + Math.sin(el) * shot.dist;
    v.viewer.targetHeight = height;
    controls.maxPolarAngle = Math.PI / 2; // OrbitControls would lift a level camera off its height
    const { x, z } = controls.target;
    camera.position.set(x + Math.cos(az) * Math.cos(el) * shot.dist, height, z - Math.sin(az) * Math.cos(el) * shot.dist);
    // Slide the image sideways (three.js film offset), so the robot stands where the words are not.
    const filmWidth = camera.filmGauge * Math.min(camera.aspect, 1);
    camera.filmOffset = -shot.shift * camera.aspect * 2 * Math.tan((camera.fov * Math.PI) / 360) * filmWidth;
    camera.updateProjectionMatrix();
    // And up, so the aim (el degrees below the level line of sight) sits at the image's center as
    // the tilted camera had it: the projection's vertical offset, in units of the image's half height.
    const m = camera.projectionMatrix.elements;
    m[9] = -m[5] * Math.tan(el);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    key?.position.copy(camera.position).add(KEY_LIFT);
  }
  const KEY_LIFT = new THREE.Vector3(0, 0.8, 0); // the key light sits a little above the lens

  // ---- The push, drawn in the robot's scene: the arrow from where the shove comes
  // (push-arrow.js), and the Gym's test ring on the floor around the robot it trains ----
  const SIGNAL = 0xc8ff2e; // --signal in style.css
  const RING_M = 1.2; // a fall of the G1 reaches about this far from where it stood
  let marks = null; // { arrow, ring, ringMaterial }
  function makeMarks(scene) {
    // The ring: a circle with a tick every 15°, flat on the sidewalk.
    const ringMaterial = new THREE.MeshBasicMaterial({ color: SIGNAL, transparent: true, opacity: 0, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    const ring = new THREE.Group();
    ring.add(new THREE.Mesh(new THREE.RingGeometry(RING_M - 0.015, RING_M + 0.015, 128), ringMaterial));
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * 2 * Math.PI;
      const length = k % 6 ? 0.06 : 0.16;
      const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.02, length), ringMaterial);
      tick.position.set(Math.cos(a) * (RING_M + 0.03 + length / 2), Math.sin(a) * (RING_M + 0.03 + length / 2), 0);
      tick.rotation.z = a - Math.PI / 2;
      ring.add(tick);
    }
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.006;
    ring.visible = false;
    scene.add(ring);
    return { arrow: createPushArrow(scene), ring, ringMaterial };
  }
  // Right after view.push(). Smaller in the hero, whose camera stands 1.35 m from the robot
  // instead of 3.7 m.
  function drawPush(newtons = PUSH_N) {
    if (marks && view) marks.arrow.point(view, (mode === 'gym' ? 1 : 0.6) * Math.max(0.5, Math.min(1.5, newtons / PUSH_N)));
  }
  function updateMarks() {
    if (!marks) return;
    marks.arrow.update();
    const goal = mode === 'gym' ? 0.6 : 0;
    const ring = marks.ringMaterial;
    ring.opacity += (goal - ring.opacity) * (reducedMotion ? 1 : 0.08);
    marks.ring.visible = ring.opacity > 0.01;
  }

  // ---- What the robot does in each chapter ----
  let level = null; // checked against view.sim.policy.id so returning from another robot always reloads G1
  let queue = Promise.resolve();
  function useLevel(id) {
    queue = queue
      .then(async () => {
        if (gone || !view || (level === id && view.sim?.policy?.id === id && view.sim?.policy?.robot === 'unitree_g1')) return;
        const wasNonG1 = view.sim?.policy?.robot && view.sim.policy.robot !== 'unitree_g1';
        const { onnx, json } = policyUrls(id);
        await view.loadPolicy(onnx, json);
        if (wasNonG1 && view.sim) {
          const [px, py] = view.sim.bodyPosition('pelvis');
          view.viewer.controls.target.set(px, view.viewer.targetHeight, -py);
        }
        level = id;
      })
      .catch((error) => console.error(error));
    return queue;
  }
  // The walk of Capture, turned to start facing +x like the standing robot (faceForward), so the
  // walk begins without the robot snapping 90°.
  const walkMotion = WALK ? savedMotion(WALK.clip).then((motion) => motion && faceForward(motion)) : Promise.resolve(null);
  let mode = null; // 'stand' | 'walk' | 'gym'
  let modeToken = 0;
  async function setMode(next) {
    if (!view || mode === next) return;
    const [kind, wanted = FINAL_LEVEL] = next.split(':');
    const previous = mode?.split(':')[0];
    mode = next;
    const token = ++modeToken;
    Object.assign(gym, { since: 0, shownAt: 0 });
    if (kind === 'walk') {
      await useLevel(FINAL_LEVEL);
      const motion = await walkMotion;
      // From the first frame, with the video: resuming where the video was paused made the robot
      // jump along the walk (1.9 m) the moment it started. Coming back up from below, it starts
      // at the end instead and walks backward to where the story began (updateWalk).
      walk.t = walk.dir < 0 ? walkDuration() : 0;
      video.currentTime = walk.t;
      // plantFeet 'auto', as Simulations plays it: GVHMR's path already matches the stride. Forcing it
      // was for MediaPipe's walk, whose path was too short and slid the planted foot backward.
      if (token === modeToken && motion) view.playClip(motion);
    } else if (kind === 'gym') {
      await useLevel(gymLevel());
      if (token === modeToken) startGymRun();
    } else {
      await useLevel(wanted);
      // Stood back up only when it is not already standing on its own: on the first visit, after
      // the walk (a puppet) or lying on the floor. From the Gym it keeps standing, with no jump.
      const fallen = view.sim.bodyPosition('pelvis')[2] < FALLEN_PELVIS_M;
      if (token === modeToken && (previous !== 'gym' || fallen)) view.stop();
    }
  }
  const modeAt = () => {
    if (navFlight.chapter && performance.now() < navFlight.until) {
      return navFlight.chapter.dataset.mode ?? 'stand';
    }
    return chapterAt(scrollY + innerHeight * 0.5).dataset.mode ?? 'stand';
  };

  // Hero: the robot stands on its own with the trained policy; a push shows it catching itself.
  // fallenAt: when the robot was first seen on the floor (0 while standing), to stand it up again.
  const hero = { pushes: 0, falls: 0, pushedAt: 0, fallen: false, fallenAt: 0 };
  const stateEl = $('.hud .state');
  const say = (state, key, vars) => {
    stateEl.dataset.state = state;
    stateEl.querySelector('span').innerHTML = T(key, vars);
  };
  let heroTimer = 0;
  // The hero's push is the one the trained robot holds, spaced as in training (push.js); the
  // Gym's own pushes count in its spacing too (pushed.lastT).
  const pushed = { lastT: -Infinity, queued: 0 };
  function pushHero() {
    if (!view || mode !== 'stand') return;
    pushWhenReady(pushed, view, landHeroPush, () => !gone && mode === 'stand');
  }
  function landHeroPush() {
    drawPush();
    hero.pushes += 1;
    hero.pushedAt = performance.now();
    hero.fallen = false;
    $('[data-hud="pushes"]').textContent = hero.pushes;
    say('push', 'hud.push', { n: STANDING_PUSH_N });
    for (const button of $$('.hero-push')) {
      button.classList.remove('kick');
      void button.offsetWidth; // restart the animation
      button.classList.add('kick');
    }
    clearTimeout(heroTimer);
    heroTimer = setTimeout(() => {
      if (!hero.fallen) say('stand', 'hud.stand');
    }, AFTER_PUSH_S * 1000);
  }
  // A robot on the floor in the hero, whatever put it there (a push the policy missed, or the page
  // coming back to the hero with it fallen), is stood up again after GYM_RESTART_S, as in the Gym:
  // before, only a timer 5 s after the push did it, so a later fall left it lying until a reload.
  function standHeroUp(now) {
    const down = view.sim.bodyPosition('pelvis')[2] < FALLEN_PELVIS_M;
    if (!down) {
      hero.fallenAt = 0;
      return;
    }
    if (!hero.fallenAt) {
      hero.fallenAt = now;
      if (hero.pushedAt && !hero.fallen) {
        hero.fallen = true; // the policy misses some pushes (training/README.md): say so
        hero.falls += 1;
        $('[data-hud="falls"]').textContent = hero.falls;
        say('fall', 'hud.fall');
      }
    } else if (now - hero.fallenAt > GYM_RESTART_S * 1000) {
      view.reset();
      hero.fallenAt = 0;
      hero.fallen = false;
      say('stand', 'hud.stand');
    }
  }
  $$('.hero-push').forEach((button) => on(button, 'click', pushHero));
  // Space pushes the robot, as the hero's button says, wherever it stands on its own (the hero,
  // the Gym and Policy); during the walk, a puppet, it does nothing, and the closing scrolls. Enter moves the
  // film forward: it goes to the next stop (each of the Gym's checkpoints, then each chapter), and
  // after the last one the browser scrolls as usual. Space used to move the film past the hero
  // too, which read oddly next to a hero where it pushes. From where the glide under way ends, not scrollY, so presses during a glide
  // chain: Lenis 1.3 moves targetScroll along with a programmatic glide (it is the current
  // position, not the stop), so reading it mid-glide sent each press back to the same stop.
  // Enter always goes to the next stop, the hero included, so a demo can move through the film
  // fast; on phones it takes the same step as the down arrow (one chapter, or one Gym stage).
  // A push button keeps the focus after a click (Chrome on the Mac): Enter there still advances
  // instead of pressing it again; the other buttons and links keep their own Enter.
  const ENTER_GLIDE_S = 0.35; // still reads as a move to the next stop, but 1 s felt stuck
  on(window, 'keydown', (event) => {
    const enter = event.key === 'Enter';
    const own = enter ? 'input, textarea, select, button:not(.hero-push, .gym-push), a' : 'input, textarea, select, button, a';
    // Held down, Enter repeats and runs down the stops; space keeps one push per press.
    if ((event.code !== 'Space' && !enter) || (event.repeat && !enter) || event.target.closest?.(own)) return;
    if (!enter) {
      if (chapterAt(scrollY + innerHeight * 0.5) === chapters.at(-1)) return; // the closing scrolls as usual
      event.preventDefault();
      if (mode === 'gym') pushGym();
      else pushHero();
      return;
    }
    if (narrow()) {
      event.preventDefault();
      if (!event.repeat) step(1); // step reads the chapter from scrollY, which lags a held key
      return;
    }
    const from = lenis ? (lenis.animate.isRunning ? lenis.animate.to : lenis.targetScroll) : scrollY;
    const next = enterStops().find((stop) => stop > from + STOP_PX);
    if (next === undefined) return;
    event.preventDefault();
    // Enter is for moving through a demo fast: a short glide (ENTER_GLIDE_S).
    if (lenis) lenis.scrollTo(next, { duration: ENTER_GLIDE_S });
    else window.scrollTo({ top: next });
  });

  // Gym: the three stages are three screens of scroll. The chapter is four screens tall and its
  // panel sticks for three of them (landing.css .gym); the stage is the third of that stretch you
  // are in, so scrolling is what trains the robot. Each stage's middle is a stop: scrolling down,
  // a wheel or trackpad gesture, however fast, stops there instead of flying past (gymGate), and
  // keeps the scroll until that checkpoint has shown what it does (gymShown): the untrained robot
  // falls (~1,1 s), the others take their first push. Up, the top bar's links and the axis move freely.
  const gymEl = $('.gym');
  const gymPanel = gymEl.querySelector('.sticky');
  const gym = { since: 0, lastPush: 0, fallen: false, loading: false, shownAt: 0, forceN: PUSH_N };
  const forceSlider = $('.gym-force-slider');
  const forceLabel = $('[data-gym="force"]');
  if (forceSlider) {
    on(forceSlider, 'input', () => {
      gym.forceN = Number(forceSlider.value) || PUSH_N;
      if (forceLabel) forceLabel.textContent = `${gym.forceN} N`;
      shownStage = -1;
      showGymStage();
    });
  }
  const simInfoBtn = $('.sim-info-btn');
  if (simInfoBtn) {
    on(simInfoBtn, 'click', (event) => {
      event.stopPropagation();
      simInfoBtn.classList.toggle('open');
    });
    on(document, 'click', () => simInfoBtn.classList.remove('open'));
  }
  // A push by hand (space or the panel's button) on the checkpoint on screen. The Gym's own pushes
  // count from it, so two never land on top of each other.
  function pushGym() {
    if (!view || mode !== 'gym' || !gym.since || gym.fallen || gym.loading) return;
    gym.lastPush = pushed.lastT = view.sim.data.time;
    gym.shownAt ||= performance.now() + GYM_SHOWN_PUSH_S * 1000;
    view.push(undefined, gym.forceN);
    drawPush(gym.forceN);
    $('[data-gym="status"]').innerHTML = T('gym.pushed', { n: gym.forceN });
  }
  $$('.gym-push').forEach((button) => on(button, 'click', pushGym));
  const GYM_SHOWN_FALL_S = 0.4; // after a fall, a moment on the floor before the scroll is let go
  const GYM_SHOWN_PUSH_S = 0.8; // after a push, time to see it stagger and catch itself (or not)
  // A stop never keeps the scroll longer, even if a checkpoint is slow to load: longer reads as
  // stuck (2.5 s did), which is why the Gym once ran on its own clock instead of the scroll. And
  // each stop holds once per visit: coming back to a stage scrolls straight through it.
  const GYM_HOLD_MAX_S = 1.2;
  const STOP_PX = 4; // Lenis lands on fractional pixels: this close to a stop is on it
  const held = new Set(); // the stops that already held the scroll
  const gymStops = () => GYM_STAGES.map((_, i) => layout.gymTop + (i + 0.5) * layout.gymStep);
  // On phones the Gym is one screen tall and its stage moves with the arrows or the axis (phone.stage),
  // not with the scroll: long scroll-driven stretches felt stuck under a finger.
  const phone = { stage: 0 };
  const gymStage = () =>
    narrow() || !layout.gymStep
      ? phone.stage
      : Math.min(GYM_STAGES.length - 1, Math.max(0, Math.floor((scrollY - layout.gymTop) / layout.gymStep)));
  // Where Enter stops after the hero: each chapter's top plus data-rest (a share of the screen,
  // where its words are all in), the Gym's checkpoints instead of the Gym, and the ways to try it
  // instead of the closing (where the top bar's "Probar" lands too).
  const enterStops = () =>
    chapters.slice(1).flatMap((chapter, i) => {
      if (chapter === gymEl) return gymStops();
      if (chapter.contains(probar)) return [anchorTop(probar)];
      return [layout.tops[i + 1] + innerHeight * Number(chapter.dataset.rest ?? 0)];
    });
  function measure() {
    layout.tops = chapters.map((chapter) => chapter.offsetTop);
    layout.gymTop = gymEl.offsetTop;
    layout.gymStep = (gymEl.offsetHeight - gymPanel.offsetHeight) / GYM_STAGES.length;
  }
  measure();
  const layoutObserver = new ResizeObserver(measure);
  layoutObserver.observe(root.querySelector('.landing'));
  cleanups.push(() => layoutObserver.disconnect());
  const gymLevel = () => GYM_STAGES[gymStage()].level;
  const gymShown = (stage) => level === GYM_STAGES[stage].level && gym.shownAt > 0 && performance.now() >= gym.shownAt;
  const gate = { stop: -1, since: 0 };
  function gymGate(data) {
    const { event } = data;
    // Touch scrolls natively (Lenis has no syncTouch here); before the robot loads there is nothing to wait for.
    if (!event.type.includes('wheel') || event.ctrlKey || !view) return true;
    const from = lenis.targetScroll;
    const stops = gymStops();
    const holding =
      gate.stop >= 0 && Math.abs(from - stops[gate.stop]) < STOP_PX && !gymShown(gate.stop) && performance.now() - gate.since < GYM_HOLD_MAX_S * 1000;
    if (!holding) gate.stop = -1;
    if (data.deltaY <= 0) return true; // up and sideways are always free
    if (holding) {
      if (event.cancelable) event.preventDefault(); // Lenis skips its own preventDefault when this returns false
      return false;
    }
    const next = stops.findIndex((stop) => from < stop - STOP_PX && stop <= from + data.deltaY);
    if (next < 0 || gymShown(next) || held.has(next)) return true;
    data.deltaY = stops[next] - from; // Lenis reads the delta after this callback: land on the stop
    Object.assign(gate, { stop: next, since: performance.now() });
    held.add(next);
    return true;
  }
  $$('.axis-stop').forEach((stop, i) =>
    on(stop, 'click', () => {
      if (narrow()) return void (phone.stage = i);
      const top = gymStops()[i];
      if (lenis) lenis.scrollTo(top, { duration: 1 });
      else window.scrollTo({ top });
    }),
  );
  // Phone arrows: one screen per chapter, and inside the Gym one stage per tap.
  const chapterIndex = () => Math.max(0, chapters.findLastIndex((c) => c.offsetTop <= scrollY + innerHeight * 0.4));
  const goTo = (chapter) => {
    const top = chapter.offsetTop;
    if (lenis) lenis.scrollTo(top, { duration: 0.8 });
    else window.scrollTo({ top, behavior: reducedMotion ? 'auto' : 'smooth' });
  };
  function step(direction) {
    const i = chapterIndex();
    if (chapters[i] === gymEl) {
      const next = phone.stage + direction;
      if (next >= 0 && next < GYM_STAGES.length) return void (phone.stage = next);
    }
    const target = chapters[i + direction];
    if (!target) return;
    if (target === gymEl) phone.stage = direction > 0 ? 0 : GYM_STAGES.length - 1;
    goTo(target);
  }
  on($('.arrow-up'), 'click', () => step(-1));
  on($('.arrow-down'), 'click', () => step(1));
  const updateArrows = () => {
    const i = chapterIndex();
    const inGym = chapters[i] === gymEl;
    $('.arrow-up').disabled = i === 0 && !(inGym && phone.stage > 0);
    $('.arrow-down').disabled = i === chapters.length - 1;
  };
  on(window, 'scroll', updateArrows, { passive: true });
  updateArrows();

  let shownStage = -1;
  // Numbers written as text (the step counter) take the new language's decimal mark on a switch.
  cleanups.push(onLang(() => (shownStage = -1)));
  function showGymStage() {
    const stage = gymStage();
    if (stage === shownStage) return;
    shownStage = stage;
    const current = GYM_STAGES[stage];
    for (const selector of ['.axis-stop', '.axis-tick']) {
      $$(selector).forEach((stop, i) => {
        stop.classList.toggle('on', i === stage);
        stop.classList.toggle('past', i < stage);
      });
    }
    $('.axis-fill').style.width = $$('.axis-stop')[stage].style.getPropertyValue('--at');
    $('[data-gym="text"]').innerHTML = T(`stage.${stage}.text`);
    $('[data-gym="numbers"]').innerHTML = `<span>${T('gym.upOf', { s: (l) => `${fmt(current.up, current.up % 1 ? 1 : 0)(l)} s` })}</span><span>${T('gym.pushesOf', { held: (l) => T_OF(current.pushes, l), n: gym.forceN })}</span>`;
    const capEl = $('[data-gym="force-cap"]');
    const zoneEl = $('[data-gym="force-zone"]');
    if (capEl) {
      capEl.innerHTML = current.maxN > 0 ? T('gym.capHold', { label: current.label, max: current.maxN }) : T('gym.capZero');
      capEl.dataset.over = String(gym.forceN > current.maxN);
    }
    if (zoneEl) {
      const pct = current.maxN <= 0 ? 0 : Math.min(100, Math.max(0, ((current.maxN - 50) / 450) * 100));
      zoneEl.style.width = `${pct}%`;
    }
    // The big number counts up (or back) to this stage's steps.
    const shown = { value: Number($('[data-gym="steps"]').dataset.value ?? 0) };
    gsap.to(shown, {
      value: current.steps,
      duration: reducedMotion ? 0 : 0.9,
      ease: 'power2.out',
      onUpdate: () => {
        const el = $('[data-gym="steps"]');
        el.dataset.value = shown.value;
        el.textContent =
          shown.value >= 9.95e8
            ? `${fmt(shown.value / 1e9, 0)(lang())} B`
            : shown.value >= 1e6
              ? `${fmt(shown.value / 1e6, shown.value < 1e7 ? 1 : 0)(lang())} M`
              : fmtInt(shown.value)(lang());
      },
    });
  }
  // Times are the simulation's own clock, not the wall's: a slow or hidden tab cannot fake them.
  function startGymRun() {
    view.stop();
    const [x, y] = view.sim.bodyPosition('pelvis');
    marks?.ring.position.set(x, marks.ring.position.y, -y);
    const t = view.sim.data.time;
    $('[data-gym="status"]').innerHTML = T('gym.live'); // not the last checkpoint's fall
    // The first push comes at GYM_FIRST_PUSH_S, then every GYM_PUSH_EVERY_S.
    Object.assign(gym, { since: t || 1e-6, lastPush: t - (GYM_PUSH_EVERY_S - GYM_FIRST_PUSH_S), fallen: false });
  }
  function runGym() {
    const wanted = gymLevel();
    if (wanted !== level) {
      if (gym.loading) return; // one checkpoint at a time; the next frame asks again if needed
      Object.assign(gym, { since: 0, shownAt: 0 }); // a new checkpoint has shown nothing yet
      gym.loading = true;
      const token = modeToken;
      useLevel(wanted).then(() => {
        gym.loading = false;
        if (token === modeToken && mode === 'gym') startGymRun();
      });
      return;
    }
    if (!gym.since || gym.fallen) return;
    const now = view.sim.data.time;
    const up = now - gym.since;
    $('[data-gym="up"]').textContent = `${fmt(up, 1)(lang())} s`;
    if (view.sim.bodyPosition('pelvis')[2] < FALLEN_PELVIS_M) {
      gym.fallen = true;
      gym.shownAt ||= performance.now() + GYM_SHOWN_FALL_S * 1000;
      $('[data-gym="status"]').innerHTML = T('gym.fell');
      setTimeout(() => mode === 'gym' && level === wanted && startGymRun(), GYM_RESTART_S * 1000);
      return;
    }
    if (now - gym.lastPush > GYM_PUSH_EVERY_S) {
      gym.lastPush = pushed.lastT = now;
      gym.shownAt ||= performance.now() + GYM_SHOWN_PUSH_S * 1000;
      view.push(undefined, gym.forceN);
      drawPush(gym.forceN);
      $('[data-gym="status"]').innerHTML = T('gym.pushed', { n: gym.forceN });
    }
  }

  // ---- Capture: the video, the skeleton and the robot on one clock (the video's) ----
  const video = $('.walk-video');
  let skeleton = null;
  // The 2D points MediaPipe found in this same video, drawn over the person (video-overlay.js, as in
  // Simulaciones), on the walk's clock: forward and backward with the scroll.
  const walkPose = createPoseDrawing(video, $('.walk-overlay'), { fit: 'cover' });
  walkPose.load(`${import.meta.env.BASE_URL}${VIDEOS['clip_2026-10-23_caminar-perfil_01'].pose}`).catch((error) => console.error(error));
  const captureEl = $('.capture');
  // The walk follows the scroll's direction: scrolling down it plays forward on the video's own
  // clock; scrolling up, the video, the skeleton and the robot run backward together, so going
  // back up the page rewinds the story (the robot walks back the way it came). Browsers cannot
  // play a video backward (negative playbackRate), so in reverse the video is paused and seeked.
  // dir keeps the last direction while the page stands still. DIR_PX ignores Lenis's sub-pixel
  // settling, which would flip the direction at the end of every glide.
  const DIR_PX = 0.5;
  const walk = { t: 0, dir: 1, lastY: scrollY, lastNow: 0 };
  const walkDuration = () => (Number.isFinite(video.duration) ? video.duration : 0);
  function updateWalk(now) {
    const dt = walk.lastNow ? Math.min(0.1, (now - walk.lastNow) / 1000) : 0; // 0.1: no leap after a hidden tab
    walk.lastNow = now;
    if (mode !== 'walk') {
      if (!video.paused) video.pause();
      return;
    }
    const duration = walkDuration();
    if (walk.dir > 0 || !duration) {
      if (video.paused) video.play().catch(() => {});
      walk.t = video.currentTime;
    } else {
      if (!video.paused) video.pause();
      walk.t = (((walk.t - dt) % duration) + duration) % duration; // loops backward, like the video loops forward
      // One seek at a time: queuing one every frame made the video fall behind and stutter.
      if (!video.seeking) video.currentTime = walk.t;
    }
    if (skeleton?.clip) {
      skeleton.time = walk.t;
      skeleton.render();
    }
    walkPose.draw(walk.t);
    view.seek(walk.t);
  }
  function updateScrollDir() {
    const delta = scrollY - walk.lastY;
    walk.lastY = scrollY;
    if (Math.abs(delta) > DIR_PX) walk.dir = Math.sign(delta);
  }

  // ---- The wash: one fixed dark veil behind the words, on the side they are on ----
  // A veil per chapter ended in a hard line where the chapter ended; one veil for the whole page,
  // eased toward each chapter's side, leaves no edge. On phones the words sit low: a floor instead.
  const washEl = $('.film-wash');
  const hudEl = $('.film-hud');
  const navLinks = $$('.topnav a');
  let activeNavHref = '';
  // The hero's title sits low on the left, over the street (landing/city.js).
  const WASH = { hero: [0.85, 0], capture: [1, 0], gym: [1, 0], policy: [0, 1], close: [0, 0] };
  const wash = { left: 0, right: 0, floor: 0 };
  const washed = { left: '', right: '', floor: '' }; // what the veil has now: write only changes
  function updateWash() {
    const chapter = chapterAt(scrollY + innerHeight * 0.5);
    const wantedHref = `#${chapter.id}`;
    if (wantedHref !== activeNavHref) {
      activeNavHref = wantedHref;
      for (const link of navLinks) {
        const isCurrent = link.getAttribute('href') === wantedHref;
        link.classList.toggle('active', isCurrent);
        if (isCurrent) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      }
      if (hudEl) hudEl.classList.toggle('is-closing', chapter.dataset.shot === 'close');
    }
    const [left, right] = WASH[chapter.dataset.shot] ?? [0, 0];
    const goal = narrow() ? { left: 0, right: 0, floor: chapter.dataset.shot === 'close' ? 0 : 1 } : { left, right, floor: 0 };
    const k = reducedMotion ? 1 : 0.08;
    for (const side of Object.keys(wash)) {
      wash[side] += (goal[side] - wash[side]) * k;
      const value = wash[side].toFixed(3);
      if (value !== washed[side]) washEl.style.setProperty(`--wash-${side}`, (washed[side] = value));
    }
  }

  // The simulation's own readout, in the corner of the film: its clock and its contacts. Ten
  // times a second is enough to read and keeps the page from rewriting text every frame.
  const READOUT_EVERY_MS = 100;
  let readAt = 0;
  function updateReadout(now) {
    if (now - readAt < READOUT_EVERY_MS) return;
    readAt = now;
    $('[data-sim="time"]').textContent = fmt(view.sim.data.time, 1)(lang());
    $('[data-sim="contacts"]').textContent = view.sim.data.ncon;
  }

  // ---- Every frame ----
  let frameId = requestAnimationFrame(function frame(now) {
    updateWash();
    updateMarks();
    if (view) {
      // The walk of Capture is a puppet, with no physics to show.
      telemetry?.update(mode !== 'walk', { com: chapterAt(scrollY + innerHeight * 0.5).dataset.shot !== 'hero' });
      updateReadout(now);
      directCamera(view);
      updateScrollDir();
      setMode(modeAt());
      updateWalk(now);
      if (mode === 'gym') {
        showGymStage();
        runGym();
      }
      if (mode === 'stand') standHeroUp(now);
    }
    frameId = requestAnimationFrame(frame);
  });

  robot.ready.then(
    (loaded) => {
      if (!loaded || gone) return;
      view = loaded;
      const { camera, controls } = view.viewer;
      saved = { offset: camera.position.clone().sub(controls.target), targetHeight: view.viewer.targetHeight, maxPolarAngle: controls.maxPolarAngle };
      controls.enabled = false; // the scroll directs the camera here
      // Trailer lighting while the landing has the robot: a key light that rides with the camera
      // (directCamera moves it), so every shot is lit from the front whatever the angle, and a
      // rim from behind that draws the silhouette. Taken out again on unmount.
      key = new THREE.PointLight(0xffffff, 9, 0, 1.2);
      const rim = new THREE.DirectionalLight(0xfff1e6, 2.2);
      rim.position.set(-3, 2.5, 2);
      // Ambient sky light and a brighter exposure, so the dark scene never swallows the robot.
      const sky = new THREE.HemisphereLight(0xffffff, 0x3a3833, 1.4);
      lights = [key, rim, sky];
      saved.exposure = view.viewer.renderer.toneMappingExposure;
      saved.pixelRatio = view.viewer.renderer.getPixelRatio();
      view.viewer.renderer.setPixelRatio(Math.min(devicePixelRatio, FILM_PIXEL_RATIO));
      view.viewer.resize();
      view.viewer.renderer.toneMappingExposure = 1.35;
      lights.forEach((light) => view.viewer.scene.add(light));
      // A city street at dusk around the robot instead of the grid, while the landing has it.
      undressCity = dressCity(view.viewer.scene, view.viewer.renderer);
      marks = makeMarks(view.viewer.scene);
      telemetry = dressTelemetry(view);
      $('[data-sim="rates"]').innerHTML = T('sim.rates', { hz: Math.round(1 / view.sim.model.opt.timestep), policy: DECISIONS_PER_S });
      film.classList.add('ready');
      $$('.hero-push, .gym-push').forEach((button) => (button.disabled = false));
      warmUp();
    },
    (error) => {
      $('.boot-line').innerHTML = T('boot.failed');
      console.error(error);
    },
  );

  // While the reader is still on the hero, do the work the next chapters would otherwise do on
  // arrival: the skeleton's renderer, and the Gym's checkpoints downloaded into the browser's cache
  // (loading one then only builds its network, instead of waiting on the network mid-scroll).
  function warmUp() {
    const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 200));
    idle(buildSkeleton, { timeout: 1500 });
    idle(() => {
      for (const stage of GYM_STAGES) {
        const { onnx, json } = policyUrls(stage.level);
        for (const url of [onnx, json]) if (url) fetch(url).catch(() => {});
      }
    }, { timeout: 3000 });
  }

  // ---- Scroll choreography (GSAP) ----
  const ctx = gsap.context(() => {
    if (reducedMotion) return;
    // Hero words: lines rise in on load; the whole caption drifts up and fades as you leave.
    gsap.from('.hero-caption > *', { y: 40, opacity: 0, duration: 1.2, ease: 'expo.out', stagger: 0.08, delay: 0.2 });
    gsap.to('.hero-caption, .hud, .hero-live', {
      y: -80,
      opacity: 0,
      ease: 'none',
      scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom 40%', scrub: true },
    });

    // Capture: video, skeleton and robot are all on screen at once; the frames and the one text
    // rise in as the chapter arrives.
    gsap.from('.capture-media .frame, .capture-caption > *', {
      opacity: 0,
      y: 40,
      stagger: 0.06,
      scrollTrigger: { trigger: '.capture', start: 'top 75%', end: 'top 15%', scrub: true },
    });

    // Gym: its words come in once; the stages then follow the scroll (gymStage) and stop it (gymGate).
    gsap.from('.gym-caption > *', { opacity: 0, y: 30, stagger: 0.08, duration: 0.6, scrollTrigger: { trigger: '.gym', start: 'top 60%', toggleActions: 'play none none none' } });

    // Policy: card rises in cleanly on arrival so all 4 specs and CTA button are immediately visible.
    gsap.from('.policy-caption > *', { opacity: 0, y: 24, stagger: 0.06, duration: 0.55, scrollTrigger: { trigger: '.policy', start: 'top 65%', toggleActions: 'play none none none' } });

    // Closing: the page closes over the film like a curtain, and the manifesto rises word by word.
    gsap.fromTo('.film-shade', { '--shade': 0 }, { '--shade': 0.88, immediateRender: false, scrollTrigger: { trigger: '.closing', start: 'top bottom', end: 'top 30%', scrub: true } });
    const words = $('.manifesto');
    // Word by word, line by line: the manifesto's <br> (one sentence per line) stays where it was.
    const wrapWords = (text) => text.split(' ').map((w) => `<span class="w"><span>${w}</span></span>`).join(' ');
    for (const span of words.querySelectorAll('.t')) span.innerHTML = span.innerHTML.split(/<br\s*\/?>/).map((line) => wrapWords(line.trim())).join('<br>');
    gsap.from('.manifesto .w > span', { yPercent: 110, stagger: 0.04, ease: 'power3.out', scrollTrigger: { trigger: '.closing', start: 'top 80%', end: 'top 10%', scrub: true } });
    // Done by the time the closing's top reaches the top of the screen, before "Probar" lands.
    // Animate the .tries container rather than individual .try links so GSAP never fights CSS hover states.
    gsap.from('.closing-text, .tries', { opacity: 0, y: 40, stagger: 0.08, scrollTrigger: { trigger: '.closing', start: 'top 70%', end: 'top top', scrub: true } });
  }, root);

  // The skeleton of Capture: a second WebGL renderer, whose context and shaders took ~1 s to set up
  // the moment Capture came near, a visible freeze mid-scroll. Now it is built while the page is
  // idle after the robot loads (warmUp), and drawn once there so its shaders are compiled before
  // anyone sees it; the observer is only the fallback for someone who scrolls there first.
  function buildSkeleton() {
    if (skeleton || gone || !WALK) return;
    skeleton = new SkeletonView($('.skeleton-canvas'));
    skeleton.controls.enabled = false;
    // Seen from the side the video was filmed from (the PoseClip's z points to the phone), so the
    // skeleton walks the same way as the person and the far arm is the dimmed one behind the body.
    skeleton.camera.position.set(0, 1.1, 3.4);
    fetchClip(WALK).then((clip) => {
      if (gone) return;
      skeleton.setClip(clip);
      skeleton.render();
    }, console.error);
  }
  const skeletonObserver = new IntersectionObserver(([entry]) => entry.isIntersecting && buildSkeleton(), { rootMargin: '400px' });
  skeletonObserver.observe(captureEl);

  // The top bar is clear over the hero and turns solid once the hero has scrolled past its bottom
  // edge: from there on chapter text scrolls under it (the Gym, the end of each pinned chapter and
  // the closing), in the same light ink as the bar's own words. An observer, not a ScrollTrigger,
  // so it also works with reduced motion, where the GSAP context below creates nothing.
  const topbar = $('.topbar');
  const barObserver = new IntersectionObserver(([entry]) => topbar.classList.toggle('solid', !entry.isIntersecting), {
    rootMargin: `-${Math.round(topbar.getBoundingClientRect().bottom)}px 0px 0px 0px`, // the bar floats below the top
  });
  barObserver.observe($('.hero'));

  return () => {
    gone = true;
    document.documentElement.classList.remove('is-landing');
    cancelAnimationFrame(frameId);
    clearTimeout(heroTimer);
    clearTimeout(pushed.queued);
    ctx.revert();
    ScrollTrigger.getAll().forEach((trigger) => trigger.kill());
    if (lenis) {
      gsap.ticker.remove(tick);
      lenis.destroy();
    }
    skeletonObserver.disconnect();
    barObserver.disconnect();
    cleanups.forEach((fn) => fn());
    video.pause();
    skeleton?.dispose();
    // Give the camera back to the app screens as they expect it.
    if (view && saved) {
      const { camera, controls } = view.viewer;
      view.viewer.targetHeight = saved.targetHeight;
      controls.target.y = saved.targetHeight;
      camera.position.copy(controls.target).add(saved.offset);
      camera.filmOffset = 0;
      camera.updateProjectionMatrix(); // also drops the vertical shift
      controls.maxPolarAngle = saved.maxPolarAngle;
      controls.enabled = true;
      view.viewer.followTau = 0; // the app screens follow the robot rigidly
      lights.forEach((light) => view.viewer.scene.remove(light));
      view.viewer.renderer.toneMappingExposure = saved.exposure;
      view.viewer.renderer.setPixelRatio(saved.pixelRatio);
      view.viewer.resize();
      undressCity();
      telemetry?.dispose();
      if (marks) {
        marks.arrow.dispose();
        view.viewer.scene.remove(marks.ring);
        marks.ring.traverse((o) => o.geometry?.dispose());
        marks.ringMaterial.dispose();
      }
    }
    robot.detach();
  };
}

// Turns a RobotMotion about the vertical through its first pelvis position so it starts facing +x,
// where the standing robot faces after a reset: the walk was filmed heading +y, and without this the
// robot snapped 90° when it started. The pelvis path and quaternion turn; the joints do not.
function faceForward(motion) {
  const [x0, y0, , w0, a0, b0, c0] = motion.qpos[0];
  const yaw = Math.atan2(2 * (w0 * c0 + a0 * b0), 1 - 2 * (b0 * b0 + c0 * c0));
  const cos = Math.cos(-yaw);
  const sin = Math.sin(-yaw);
  const hw = Math.cos(-yaw / 2); // the turn as a quaternion about z: (hw, 0, 0, hz)
  const hz = Math.sin(-yaw / 2);
  const qpos = motion.qpos.map(([x, y, z, w, a, b, c, ...joints]) => [
    x0 + cos * (x - x0) - sin * (y - y0),
    y0 + sin * (x - x0) + cos * (y - y0),
    z,
    hw * w - hz * c,
    hw * a - hz * b,
    hw * b + hz * a,
    hw * c + hz * w,
    ...joints,
  ]);
  return { ...motion, qpos };
}
