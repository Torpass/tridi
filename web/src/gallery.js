// Gallery of preloaded simulations (W2): one card per clip; a click shows it on the stage.
import { fetchClip, preloaded, userClips } from './preloaded.js';
import { T } from './strings-stage.js';
import { clipName, spans } from './strings-names.js';

function describe(clip) {
  const seconds = clip.frames.length / clip.fps;
  return T('meta', { seconds: seconds.toFixed(0), pct: Math.round(100 * clip.quality.valid_ratio) });
}

/**
 * @param initialClip  id of the clip to show first (from #/simulations/<id>), else the first
 * @param onSelect     called with the gallery item on every pick (the Entrenar box follows it)
 * @param options.hide ids of preloaded clips to leave out of this gallery; the clips stay
 *                     available everywhere else (preloaded.js still lists them)
 */
export function mountGallery(root, stage, initialClip, onSelect, { hide = [] } = {}) {
  const list = root.querySelector('#gallery');
  const preloadedVisible = preloaded.filter((item) => !hide.includes(item.clip));
  const items = [...userClips, ...preloadedVisible];
  const cards = [];

  const appendSectionHeader = (key) => {
    const li = document.createElement('li');
    li.className = 'gallery-section-head';
    li.innerHTML = T(key);
    list.append(li);
  };

  if (userClips.length > 0) appendSectionHeader('groupUser');

  items.forEach((item, idx) => {
    if (idx === userClips.length) appendSectionHeader('groupPreloaded');
    const isUser = Boolean(item.data);
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.className = `card ${isUser ? 'card-user' : 'card-preloaded'}`;
    const badge = T(isUser ? 'badgeTrainable' : 'badgeTrained');
    button.innerHTML = `<span class="card-top"><strong></strong><span class="card-badge ${isUser ? 'trainable' : 'trained'}">${badge}</span></span><span class="meta">…</span><span class="credit"></span>`;
    const names = clipName(item);
    button.querySelector('strong').innerHTML = spans(names.title);
    button.querySelector('.credit').innerHTML = spans(names.credit);
    button.onclick = () => select(item, button);
    li.append(button);
    list.append(li);
    fetchClip(item).then(
      (clip) => (button.querySelector('.meta').innerHTML = describe(clip)),
      () => (button.querySelector('.meta').innerHTML = T('downloadFailed')),
    );
    cards.push(button);
  });

  async function select(item, button) {
    for (const card of cards) card.removeAttribute('aria-current');
    button.setAttribute('aria-current', 'true');
    onSelect?.(item);
    try {
      stage.showClip(await fetchClip(item), spans(clipName(item).title));
    } catch (error) {
      button.querySelector('.meta').innerHTML = T('downloadRetry');
      console.error(error);
    }
  }

  // The page never opens empty: a clip starts playing right away (W2.3).
  const first = Math.max(0, items.findIndex((item) => item.clip === initialClip));
  if (cards.length) select(items[first], cards[first]);
}
