/**
 * Keyboard access to scrolling regions (WCAG 2.1.1). A table that is wider or taller than its container
 * becomes a named, focusable region so keyboard users can scroll it; tables that fit add no tab stop.
 */
const SELECTOR = '.table-wrap, .scroll-region';

function label(el: HTMLElement) {
  const panel = el.closest('section.panel, .panel');
  const head = panel?.querySelector('.panel-head h3, h3, h2')?.textContent?.trim();
  return head ? `${head} (scrollable)` : 'Scrollable table';
}

function sync() {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(SELECTOR))) {
    const scrolls = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
    if (scrolls && el.getAttribute('tabindex') !== '0') {
      el.setAttribute('tabindex', '0'); el.setAttribute('role', 'region'); el.setAttribute('aria-label', label(el));
    } else if (!scrolls && el.hasAttribute('tabindex')) {
      el.removeAttribute('tabindex'); el.removeAttribute('role'); el.removeAttribute('aria-label');
    }
  }
}

export function watchScrollRegions() {
  let queued = false;
  const schedule = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; sync(); }); };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', schedule);
  schedule();
}
