/* Applies the saved theme before first paint (no flash of the wrong theme). External file: the CSP forbids inline scripts. */
(function () {
  var pref = 'system';
  try { pref = localStorage.getItem('gz-theme') || 'system'; } catch (e) { /* storage unavailable */ }
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme-pref', pref);
})();
