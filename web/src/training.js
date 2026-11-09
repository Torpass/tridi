// Training your own clip (WEB-2 in docs/plan-producto.md): a camera clip goes to the server first
// (POST /clips), then any clip joins the training queue and is followed until its delivery is
// ready. Kept outside the screens, so leaving En vivo does not stop following it; like the clips
// themselves (preloaded.js), it lasts until the page reloads. The box below (trainBoxHTML and
// mountTrainBox) is the step after recording: train the robot with the clip, then its delivery.
import { cancelTraining, sendClip, trainClip, UploadError, watchTraining } from '../../data/live/src/upload.js';
import { escapeHtml, fmt, LANGS as LANG_LIST } from './i18n.js';
import { mountNetView } from './netview.js';
import { L, T, t as tr } from './strings-training.js';

// Below this share of frames with the body in view the server refuses to train
// (MIN_VALID_RATIO in data/server.py, from docs/contrato.md): the robot would imitate the gaps.
export const MIN_VALID_RATIO = 0.8;

/**
 * @typedef {{
 *   phase: 'sending' | 'queuing' | 'watching' | 'done' | 'failed',
 *   clipId: string | null,   // the server's id: the delivery lives at #/delivery/<clipId>
 *   train: object | null,    // the last GET /train/{id}
 *   error: string | null,
 * }} Run
 */

/** @type {Map<string, Run>} keyed by the gallery item's clip id */
const runs = new Map();
const listeners = new Map();
const watches = new Map(); // the AbortController of each followed training, so Cancelar stops following it

function update(key, patch) {
  const run = { ...runs.get(key), ...patch };
  runs.set(key, run);
  listeners.get(key)?.forEach((listener) => listener(run));
}

/** Cancels a training of this visit: the server stops it and the box goes back to "Entrenar". */
export async function stopTraining(item, api) {
  const run = runFor(item);
  const trainId = run?.train?.train_id;
  watches.get(item.clip)?.abort();
  watches.delete(item.clip);
  runs.delete(item.clip);
  listeners.get(item.clip)?.forEach((listener) => listener(null));
  if (trainId) await cancelTraining(api.url, trainId).catch((error) => console.error(error));
}

/** The training of a gallery item, if one was started on this visit. */
export const runFor = (item) => runs.get(item.clip) ?? null;

/** Calls `listener` with every change of this item's training; returns the unsubscribe function. */
export function subscribe(item, listener) {
  if (!listeners.has(item.clip)) listeners.set(item.clip, new Set());
  listeners.get(item.clip).add(listener);
  return () => listeners.get(item.clip).delete(listener);
}

/** Why this clip cannot be trained (markup in every language), or null. */
export function cannotTrain(item, api) {
  if (!api.ok) return T('noServer');
  const ratio = item.data?.quality?.valid_ratio ?? 0;
  if (ratio < MIN_VALID_RATIO) {
    return T('lowValid', { got: Math.round(100 * ratio), need: 100 * MIN_VALID_RATIO });
  }
  return null;
}

/** Starts (or, after a failure, retries) training a user clip. */
export async function startTraining(item, api) {
  const active = runFor(item);
  if (active && active.phase !== 'failed') return;
  const camera = item.data.source === 'camera';
  // A camera clip already sent keeps its server id, so a retry does not send it twice.
  let clipId = active?.clipId ?? (camera ? null : item.data.id);
  const watch = new AbortController();
  watches.set(item.clip, watch);
  // The tunnel's URL changes every time data/serve.sh restarts, and a page opened before that
  // still holds the old one: a network failure looks for the server again (api.recheck, through
  // the gist) and, if it answers, tries once more there.
  for (let attempt = 0; ; attempt++) {
    try {
      if (!clipId) {
        update(item.clip, { phase: 'sending', clipId: null, train: null, error: null });
        clipId = await sendClip(api.url, item.data);
      }
      update(item.clip, { phase: 'queuing', clipId, train: null, error: null });
      const trainId = await trainClip(api.url, clipId);
      // Cancelled while it was being queued: the server has it now, so stop it there too.
      if (watch.signal.aborted) return void cancelTraining(api.url, trainId).catch((error) => console.error(error));
      update(item.clip, { phase: 'watching' });
      const train = await watchTraining(api.url, trainId, { onUpdate: (t) => update(item.clip, { train: t }), signal: watch.signal });
      update(item.clip, train.state === 'done' ? { phase: 'done' } : { phase: 'failed', error: train.error ? escapeHtml(train.error) : T('failed') });
      return;
    } catch (error) {
      if (watch.signal.aborted) return; // cancelled: stopTraining already reset the box
      const lost = !(error instanceof UploadError);
      if (lost && attempt === 0) {
        const before = api.url;
        if ((await api.recheck()) && api.url !== before) {
          if (camera) clipId = null; // the new server may not have it: send it again
          continue;
        }
      }
      if (lost) console.error(error);
      update(item.clip, {
        phase: 'failed',
        clipId,
        error: lost ? T('lost') : escapeHtml(error.message), // markup: render() puts it in with innerHTML
      });
      return;
    }
  }
}

// The steps of a training as the panel lists them, in the order of GET /train's `stage`. The box
// says it takes "unos 30 minutos": 20 M steps on the server's Mac (docs/contrato.md, training queue).
const TRAIN_STEPS = [
  ['queued', 'stepQueued'],
  ['retarget', 'stepRetarget'],
  ['training', 'stepTraining'],
  ['data', 'stepData'],
];

/** The training box's markup; mountTrainBox brings it to life. */
export const trainBoxHTML = () => `
<section class="train-box" hidden aria-live="polite">
  <h2>${T('title')}</h2>
  <div data-train="preloaded" hidden>
    <p class="train-badge-line"><span class="card-badge trained">${T('preloadedBadge')}</span></p>
    <p class="train-text">${T('preloadedText')}</p>
    <div class="train-config">
      <label class="field">${T('cfgSteps')}
        <select class="train-cfg-steps">
          <option value="20000000" selected>${T('cfgSteps20')}</option>
          <option value="50000000">${T('cfgSteps50')}</option>
          <option value="100000000">${T('cfgSteps100')}</option>
        </select>
      </label>
      <label class="field">${T('cfgPush')}
        <select class="train-cfg-push">
          <option value="150">${T('cfgPush150')}</option>
          <option value="250" selected>${T('cfgPush250')}</option>
          <option value="350">${T('cfgPush350')}</option>
        </select>
      </label>
      <div class="field train-cfg-worlds">
        <span>${T('cfgWorlds')}</span>
        <strong>${T('cfgWorldsVal')}</strong>
      </div>
    </div>
    <div class="train-actions-row">
      <a class="button primary train-example" href="#/delivery">${T('example')}</a>
      <a class="button" href="#/live">${T('recordNew')}</a>
      <a class="button" href="#/upload">${T('uploadNew')}</a>
    </div>
  </div>
  <div data-train="idle">
    <p class="train-text">${T('idle')}</p>
    <div class="train-config">
      <label class="field">${T('cfgSteps')}
        <select class="train-cfg-steps">
          <option value="20000000" selected>${T('cfgSteps20')}</option>
          <option value="50000000">${T('cfgSteps50')}</option>
          <option value="100000000">${T('cfgSteps100')}</option>
        </select>
      </label>
      <label class="field">${T('cfgPush')}
        <select class="train-cfg-push">
          <option value="150">${T('cfgPush150')}</option>
          <option value="250" selected>${T('cfgPush250')}</option>
          <option value="350">${T('cfgPush350')}</option>
        </select>
      </label>
      <div class="field train-cfg-worlds">
        <span>${T('cfgWorlds')}</span>
        <strong>${T('cfgWorldsVal')}</strong>
      </div>
    </div>
    <button class="primary train-start" type="button">${T('start')}</button>
    <p class="train-why"></p>
    <a class="button train-example" href="#/delivery">${T('example')}</a>
  </div>
  <div data-train="progress" hidden>
    <ol class="stages compact">${TRAIN_STEPS.map(([id, text]) => `<li data-step="${id}">${T(text)}</li>`).join('')}</ol>
    <div class="track"><div class="bar train-bar"></div></div>
    <p class="train-line"></p>
    <div class="train-net" hidden></div>
    <a class="train-net-link" href="#/net" target="_blank" rel="noopener" hidden>${T('netLink')}</a>
    <p class="train-note">${T('note')}</p>
    <button class="train-cancel" type="button">${T('cancel')}</button>
  </div>
  <div data-train="done" hidden>
    <p class="train-text train-result"></p>
    <a class="button primary train-delivery" href="#/delivery">${T('delivery')}</a>
  </div>
  <div data-train="failed" hidden>
    <p class="train-error error"></p>
    <button class="train-retry" type="button">${T('retry')}</button>
  </div>
</section>`;

// Numbers in each language's own decimal mark (fmt): "1,5 M" / "1.5 M".
const num = (x, digits = 1) => fmt(x, digits);
const stepCount = (steps) => (steps < 1e6 ? `${Math.round(steps / 1e3)} k` : (l) => `${num(steps / 1e6)(l)} M`);
const minutes = (s) => (l) => (s < 60 ? L('lessThanMinute', {}, l) : L('aboutMin', { n: Math.ceil(s / 60) }, l));

/** What a training says while it runs (markup in every language): its place in the queue, its steps
 * and how much it follows. */
export function progressLine(run) {
  const t = run.train;
  if (run.phase === 'sending') return T('sending');
  if (!t) return T('joining');
  if (t.state === 'queued') {
    const ahead = t.position > 0 ? (t.position === 1 ? T('aheadOne') : T('aheadMany', { n: t.position })) : T('next');
    return ahead + T('endsIn', { eta: minutes(t.eta_s) });
  }
  // Each part is a sentence fragment in both languages; the first one starts with a capital.
  const parts = [];
  if (t.stage === 'training') parts.push(['step', { at: stepCount(t.steps), total: stepCount(t.total_steps) }]);
  if (t.followed_s != null) parts.push(['follows', { followed: num(t.followed_s, 2), duration: num(t.duration_s, 2) }]);
  parts.push(['endsInLower', { eta: minutes(t.eta_s) }]);
  return LANG_LIST.map((l) => {
    const line = parts.map(([key, vars]) => L(key, vars, l)).join(' · ');
    return `<span class="t" lang="${l}">${line.replace(/^./, (c) => c.toUpperCase())}</span>`;
  }).join('');
}

/**
 * The "Entrenar" box (markup from trainBoxHTML), for a clip made on this visit: show({ clip, data })
 * with the clip's id and its PoseClip, show(null) to hide it.
 */
export function mountTrainBox(box, api) {
  const $ = (selector) => box.querySelector(selector);
  let item = null;
  let unsubscribe = null;
  let netView = null; // the network in 3D (netview.js), made the first time a training runs here; false without WebGL

  function render(run) {
    if (!item?.data) {
      box.querySelectorAll('[data-train]').forEach((el) => (el.hidden = el.dataset.train !== 'preloaded'));
      return;
    }
    const phase = run ? (run.phase === 'done' || run.phase === 'failed' ? run.phase : 'progress') : 'idle';
    box.querySelectorAll('[data-train]').forEach((el) => (el.hidden = el.dataset.train !== phase));
    if (phase === 'idle') {
      const why = cannotTrain(item, api);
      $('.train-start').disabled = Boolean(why);
      $('.train-why').innerHTML = why ?? '';
      $('.train-why').hidden = !why;
    } else if (phase === 'progress') {
      const t = run.train;
      const step = !t || t.state === 'queued' ? 0 : TRAIN_STEPS.findIndex(([id]) => id === t.stage);
      box.querySelectorAll('.stages li').forEach((li, i) => {
        li.classList.toggle('done', i < step);
        li.classList.toggle('current', i === step);
      });
      const fraction = !t || t.state === 'queued' ? 0 : t.stage === 'data' ? 1 : t.steps / Math.max(t.total_steps, 1);
      $('.train-bar').style.width = `${Math.round(100 * fraction)}%`;
      $('.train-line').innerHTML = progressLine(run);
      if (t?.train_id && t.state === 'running' && netView !== false) {
        try {
          netView ??= mountNetView($('.train-net'));
        } catch (error) {
          console.error(error); // no WebGL: the box keeps its steps and bar, as before
          netView = false;
        }
        // Asked from retarget on: the first picture shows up as soon as practice starts. During
        // `data` the last picture stays, the network no longer changes.
        if (netView) netView.follow(api.url, t.train_id, t.stage !== 'data');
        $('.train-net-link').href = `#/net/${encodeURIComponent(t.train_id)}`;
        $('.train-net-link').hidden = false;
      } else if (netView) {
        netView.follow(api.url, null, false);
      }
    } else if (phase === 'done') {
      const t = run.train;
      // "done" with an error: the policy and the dataset are there, but the delivery was not built.
      $('.train-result').innerHTML = t.error
        ? T('doneError', { error: escapeHtml(t.error) })
        : T('done', { followed: num(t.followed_s ?? 0, 2), duration: num(t.duration_s, 2) });
      $('.train-delivery').hidden = Boolean(t.error);
      $('.train-delivery').href = `#/delivery/${encodeURIComponent(run.clipId)}`;
    } else {
      $('.train-error').innerHTML = run.error; // markup: T() or escaped server text
    }
  }

  function show(selected) {
    unsubscribe?.();
    unsubscribe = null;
    item = selected;
    box.hidden = !item;
    if (box.hidden) return;
    if (!item.data) {
      render(null);
      return;
    }
    unsubscribe = subscribe(item, render);
    render(runFor(item));
    // Until /health answers, the button waits as if there were no server.
    api.checked.then(() => item === selected && render(runFor(item)));
  }

  $('.train-start').onclick = () => startTraining(item, api);
  $('.train-retry').onclick = () => startTraining(item, api);
  $('.train-cancel').onclick = () => {
    if (confirm(tr('confirm'))) stopTraining(item, api);
  };
  return {
    show,
    dispose: () => {
      unsubscribe?.();
      if (netView) netView.dispose();
    },
  };
}
