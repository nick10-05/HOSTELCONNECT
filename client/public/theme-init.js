// Applies a saved light/dark choice before the page first paints, so there is no flash
// of the wrong mode (see src/ui/theme.tsx). A file rather than an inline script, so the
// Content Security Policy can allow scripts from this site only (script-src 'self').
// Loaded as a classic script in <head>, which blocks rendering until it has run.
try {
  var t = localStorage.getItem("hc-theme");
  if (t === "light" || t === "dark") {
    document.documentElement.dataset.theme = t;
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (m) {
      m.dataset.default = m.content;
      m.content = t === "dark" ? "#09090c" : "#fafafb";
    });
  }
} catch (e) {}
