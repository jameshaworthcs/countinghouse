// Applies the saved theme and privacy mode before first paint (kept external for the CSP).
(function () {
  try {
    var pref = localStorage.getItem('finance.theme') || 'system';
    var dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    if (localStorage.getItem('finance.privacy') === 'on') document.documentElement.setAttribute('data-privacy', 'on');
  } catch {
    /* storage unavailable: defaults apply */
  }
})();
