// Runs synchronously in <head> (an external file, so the strict CSP allows it): applies the saved theme before first paint to avoid a flash.
try { const t = localStorage.getItem('rd_theme'); if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t) } catch { /* storage unavailable: follow the system theme */ }
