// A pane showing the app's one G1 (robot-host.js), used by the live screen.
// While the robot is still loading, the brand's loader (loader.js) turns in its place with a
// progress bar; "Empujar" floats over the pane so it is always on screen without scrolling (the
// pitch's key moment), and draws the push's arrow in the scene, as the landing does.
// The push is opt-out: while the robot is copying someone from the camera it is placed frame by
// frame and does not answer to physics, so a shove there does nothing and reads as a broken button.
import { loader } from './loader.js';
import { createPushArrow } from './push-arrow.js';
import { pushWhenReady } from './push.js';
import { attachRobot, onRobotProgress, robotView } from './robot-host.js';
import { T } from './strings-stage.js';

/**
 * Markup for a robot pane; mountRobotPane fills it in.
 * @param label  the pane's caption
 * @param options.push  false hides the shove button (the live screen, where the robot is puppeted)
 */
export function robotPaneHTML(label, { push = true } = {}) {
  return `
    <section class="pane robot-pane">
      <div class="robot-loading">
        ${loader()}
        <div class="track"><div class="robot-progress"></div></div>
        <p class="robot-status">${T('preparing')}</p>
      </div>
      <p class="pane-label">${label}</p>
      ${
        push
          ? `<div class="push-group">
        <div class="push-force-pills" role="group" aria-label="Push force in Newtons">
          <button type="button" class="push-force-pill" data-force="100">100 N</button>
          <button type="button" class="push-force-pill active" data-force="150" aria-pressed="true">150 N</button>
          <button type="button" class="push-force-pill" data-force="300">300 N</button>
          <button type="button" class="push-force-pill" data-force="500">500 N</button>
        </div>
        <button class="push" type="button" disabled>${T('push')}</button>
      </div>`
          : ''
      }
    </section>`;
}

/**
 * @param pane  the .robot-pane element
 * @param options.beforePush  called before the shove (the live screen turns the camera off)
 * @returns {{ ready: Promise<object | null>, view: object | null, dispose(): void }}
 */
export function mountRobotPane(pane, { beforePush } = {}) {
  const $ = (selector) => pane.querySelector(selector);
  const robot = attachRobot(pane);
  let arrow = null;
  let frameId = 0;
  let disposed = false;
  const pushed = { lastT: -Infinity, queued: 0 };
  const handle = { view: null, ready: robot.ready, dispose };

  const stopProgress = onRobotProgress(({ done, total, compiling, policy }) => {
    $('.robot-progress').style.width = `${(100 * done) / total}%`;
    if (policy) $('.robot-status').innerHTML = T('teaching');
    else if (compiling) $('.robot-status').innerHTML = T('building');
  });
  // Already loaded (any visit after the first): no loader and no fade, the robot is there.
  if (robotView()) pane.classList.add('ready', 'instant');

  robot.ready
    .then((view) => {
      if (!view) return;
      handle.view = view;
      pane.classList.add('ready');
      arrow = createPushArrow(view.viewer.scene);
      frameId = requestAnimationFrame(function frame() {
        arrow.update();
        frameId = requestAnimationFrame(frame);
      });
      const push = $('.push');
      let forceN = 150;
      const forcePills = [...pane.querySelectorAll('.push-force-pill')];
      forcePills.forEach((pill) => {
        pill.onclick = () => {
          forceN = Number(pill.dataset.force) || 150;
          forcePills.forEach((p) => {
            const active = p === pill;
            p.classList.toggle('active', active);
            p.setAttribute('aria-pressed', String(active));
          });
        };
      });
      if (push) {
        push.disabled = false;
        // The push the trained robot holds, once it has stood a moment (push.js). A robot playing
        // a clip is stood up first: pushed the instant it was stood up, it fell most of the time.
        push.onclick = () => {
          beforePush?.();
          if (view.sim.puppeted) view.stop();
          const scale = Math.max(0.6, Math.min(1.5, forceN / 200));
          pushWhenReady(pushed, view, () => arrow?.point(view, scale), () => !disposed, forceN);
        };
      }
    })
    .catch((error) => {
      $('.robot-status').innerHTML = T('loadFailed');
      console.error(error);
    });

  function dispose() {
    disposed = true;
    clearTimeout(pushed.queued);
    stopProgress();
    robot.detach();
    cancelAnimationFrame(frameId);
    arrow?.dispose(); // the scene is the one robot's, shared with the other screens
    arrow = null;
  }
  return handle;
}
