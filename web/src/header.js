// Unified Global App Header for all Tridi Studio & Case Study screens.
// Follows the "One of Everything & Zero Twin Drift" standard: every inner screen
// (#/simulations, #/live, #/upload, #/delivery, #/assembler, #/milestones) renders
// the exact same top navigation bar so the user always sees how Tridi's screens connect.
import { LOGO, WORDMARK } from './brand.js';
import { dict, langSwitch } from './i18n.js';
import { prefetch } from './router.js';

const { T, A } = dict({
  home: { es: 'Tridi, inicio', en: 'Tridi, home' },
  nav: { es: 'Navegación de Tridi Studio', en: 'Tridi Studio navigation' },
  simulations: { es: 'Simulaciones', en: 'Simulations' },
  live: { es: 'Cámara en vivo', en: 'Live Camera' },
  upload: { es: 'Subir video', en: 'Upload Video' },
  delivery: { es: 'Entregas', en: 'Deliveries' },
  assembler: { es: 'Assembler', en: 'Assembler' },
  milestones: { es: 'Avances', en: 'Milestones' },
});

const NAV_ITEMS = [
  { id: 'simulations', href: '#/simulations', key: 'simulations' },
  { id: 'live', href: '#/live', key: 'live' },
  { id: 'upload', href: '#/upload', key: 'upload' },
  { id: 'delivery', href: '#/delivery', key: 'delivery' },
  { id: 'assembler', href: '#/assembler', key: 'assembler' },
  { id: 'milestones', href: '#/milestones', key: 'milestones', sepBefore: true },
];

export function appHeaderHTML({ current, rightSlot = '' } = {}) {
  return `
  <header class="app-topbar" data-screen="${current ?? ''}">
    <div class="app-topbar-left">
      <a class="wordmark" href="#/" ${A({ 'aria-label': 'home' })}>${LOGO}${WORDMARK}</a>
    </div>
    <nav class="app-topnav" ${A({ 'aria-label': 'nav' })}>
      ${NAV_ITEMS.map((item) => {
        const isCurrent = item.id === current;
        const sep = item.sepBefore ? '<i class="app-nav-sep" aria-hidden="true"></i>' : '';
        return `${sep}<a class="app-nav-link${isCurrent ? ' active' : ''}" href="${item.href}" data-warm="${item.id}"${isCurrent ? ' aria-current="page"' : ''}>${T(item.key)}</a>`;
      }).join('')}
    </nav>
    <div class="app-topbar-right">
      ${rightSlot}
      ${langSwitch()}
    </div>
  </header>`;
}

export function mountAppHeader(root) {
  const cleanups = [];
  for (const link of root.querySelectorAll('.app-topbar [data-warm]')) {
    const warm = () => prefetch(link.dataset.warm);
    link.addEventListener('pointerenter', warm, { once: true });
    link.addEventListener('focus', warm, { once: true });
    cleanups.push(() => {
      link.removeEventListener('pointerenter', warm);
      link.removeEventListener('focus', warm);
    });
  }
  return () => cleanups.forEach((fn) => fn());
}
