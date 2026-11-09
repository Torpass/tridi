// Sube un video (W5 and W6): pick a file, upload it in chunks, follow the server through its
// stages and let the user pick another person on the first frame. When the movement is ready it
// goes straight to training (training.js), and the screen follows it to its delivery.
// The server API is data/live's client (docs/contrato.md); this screen only draws it.
import { chooseSubject, fetchClip, firstFrameUrl, UploadError, uploadVideo, watchJob } from '../../../data/live/src/upload.js';
import { createVideoOverlay } from '../video-overlay.js';
import { addUserClip } from '../preloaded.js';
import { cannotTrain, mountTrainBox, startTraining, trainBoxHTML } from '../training.js';
import { escapeHtml } from '../i18n.js';
import { A, T } from './strings/upload.js';

export { title } from './strings/upload.js';

// The server's limits (docs/contrato.md): checked here first so nobody waits for an upload
// that will be refused.
const MAX_BYTES = 60 * 1024 * 1024;
const MAX_SECONDS = 30;
const VIDEO_TYPES = /\.(mp4|mov|m4v|webm|zip)$/i;

const STAGES = [
  ['upload', 'stageUpload'],
  ['tracking', 'stageTracking'],
  ['pose3d', 'stagePose'],
  ['done', 'stageDone'],
];
const STAGE_ORDER = { waiting: 1, tracking: 1, pose3d: 2, done: 3, failed: 3 };

// The current upload survives leaving the screen: the server keeps working, and coming back
// shows where it is. { jobId, filename, job, error, clips }
let session = null;

// Markup: the server's own message (escaped; it comes in Spanish) or ours in every language.
const describeError = (error) => (error instanceof UploadError ? escapeHtml(error.message) : T('lost'));

function videoSeconds(file) {
  return new Promise((resolve) => {
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => {
      URL.revokeObjectURL(probe.src);
      resolve(probe.duration);
    };
    probe.onerror = () => resolve(null); // unknown format here; the server decides
    probe.src = URL.createObjectURL(file);
  });
}

export function mount(root, { api }) {
  root.innerHTML = `
    <section class="page upload" data-step="checking">
      <header class="page-head">
        <a class="back" href="#/" ${A({ 'aria-label': 'back' })}>←<span class="only-wide">&nbsp;${T('back')}</span></a>
        <h1>${T('head')}</h1>
      </header>
      <div class="upload-grid">
        <section class="pane example-pane">
          <p class="pane-label"><span class="only-wide">${T('exampleWide')}</span><span class="only-narrow">${T('exampleNarrow')}</span></p>
        </section>
        <div class="upload-panel">
          <div data-show="checking"><p class="lead">${T('connecting')}</p></div>

          <div data-show="pick">
            <p class="lead">${T('pickLead')}</p>
            <ul class="tips">
              <li>${T('tipSide')}</li>
              <li>${T('tipLimits', { seconds: MAX_SECONDS, mb: MAX_BYTES / 1024 / 1024 })}</li>
              <li>${T('tipPeople')}</li>
            </ul>
            <label class="dropzone">
              <input type="file" accept="video/*,.zip" hidden />
              <strong>${T('pickButton')}</strong>
              <span>${T('drop')}</span>
            </label>
            <p class="pick-error error" aria-live="polite"></p>
          </div>

          <div data-show="uploading">
            <h2>${T('uploading')}</h2>
            <div class="track big"><div class="bar upload-bar"></div></div>
            <p class="upload-percent">0 %</p>
            <button class="cancel" type="button">${T('cancel')}</button>
          </div>

          <div data-show="processing">
            <h2>${T('watching')}</h2>
            <ol class="stages">${STAGES.map(([id, text]) => `<li data-stage="${id}">${T(text)}</li>`).join('')}</ol>
            <div class="track big"><div class="bar stage-bar"></div></div>
            <p class="queue"></p>
            <div class="chooser" hidden>
              <p>${T('isThis')}</p>
              <div class="frame"><img ${A({ alt: 'frameAlt' })} /><svg></svg></div>
            </div>
            <p class="note">${T('meanwhile')}</p>
          </div>

          <div data-show="done">
            <h2>${T('done')}</h2>
            <p class="lead done-text"></p>
            ${trainBoxHTML()}
            <div class="row">
              <button class="primary again" type="button">${T('again')}</button>
              <a class="button" href="#/">${T('home')}</a>
            </div>
          </div>

          <div data-show="error">
            <h2>${T('failedHead')}</h2>
            <p class="lead error error-text"></p>
            <button class="primary again" type="button">${T('tryAnother')}</button>
          </div>

          <div data-show="off">
            <h2>${T('offHead')}</h2>
            <p class="lead"><span class="only-wide">${T('offWide')}</span><span class="only-narrow">${T('offNarrow')}</span></p>
            <div class="row">
              <button class="primary retry" type="button">${T('retry')}</button>
              <a class="button" href="#/live">${T('useCamera')}</a>
              <a class="button" href="#/delivery">${T('seeDelivery')}</a>
            </div>
            <p class="note server-url"></p>
          </div>
        </div>
      </div>
    </section>`;

  const $ = (selector) => root.querySelector(selector);
  const page = $('.upload');
  const trainBox = mountTrainBox($('.train-box'), api);
  const show = (step) => (page.dataset.step = step);
  // The example: the walk the robot learned from, playing with its skeleton over it.
  const example = createVideoOverlay($('.example-pane'));
  example.show('clip_2026-10-23_caminar-perfil_01').catch(console.error);
  let exampleTime = 0;
  let exampleLast = performance.now();
  let exampleFrame = requestAnimationFrame(function tick(now) {
    exampleTime += (now - exampleLast) / 1000;
    exampleLast = now;
    example.sync(exampleTime, true, 1);
    exampleFrame = requestAnimationFrame(tick);
  });
  let gone = false;
  let abort = null;

  // Picking a file.
  const input = $('input[type=file]');
  input.onchange = () => input.files[0] && start(input.files[0]);
  const zone = $('.dropzone');
  zone.ondragover = (event) => {
    event.preventDefault();
    zone.classList.add('over');
  };
  zone.ondragleave = () => zone.classList.remove('over');
  zone.ondrop = (event) => {
    event.preventDefault();
    zone.classList.remove('over');
    const file = event.dataTransfer.files[0];
    if (file) start(file);
  };
  for (const button of root.querySelectorAll('.again')) {
    button.onclick = () => {
      session = null;
      input.value = '';
      $('.pick-error').innerHTML = '';
      show('pick');
    };
  }
  $('.cancel').onclick = () => abort?.abort();

  async function start(file) {
    const refuse = (markup) => ($('.pick-error').innerHTML = markup);
    if (!VIDEO_TYPES.test(file.name)) return refuse(T('notVideo'));
    if (file.size > MAX_BYTES) return refuse(T('tooBig', { mb: Math.round(file.size / 1024 / 1024), max: MAX_BYTES / 1024 / 1024 }));
    if (!/\.zip$/i.test(file.name)) {
      const seconds = await videoSeconds(file);
      if (seconds > MAX_SECONDS) return refuse(T('tooLong', { seconds: Math.round(seconds), max: MAX_SECONDS }));
    }

    session = { filename: file.name, jobId: null, job: null, clips: [] };
    show('uploading');
    abort = new AbortController();
    try {
      session.jobId = await uploadVideo(api.url, file, {
        signal: abort.signal,
        onProgress: ({ sent, total }) => {
          const percent = Math.round((100 * sent) / total);
          $('.upload-bar').style.width = `${percent}%`;
          $('.upload-percent').textContent = `${percent} %`;
        },
      });
    } catch (error) {
      if (abort.signal.aborted) {
        session = null;
        return show('pick');
      }
      return fail(describeError(error));
    }
    follow();
  }

  function fail(markup) {
    session = { ...session, error: markup };
    if (gone) return;
    $('.error-text').innerHTML = markup;
    show('error');
  }

  // Following the job until it ends; called again after picking another person.
  async function follow() {
    abort?.abort();
    abort = new AbortController();
    const signal = abort.signal;
    if (!gone) show('processing');
    let job;
    try {
      job = await watchJob(api.url, session.jobId, { signal, onUpdate: (state) => !gone && render((session.job = state)) });
    } catch (error) {
      if (!signal.aborted) fail(describeError(error));
      return;
    }
    const failed = job.videos.filter((v) => v.stage === 'failed');
    if (job.state === 'failed' || failed.length === job.videos.length) {
      return fail(failed[0]?.error ? escapeHtml(failed[0].error) : T('nobody'));
    }
    try {
      session.clips = await Promise.all(job.videos.filter((v) => v.clip_id).map((v) => fetchClip(api.url, v.clip_id)));
    } catch (error) {
      return fail(describeError(error));
    }
    const name = session.filename.replace(/\.[^.]+$/, '');
    session.clips.forEach((clip, i) => addUserClip(clip, session.clips.length > 1 ? `${name} (${i + 1})` : name));
    if (gone) return;
    $('.done-text').innerHTML = session.clips.length > 1 ? T('doneMany', { n: session.clips.length }) : T('doneOne');
    // Straight to training, no button to press. The first movement only: the server trains one at
    // a time with 3 waiting (docs/contrato.md), and a .zip of several would fill its queue. A clip
    // that cannot be trained (too little of the body seen) shows why instead; coming back to this
    // screen does not start it twice (startTraining keeps one run per clip).
    const item = { clip: session.clips[0].id, data: session.clips[0] };
    trainBox.show(item);
    if (!cannotTrain(item, api)) startTraining(item, api);
    show('done');
    // The chooser stays useful for 10 minutes after "done" (the server keeps the video that long).
    render(job);
  }

  function render(job) {
    // The least advanced video sets the step shown; a .zip brings several.
    const videos = job.videos;
    const step = Math.min(...videos.map((v) => STAGE_ORDER[v.stage] ?? 1));
    root.querySelectorAll('.stages li').forEach((li, i) => {
      li.classList.toggle('done', i < step || (i === step && step === 3));
      li.classList.toggle('current', i === step && step < 3);
    });
    const current = videos.find((v) => (STAGE_ORDER[v.stage] ?? 1) === step) ?? videos[0];
    $('.stage-bar').style.width = `${Math.round(100 * (current?.progress ?? 0))}%`;
    $('.queue').innerHTML =
      job.state === 'queued' && job.position > 0
        ? job.position === 1 ? T('aheadOne') : T('aheadMany', { n: job.position })
        : videos.length > 1
          ? T('ready', { done: videos.filter((v) => v.stage === 'done').length, total: videos.length })
          : '';
    drawChooser(job);
  }

  // People on the first frame: the selected one highlighted, a click picks another (W5.3).
  let chooserFor = null;
  function drawChooser(job) {
    const n = job.videos.findIndex((v) => v.people?.length && v.frame_size);
    const chooser = $('.chooser');
    chooser.hidden = n < 0 || job.videos[n].people.length < 2;
    if (chooser.hidden) return;
    const video = job.videos[n];
    const [w, h] = video.frame_size;
    const img = chooser.querySelector('img');
    const key = `${job.job_id}/${n}/${video.first_frame}`;
    if (chooserFor !== key) {
      img.src = firstFrameUrl(api.url, job.job_id, n);
      chooserFor = key;
    }
    const svg = chooser.querySelector('svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.innerHTML = video.people
      .map(({ box: [x0, y0, x1, y1], selected }) =>
        `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="${Math.min(w, h) / 80}" class="${selected ? 'selected' : ''}" />`)
      .join('');
    svg.onclick = async (event) => {
      const rect = svg.getBoundingClientRect();
      const x = Math.round(((event.clientX - rect.left) / rect.width) * w);
      const y = Math.round(((event.clientY - rect.top) / rect.height) * h);
      try {
        await chooseSubject(api.url, job.job_id, n, x, y);
      } catch (error) {
        return fail(describeError(error));
      }
      follow();
    };
  }

  // Where to start: no server, an upload in progress from before, or a fresh pick.
  // Off: says which server it tried, and can ask again (the tunnel may just have been slow).
  // api.url is final once the server was looked for (data/serve.sh publishes where it is).
  const showServer = () =>
    ($('.server-url').innerHTML = api.url ? T('server', { url: escapeHtml(api.url) }) : T('serverOff'));
  $('.retry').onclick = async () => {
    $('.retry').disabled = true;
    $('.retry').innerHTML = T('trying');
    const ok = await api.recheck();
    $('.retry').disabled = false;
    $('.retry').innerHTML = T('retry');
    showServer();
    if (!gone && ok) show('pick');
  };

  api.checked.then((ok) => {
    if (gone) return;
    showServer();
    if (!ok) return show('off');
    if (session?.error) return fail(session.error);
    if (session?.jobId) return follow();
    show('pick');
  });

  return () => {
    gone = true;
    abort?.abort(); // stops polling; the server keeps processing
    cancelAnimationFrame(exampleFrame);
    example.dispose();
    trainBox.dispose(); // the training goes on (training.js); coming back shows it again
  };
}
