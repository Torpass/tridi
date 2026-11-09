// Shown when a screen's code cannot be downloaded (no connection, or a deploy replaced it).
import { T } from '../strings-stage.js';

export const title = { es: 'Sin conexión', en: 'Offline' };

export function mount(root) {
  root.innerHTML = `
    <section class="page narrow">
      <a class="back" href="#/">${T('offlineBack')}</a>
      <h1>${T('offlineHead')}</h1>
      <p class="lead">${T('offlineLead')}</p>
      <button class="primary" type="button">${T('offlineRetry')}</button>
    </section>`;
  root.querySelector('button').onclick = () => location.reload();
  return () => {};
}
