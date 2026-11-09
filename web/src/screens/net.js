// #/net/<train id>: one training, alone and full size: its policy network (netview.js), how far it
// is and a button to cancel it. The training box links here in a new tab, and the link survives
// reloads and server restarts: a training lives on the server, while the box only exists in the
// tab that started it.
import { cancelTraining } from '../../../data/live/src/upload.js';
import { mountNetView } from '../netview.js';
import { progressLine } from '../training.js';
import { T, t } from './strings/net.js';
import { escapeHtml as escape } from '../i18n.js';

export { title } from './strings/net.js';

// Same cadence as the training box (TRAIN_POLL_MS in data/live/src/upload.js).
const POLL_MS = 2000;

export function mount(app, { api }, [trainId]) {
  app.innerHTML = `
    <main class="net-screen">
      <a class="button" href="#/">${T('back')}</a>
      <section class="train-box"><div data-train="progress"><div class="train-net"></div></div></section>
      <div class="net-screen-bar">
        <p class="net-screen-note">${T('looking')}</p>
        <a class="button net-screen-delivery" hidden>${T('delivery')}</a>
        <button class="net-screen-cancel" type="button" hidden>${T('cancel')}</button>
      </div>
    </main>`;
  const $ = (s) => app.querySelector(s);
  const note = $('.net-screen-note');
  if (!trainId) {
    note.innerHTML = T('missing');
    return () => {};
  }
  let view = null;
  try {
    view = mountNetView($('.train-net'));
  } catch (error) {
    console.error(error);
    $('.train-net').hidden = true; // no WebGL: the status and the cancel button still work
  }
  let gone = false;
  let timer = null;

  async function poll() {
    timer = null;
    if (gone) return;
    let tr = null;
    try {
      const res = await fetch(`${api.url.replace(/\/$/, '')}/train/${trainId}`, { cache: 'no-store' });
      if (res.status === 404) {
        note.innerHTML = T('gone');
        $('.net-screen-cancel').hidden = true;
        view?.follow(api.url, trainId, false);
        return; // nothing left to follow
      }
      if (res.ok) tr = await res.json();
    } catch {
      // The tunnel can drop for a moment: keep the last line and ask again.
    }
    if (gone) return;
    if (tr) {
      const active = tr.state === 'queued' || tr.state === 'running';
      note.innerHTML =
        tr.state === 'done'
          ? T('done', { followed: tr.followed_s ?? 0, duration: tr.duration_s })
          : tr.state === 'failed'
            ? T('failed', { error: escape(tr.error) })
            : progressLine({ phase: 'watching', train: tr });
      $('.net-screen-cancel').hidden = !active;
      $('.net-screen-delivery').hidden = tr.state !== 'done' || Boolean(tr.error);
      $('.net-screen-delivery').href = `#/delivery/${encodeURIComponent(tr.clip_id)}`;
      view?.follow(api.url, trainId, active && tr.stage !== 'data');
      if (!active) return;
    }
    timer = setTimeout(poll, POLL_MS);
  }

  $('.net-screen-cancel').onclick = async () => {
    if (!confirm(t('confirm'))) return;
    $('.net-screen-cancel').disabled = true;
    try {
      await cancelTraining(api.url, trainId);
    } catch (error) {
      note.innerHTML = T('cancelFailed', { error: escape(error.message) });
      $('.net-screen-cancel').disabled = false;
      return;
    }
    clearTimeout(timer);
    poll();
  };

  api.checked.then(() => {
    if (gone) return;
    if (!api.ok) note.innerHTML = T('serverOff');
    else poll();
  });
  return () => {
    gone = true;
    clearTimeout(timer);
    view?.dispose();
  };
}
