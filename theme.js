/* Lost Memories theme engine, shared by the phone app and the PC app (loaded from /m/theme.js).
 * Loaded in <head> before the page draws, so there's no flash of the wrong theme.
 * localStorage: lm.theme = amber|wine|neon|volt, lm.mode = dark|light|auto. */
(function () {
  const THEMES = [
    { id: 'amber', name: 'کهربایی', note: 'ابسیدین و طلایی', bg: '#090b10', panel: '#121620', a: '#f59e0b', b: '#fcd34d' },
    { id: 'wine', name: 'شرابی', note: 'زغالی و زرشکی ملایم', bg: '#0e0c0d', panel: '#201c1e', a: '#e6667e', b: '#d4a656' },
    { id: 'neon', name: 'نئون', note: 'زمردی و فیروزه‌ای', bg: '#06080c', panel: '#0d1117', a: '#00f5a0', b: '#00e5ff' },
    { id: 'volt', name: 'ولت', note: 'لیمویی و کبالتی', bg: '#050709', panel: '#111620', a: '#ccff00', b: '#2563eb' },
  ];
  const MODES = [['dark', '🌙 تاریک'], ['light', '☀️ روشن'], ['auto', '💻 خودکار']];
  const get = (k, d) => { try { return localStorage.getItem('lm.' + k) || d; } catch { return d; } };
  const put = (k, v) => { try { localStorage.setItem('lm.' + k, v); } catch { /* private mode */ } };
  const mq = window.matchMedia ? matchMedia('(prefers-color-scheme: light)') : { matches: false };
  const listeners = [];

  function apply() {
    const theme = THEMES.some(t => t.id === get('theme')) ? get('theme') : 'amber';
    const pref = get('mode', 'dark');
    const mode = pref === 'auto' ? (mq.matches ? 'light' : 'dark') : pref;
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.mode = mode;
    // browser / Android status bar colour follows the page background
    requestAnimationFrame(() => {
      const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
      document.querySelectorAll('meta[name="theme-color"]').forEach(m => { m.removeAttribute('media'); m.setAttribute('content', bg); });
    });
    listeners.forEach(fn => fn({ theme, mode, pref }));
  }
  if (mq.addEventListener) mq.addEventListener('change', apply);

  function el(tag, cls, ...kids) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    for (const k of kids) if (k != null) e.append(k.nodeType ? k : String(k));
    return e;
  }

  // the "appearance" settings: a mode switch and one card per theme with a small preview
  function picker() {
    const wrap = el('div', 'theme-picker');
    const draw = () => {
      const seg = el('div', 'seg');
      for (const [id, label] of MODES) {
        const b = el('button', get('mode', 'dark') === id ? 'on' : '', label);
        b.type = 'button';
        b.onclick = () => { put('mode', id); apply(); draw(); };
        seg.append(b);
      }
      const sws = el('div', 'swatches');
      const cur = document.documentElement.dataset.theme;
      for (const t of THEMES) {
        const prev = el('div', 'prev');
        prev.style.background = t.bg;
        const card = el('i'); Object.assign(card.style, { inset: '8px 8px 8px 38%', background: t.panel, borderRadius: '5px' });
        const bar = el('i'); Object.assign(bar.style, { left: '10px', right: '45%', bottom: '12px', height: '5px', background: `linear-gradient(90deg, ${t.a}, ${t.b})` });
        const chip = el('i'); Object.assign(chip.style, { left: '10px', top: '10px', width: '30%', height: '10px', borderRadius: '99px', background: t.a });
        const poster = el('i'); Object.assign(poster.style, { right: '12px', top: '12px', width: '16%', height: '22px', background: t.b, opacity: '.8' });
        prev.append(card, poster, chip, bar);
        const b = el('button', 'sw' + (t.id === cur ? ' on' : ''), prev, el('b', '', t.name), el('span', '', t.note));
        b.type = 'button';
        b.onclick = () => { put('theme', t.id); apply(); draw(); };
        sws.append(b);
      }
      wrap.replaceChildren(seg, sws);
    };
    draw();
    return wrap;
  }

  window.LMTheme = {
    THEMES, picker, apply,
    onChange: fn => listeners.push(fn),
    get theme() { return document.documentElement.dataset.theme; },
    get mode() { return document.documentElement.dataset.mode; },
    cycle() {                                       // quick button: next theme
      const i = THEMES.findIndex(t => t.id === this.theme);
      put('theme', THEMES[(i + 1) % THEMES.length].id); apply();
      return THEMES[(i + 1) % THEMES.length];
    },
    toggleMode() { put('mode', this.mode === 'dark' ? 'light' : 'dark'); apply(); },
  };
  apply();
})();
