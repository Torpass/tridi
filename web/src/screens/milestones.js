// Avances y casos reales (#/milestones, #/avances):
// 1. Milestone 02 (Nov 2026): First physical Sim-to-Real case study on Luigi D'Aquaro's differential robot
//    (6 CAD STL meshes -> MuJoCo digital twin -> 50 Hz ONNX embedded on ATmega328P -> 40 Hz IR radar 0x9E & PCINT1).
// 2. Milestone 01 (Oct 2026): Platanus Hack 26 Caracas origin story + official live demo & pitch video (2:53, before Q&A).
import { appHeaderHTML, mountAppHeader } from '../header.js';
import { A, T, title } from './strings/milestones.js';

export { title };

const MEDIA = `${import.meta.env.BASE_URL}media/`;

export function mount(root) {
  root.innerHTML = `
    <section class="page milestones-page">
      ${appHeaderHTML({ current: 'milestones' })}
      <div class="milestones-head">
        <div class="milestones-title-group">
          <h1>${T('head')}</h1>
          <p class="lead milestones-lede">${T('lede')}</p>
        </div>
        <div class="milestone-tabs" role="tablist">
          <button type="button" class="milestone-tab" role="tab" data-tab="sim-to-real" aria-selected="true">
            ${T('tabSim2Real')}
          </button>
          <button type="button" class="milestone-tab" role="tab" data-tab="platanus-hack" aria-selected="false">
            ${T('tabHackathon')}
          </button>
        </div>
      </div>

      <article class="milestone-card" id="sim-to-real" data-panel="sim-to-real">
        <div class="milestone-meta">
          <span class="milestone-badge signal">${T('m2.badge')}</span>
          <div class="milestone-cta-row">
            <a class="button primary milestone-cta" href="#/simulations/luigi_lab3">${T('m2.ctaSim')}</a>
            <a class="button milestone-cta" href="#/simulations/luigi_lab4">${T('m2.ctaLab4')}</a>
          </div>
        </div>
        <h2>${T('m2.title')}</h2>
        <p class="milestone-intro">${T('m2.intro')}</p>

        <div class="milestone-videos two-col">
          <figure class="milestone-video-box">
            <div class="milestone-video-head">${T('m2.vidFloorLabel')}</div>
            <video src="${MEDIA}luigi-sim2real.mp4" controls playsinline preload="metadata"></video>
            <figcaption>${T('m2.vidFloorCap')}</figcaption>
          </figure>
          <figure class="milestone-video-box">
            <div class="milestone-video-head">${T('m2.vidHwLabel')}</div>
            <video src="${MEDIA}luigi-hardware.mp4" controls playsinline preload="metadata"></video>
            <figcaption>${T('m2.vidHwCap')}</figcaption>
          </figure>
        </div>

        <h3 class="milestone-subhead">${T('m2.stepsTitle')}</h3>
        <div class="milestone-steps-grid">
          <div class="milestone-step">
            <h4>${T('m2.s1.title')}</h4>
            <p>${T('m2.s1.body')}</p>
          </div>
          <div class="milestone-step">
            <h4>${T('m2.s2.title')}</h4>
            <p>${T('m2.s2.body')}</p>
          </div>
          <div class="milestone-step">
            <h4>${T('m2.s3.title')}</h4>
            <p>${T('m2.s3.body')}</p>
          </div>
          <div class="milestone-step">
            <h4>${T('m2.s4.title')}</h4>
            <p>${T('m2.s4.body')}</p>
          </div>
        </div>

        <h3 class="milestone-subhead">${T('m2.galleryTitle')}</h3>
        <div class="milestone-gallery-grid">
          <figure class="milestone-photo-card" tabindex="0" role="button" data-photo-idx="0">
            <div class="milestone-photo-tag"><span>${T('m2.g1.tag')}</span><span class="milestone-zoom-pill">⤢</span></div>
            <img src="${MEDIA}luigi-cad-robot.png" alt="CAD 3D Robot Luigi" loading="lazy" />
            <figcaption>${T('m2.g1.cap')}</figcaption>
          </figure>
          <figure class="milestone-photo-card" tabindex="0" role="button" data-photo-idx="1">
            <div class="milestone-photo-tag"><span>${T('m2.g2.tag')}</span><span class="milestone-zoom-pill">⤢</span></div>
            <img src="${MEDIA}luigi-cad-planta.png" alt="Plano de planta CAD Robot Luigi" loading="lazy" />
            <figcaption>${T('m2.g2.cap')}</figcaption>
          </figure>
          <figure class="milestone-photo-card" tabindex="0" role="button" data-photo-idx="2">
            <div class="milestone-photo-tag"><span>${T('m2.g3.tag')}</span><span class="milestone-zoom-pill">⤢</span></div>
            <img src="${MEDIA}luigi-cad-frente.png" alt="CAD frontal sensores HC-SR04 y APDS-9960" loading="lazy" />
            <figcaption>${T('m2.g3.cap')}</figcaption>
          </figure>
          <figure class="milestone-photo-card" tabindex="0" role="button" data-photo-idx="3">
            <div class="milestone-photo-tag"><span>${T('m2.g4.tag')}</span><span class="milestone-zoom-pill">⤢</span></div>
            <img src="${MEDIA}luigi-real-sensores.jpg" alt="Sensores reales HC-SR04 y APDS-9960" loading="lazy" />
            <figcaption>${T('m2.g4.cap')}</figcaption>
          </figure>
          <figure class="milestone-photo-card" tabindex="0" role="button" data-photo-idx="4">
            <div class="milestone-photo-tag"><span>${T('m2.g5.tag')}</span><span class="milestone-zoom-pill">⤢</span></div>
            <img src="${MEDIA}luigi-real-cables.jpg" alt="Cableado real Arduino UNO y L298N" loading="lazy" />
            <figcaption>${T('m2.g5.cap')}</figcaption>
          </figure>
          <figure class="milestone-photo-card" tabindex="0" role="button" data-photo-idx="5">
            <div class="milestone-photo-tag"><span>${T('m2.g6.tag')}</span><span class="milestone-zoom-pill">⤢</span></div>
            <img src="${MEDIA}luigi-real-abajo.jpg" alt="Tren motriz inferior y baterías 18650" loading="lazy" />
            <figcaption>${T('m2.g6.cap')}</figcaption>
          </figure>
        </div>
      </article>

      <dialog class="photo-viewer" id="milestone-lightbox" ${A({ 'aria-label': 'm2.galleryTitle' })}>
        <div class="room">
          <button type="button" class="v-close" id="lightbox-close" ${A({ 'aria-label': 'm2.closeModal' })}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"></path>
            </svg>
          </button>
          <button type="button" class="v-prev" id="lightbox-prev" ${A({ 'aria-label': 'm2.prevPhoto' })}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"></path>
            </svg>
          </button>
          <figure class="frame">
            <div class="stage">
              <div class="layer is-shown" data-layer="0">
                <img class="fill" alt="" aria-hidden="true" />
                <img class="photo" alt="" />
              </div>
              <div class="layer" data-layer="1">
                <img class="fill" alt="" aria-hidden="true" />
                <img class="photo" alt="" />
              </div>
            </div>
            <figcaption>
              <div class="v-meta-top">
                <span class="milestone-badge signal" id="lightbox-tag"></span>
                <span class="v-count" id="lightbox-counter"></span>
              </div>
              <span class="v-caption" id="lightbox-cap"></span>
            </figcaption>
          </figure>
          <button type="button" class="v-next" id="lightbox-next" ${A({ 'aria-label': 'm2.nextPhoto' })}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"></path>
            </svg>
          </button>
        </div>
      </dialog>

      <article class="milestone-card" id="platanus-hack" data-panel="platanus-hack" hidden>
        <div class="milestone-meta">
          <span class="milestone-badge signal">${T('m1.badge')}</span>
          <div class="milestone-cta-row">
            <a class="button primary milestone-cta" href="#/simulations">${T('m1.ctaSims')}</a>
            <a class="button milestone-cta" href="#/delivery">${T('m1.ctaDelivery')}</a>
          </div>
        </div>
        <h2>${T('m1.title')}</h2>
        <p class="milestone-intro">${T('m1.intro')}</p>

        <div class="milestone-videos one-col">
          <figure class="milestone-video-box">
            <div class="milestone-video-head">${T('m1.vidLabel')}</div>
            <video src="${MEDIA}platanus-pitch.mp4" controls playsinline preload="metadata"></video>
            <figcaption>${T('m1.vidCap')}</figcaption>
          </figure>
        </div>

        <h3 class="milestone-subhead">${T('m1.evolTitle')}</h3>
        <div class="milestone-steps-grid three-col">
          <div class="milestone-step">
            <h4>${T('m1.e1.title')}</h4>
            <p>${T('m1.e1.body')}</p>
          </div>
          <div class="milestone-step">
            <h4>${T('m1.e2.title')}</h4>
            <p>${T('m1.e2.body')}</p>
          </div>
          <div class="milestone-step">
            <h4>${T('m1.e3.title')}</h4>
            <p>${T('m1.e3.body')}</p>
          </div>
        </div>
      </article>
    </section>
  `;

  const tabs = [...root.querySelectorAll('.milestone-tab')];
  const panels = [...root.querySelectorAll('[data-panel]')];
  const selectTab = (id) => {
    tabs.forEach((btn) => btn.setAttribute('aria-selected', String(btn.dataset.tab === id)));
    panels.forEach((panel) => {
      const active = panel.dataset.panel === id;
      panel.hidden = !active;
      if (!active) panel.querySelectorAll('video').forEach((v) => v.pause());
    });
  };
  tabs.forEach((btn) => {
    btn.onclick = () => selectTab(btn.dataset.tab);
  });

  // Fullscreen Lightbox for Physical Architecture gallery (cross-fading dual-layer stage with smooth fade in/out)
  const photoCards = [...root.querySelectorAll('.milestone-photo-card')];
  const dialog = root.querySelector('#milestone-lightbox');
  const layers = [...root.querySelectorAll('#milestone-lightbox .layer')];
  const lbTag = root.querySelector('#lightbox-tag');
  const lbCap = root.querySelector('#lightbox-cap');
  const lbCounter = root.querySelector('#lightbox-counter');
  const lbClose = root.querySelector('#lightbox-close');
  const lbPrev = root.querySelector('#lightbox-prev');
  const lbNext = root.querySelector('#lightbox-next');
  let activePhotoIdx = 0;
  let activeLayer = 0;
  let closeTimer = null;
  let lastTriggerEl = null;

  const paintLayer = (layer, src, alt) => {
    const fill = layer?.querySelector('.fill');
    const photo = layer?.querySelector('.photo');
    if (!photo || !fill) return Promise.resolve();
    if (photo.getAttribute('src') === src) return Promise.resolve();
    fill.src = src;
    photo.src = src;
    photo.alt = alt || '';
    return photo.decode ? photo.decode().catch(() => {}) : Promise.resolve();
  };

  const renderPhoto = async (idx, animate = true) => {
    if (!photoCards.length || !dialog) return;
    activePhotoIdx = (idx + photoCards.length) % photoCards.length;
    const card = photoCards[activePhotoIdx];
    const img = card.querySelector('img');
    const tag = card.querySelector('.milestone-photo-tag span');
    const cap = card.querySelector('figcaption');
    const src = img?.src || '';
    const alt = img?.alt || '';

    lbTag.innerHTML = tag ? tag.innerHTML : '';
    lbCap.innerHTML = cap ? cap.innerHTML : '';
    lbCounter.textContent = `${activePhotoIdx + 1} / ${photoCards.length}`;

    if (!animate) {
      await paintLayer(layers[activeLayer], src, alt);
      layers[activeLayer]?.classList.add('is-shown');
      layers[1 - activeLayer]?.classList.remove('is-shown');
    } else {
      const next = 1 - activeLayer;
      await paintLayer(layers[next], src, alt);
      layers[next]?.classList.add('is-shown');
      layers[activeLayer]?.classList.remove('is-shown');
      activeLayer = next;
    }

    // Preload neighbors for instant arrow switching
    for (const step of [-1, 1]) {
      const neighbor = photoCards[(activePhotoIdx + step + photoCards.length) % photoCards.length]?.querySelector('img');
      if (neighbor?.src) {
        const pre = new Image();
        pre.src = neighbor.src;
      }
    }
  };

  const openPhoto = async (idx, triggerEl = photoCards[idx]) => {
    if (!dialog) return;
    lastTriggerEl = triggerEl || document.activeElement;
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    await renderPhoto(idx, false);
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => {
      dialog.classList.add('is-visible');
      lbClose?.focus();
    });
  };

  const closeLightbox = () => {
    if (!dialog || !dialog.open) return;
    dialog.classList.remove('is-visible');
    if (closeTimer !== null) clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      dialog.close();
      closeTimer = null;
      lastTriggerEl?.focus?.();
    }, 450);
  };

  photoCards.forEach((card, idx) => {
    card.onclick = () => openPhoto(idx);
    card.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPhoto(idx);
      }
    };
  });

  if (lbClose) lbClose.onclick = closeLightbox;
  if (lbPrev) lbPrev.onclick = () => renderPhoto(activePhotoIdx - 1, true);
  if (lbNext) lbNext.onclick = () => renderPhoto(activePhotoIdx + 1, true);
  dialog?.addEventListener('click', (e) => {
    const t = e.target;
    if (t === dialog || t?.classList?.contains('room')) closeLightbox();
  });
  dialog?.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeLightbox();
  });

  const onKeyDown = (e) => {
    if (!dialog || !dialog.open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeLightbox();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      renderPhoto(activePhotoIdx - 1, true);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      renderPhoto(activePhotoIdx + 1, true);
    }
  };
  const unHeader = mountAppHeader(root);
  window.addEventListener('keydown', onKeyDown);
  return () => {
    unHeader();
    if (closeTimer !== null) clearTimeout(closeTimer);
    window.removeEventListener('keydown', onKeyDown);
  };
}
