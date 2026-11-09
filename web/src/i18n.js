// Languages without a reload, the way Juan's portfolio does it: every translated string is in the
// DOM once per language (<span class="t" lang="es">…</span><span class="t" lang="en">…</span>) and
// CSS shows the one <html data-lang> names (style.css). Switching language flips one attribute: no
// re-render, no navigation, no flash, and text written later by a screen (a status line, a HUD)
// switches too, because it is written the same way (T()).
//
// What cannot be two spans (aria-label, title, placeholder, document.title, a canvas) asks for the
// current language with t() and listens with onLang().

// English is the page's language and the original of every text; Spanish is a translation, shown
// only when someone picks it (or a link asks with ?lang=es).
export const LANGS = ['en', 'es'];
export const LANG_NAMES = { en: 'English', es: 'Español' };
const KEY = 'tridi-lang';

const html = typeof document !== 'undefined' ? document.documentElement : { dataset: { lang: 'en' }, lang: 'en' };
const listeners = new Set();

/** The language on screen now. index.html's pre-paint script settled it before the first frame. */
export const lang = () => (LANGS.includes(html.dataset.lang) ? html.dataset.lang : 'en');

export function setLang(next) {
  if (!LANGS.includes(next) || next === lang()) return;
  html.dataset.lang = next;
  html.lang = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // private mode: the choice lasts this visit only
  }
  for (const element of document.querySelectorAll('[data-i18n-attr]')) applyAttrs(element);
  for (const element of document.querySelectorAll('[data-i18n-text]')) applyText(element);
  listeners.forEach((listener) => listener(next));
}

/** Calls `listener(lang)` on every switch; returns unsubscribe. */
export function onLang(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// A string is { es, en }; a value in vars may be a function of the language (a number formatted
// with its own decimal mark) or a plain value.
const fill = (text, vars, language) =>
  text.replace(/\{(\w+)\}/g, (_, name) => {
    const value = vars?.[name];
    return String(typeof value === 'function' ? value(language) : (value ?? ''));
  });

/**
 * Builds a screen's translators from its own strings, so each screen keeps its copy next to its
 * code and keys never collide between screens.
 * @param {Record<string, {es: string, en: string}>} strings
 */
export function dict(strings) {
  const get = (key, language) => {
    const entry = strings[key];
    if (!entry) {
      console.warn(`i18n: missing ${key}`);
      return key;
    }
    return entry[language] ?? entry.en ?? entry.es;
  };
  /** HTML with every language, for innerHTML and templates. Strings may hold markup. */
  const T = (key, vars) => LANGS.map((l) => `<span class="t" lang="${l}">${fill(get(key, l), vars, l)}</span>`).join('');
  /** Plain text in the current language, for attributes, titles and canvases. */
  const t = (key, vars) => fill(get(key, lang()), vars, lang());
  /** data-i18n-attr for an element: its attributes follow the language (applyAttrs). */
  const A = (attrs, vars) => {
    const map = Object.fromEntries(Object.entries(attrs).map(([attr, key]) => [attr, Object.fromEntries(LANGS.map((l) => [l, fill(get(key, l), vars, l)]))]));
    const first = Object.entries(map).map(([attr, byLang]) => `${attr}="${escapeAttr(byLang[lang()])}"`).join(' ');
    return `${first} data-i18n-attr="${escapeAttr(JSON.stringify(map))}"`;
  };
  /** Plain text that follows the language, for elements that cannot hold spans (<option>):
   * `<option ${X('key')}>${t('key')}</option>`. */
  const X = (key, vars) => textAttr(Object.fromEntries(LANGS.map((l) => [l, fill(get(key, l), vars, l)])));
  /** Plain text in a given language: for markup put together per language (several fragments). */
  const L = (key, vars, language) => fill(get(key, language), vars, language);
  /** Sets attributes that follow the language on an element already in the page: S(el, { title: 'key' }). */
  const S = (element, attrs, vars) => {
    const map = Object.fromEntries(Object.entries(attrs).map(([attr, key]) => [attr, Object.fromEntries(LANGS.map((l) => [l, fill(get(key, l), vars, l)]))]));
    element.dataset.i18nAttr = JSON.stringify(map);
    applyAttrs(element);
  };
  T.strings = strings;
  return { T, t, A, L, X, S, strings };
}

const escapeAttr = (value) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

function applyAttrs(element) {
  try {
    const map = JSON.parse(element.dataset.i18nAttr);
    for (const [attr, byLang] of Object.entries(map)) element.setAttribute(attr, byLang[lang()] ?? byLang.en ?? byLang.es);
  } catch {
    // a malformed map leaves the attribute as it was
  }
}

/** Numbers in the language's own way: 1,5 s in Spanish, 1.5 s in English. */
export const fmt = (value, digits = 1) => (language) =>
  Number(value).toLocaleString(language, { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const fmtInt = (value) => (language) => Math.round(value).toLocaleString(language);

const GLOBE_ICON =
  '<svg class="lang-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><ellipse cx="8" cy="8" rx="2.7" ry="6.2"/><path d="M2.1 6h11.8M2.1 10h11.8"/></svg>';

/** Globe-only dropdown trigger for a screen's header: clicking opens the language menu. */
export function langSwitch(className = '') {
  return `<div class="lang-switch ${className}">
    <button type="button" class="lang-trigger" aria-haspopup="menu" aria-expanded="false" aria-label="Language / Idioma" title="Language / Idioma">${GLOBE_ICON}</button>
    <div class="lang-menu" role="menu" aria-label="Language / Idioma">
      ${LANGS.map(
        (l) => `<button type="button" role="menuitemradio" data-set-lang="${l}" lang="${l}" aria-label="${LANG_NAMES[l]}"><span>${LANG_NAMES[l]}</span><i class="lang-check" aria-hidden="true">✓</i></button>`,
      ).join('')}
    </div>
  </div>`;
}

// One listener for every switch on every screen, present or future.
if (typeof document !== 'undefined') {
  const closeMenus = (except = null) => {
    for (const sw of document.querySelectorAll('.lang-switch.open')) {
      if (sw === except) continue;
      sw.classList.remove('open');
      sw.querySelector('.lang-trigger')?.setAttribute('aria-expanded', 'false');
    }
  };
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest?.('.lang-trigger');
    if (trigger) {
      const sw = trigger.closest('.lang-switch');
      const nextOpen = !sw.classList.contains('open');
      closeMenus(sw);
      sw.classList.toggle('open', nextOpen);
      trigger.setAttribute('aria-expanded', String(nextOpen));
      return;
    }
    const button = event.target.closest?.('[data-set-lang]');
    if (button) {
      setLang(button.dataset.setLang);
      closeMenus();
      return;
    }
    closeMenus();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenus();
  });
}

/** Text from outside (a server error, a file name) made safe to put inside T()'s markup. */
export const escapeHtml = (value) =>
  String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** data-i18n-text for a { es, en } map: setLang rewrites the element's text (see dict's X). */
export const textAttr = (byLang) => `data-i18n-text="${escapeAttr(JSON.stringify(byLang))}"`;

/** <option> whose text follows the language. */
export const option = (value, byLang, extra = '') =>
  `<option value="${escapeAttr(value)}" ${textAttr(byLang)}${extra ? ` ${extra}` : ''}>${escapeHtml(byLang[lang()] ?? byLang.en ?? byLang.es)}</option>`;

function applyText(element) {
  try {
    const byLang = JSON.parse(element.dataset.i18nText);
    element.textContent = byLang[lang()] ?? byLang.en ?? byLang.es;
  } catch {
    // a malformed map leaves the text as it was
  }
}
