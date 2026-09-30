/** Scroll the page, and any inner scroller marked `data-scroll-top`, back to the top. */
export function scrollToTop(): void {
  const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  window.scrollTo({ top: 0, behavior });
  for (const el of document.querySelectorAll<HTMLElement>('[data-scroll-top]')) el.scrollTo({ top: 0, behavior });
}
