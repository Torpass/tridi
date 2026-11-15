// Scroll-overflow edge fade utility (inspired by portfolio [data-cap]).
// Toggles .is-scrolled / .is-more (vertical) and .is-scrolled-x / .is-more-x (horizontal)
// on scrollable containers so CSS mask-image gradients fade clipped content cleanly.

const SELECTOR =
  '[data-scroll-fade], #gallery, .asm-code, .asm-table-wrap, .dl-table-wrap, .dl-episodes, .docs-nav-list';

const BOUND = new WeakSet();

function updateFade(el) {
  const vOverflow = el.scrollHeight - el.clientHeight > 2;
  el.classList.toggle('is-scrolled', vOverflow && el.scrollTop > 2);
  el.classList.toggle(
    'is-more',
    vOverflow && el.scrollTop + el.clientHeight < el.scrollHeight - 2,
  );

  const hOverflow = el.scrollWidth - el.clientWidth > 2;
  el.classList.toggle('is-scrolled-x', hOverflow && el.scrollLeft > 2);
  el.classList.toggle(
    'is-more-x',
    hOverflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
  );
}

function bindElement(el, ro) {
  if (BOUND.has(el)) {
    updateFade(el);
    return;
  }
  BOUND.add(el);
  el.addEventListener('scroll', () => updateFade(el), { passive: true });
  ro.observe(el);
  for (const child of el.children) ro.observe(child);
  requestAnimationFrame(() => updateFade(el));
}

let sharedRO = null;
let sharedMO = null;

export function mountScrollFade(root = document) {
  if (typeof window === 'undefined') return;
  if (!sharedRO) {
    sharedRO = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target;
        if (target.matches?.(SELECTOR)) updateFade(target);
        else if (target.parentElement?.matches?.(SELECTOR)) updateFade(target.parentElement);
      }
    });
  }
  const scan = (scope) => {
    const els = scope.querySelectorAll ? scope.querySelectorAll(SELECTOR) : [];
    for (const el of els) bindElement(el, sharedRO);
  };
  scan(root);
  if (!sharedMO && document.body) {
    sharedMO = new MutationObserver(() => scan(document));
    sharedMO.observe(document.body, { childList: true, subtree: true });
  }
}
