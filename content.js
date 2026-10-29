// Hover Bookmarks Bar - content script.
// Nothing is added to the page until the first hover. After that, the whole UI
// lives inside one closed shadow root so pages can't restyle it (and it can't
// restyle them).

(() => {
  if (window.top !== window) return;

  // This script can run twice in a page: from the manifest, and again when the
  // extension is installed or updated and adds itself to tabs that were already
  // open. The newest copy wins: it tells any older copy (which may belong to a
  // previous version that can no longer reach the extension) to remove itself.
  const TAKEOVER = "hover-bookmarks-bar:takeover";
  document.dispatchEvent(new CustomEvent(TAKEOVER));
  document.addEventListener(TAKEOVER, teardown);

  const HOVER_ZONE = 4; // px at the top of the page that trigger the bar
  const REVEAL_DELAY = 150; // ms the mouse must rest in the zone
  const HIDE_DELAY = 300; // ms after the mouse leaves before hiding
  const SUBMENU_DELAY = 150; // ms hover before a nested folder opens
  const DRAG_OPEN_DELAY = 500; // ms dragging over a folder before it opens
  const OVERFLOW_ID = "__overflow__";

  // ---- State --------------------------------------------------------------

  let host = null; // <hover-bookmarks-bar>, created on first reveal
  let root = null; // its closed shadow root
  let ui = null; // { wrap, bar, items, chevron, other, add, layer }
  let visible = false;
  let lastInside = false; // was the last pointer position over our UI?
  let revealTimer = null;
  let hideTimer = null;
  let submenuTimer = null;
  let dragOpenTimer = null;
  let dragOpenEl = null;

  let tree = null; // { bar, other }
  let treeDirty = true;
  const nodes = new Map(); // id -> node
  let overflowIds = [];

  const menus = []; // open dropdowns, index = nesting level: { id, el, anchor }
  let ctxMenu = null;
  let dialog = null;
  let draggingId = null; // id of a bookmark being dragged from our UI
  let dead = false;
  let pageZoom = 1; // the tab's zoom level; the bar is scaled by 1/pageZoom
  let zoomPromise = null;

  // ---- Messaging ----------------------------------------------------------

  function alive() {
    try {
      return !dead && !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function send(type, data = {}) {
    return new Promise((resolve, reject) => {
      if (!alive()) {
        teardown();
        return reject(new Error("Extension was reloaded"));
      }
      chrome.runtime.sendMessage({ type, ...data }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        if (!resp || !resp.ok) return reject(new Error(resp ? resp.error : "No response"));
        resolve(resp.result);
      });
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "zoomChanged") {
      applyZoom(msg.zoom);
      return;
    }
    if (msg && msg.type === "bookmarksChanged") {
      treeDirty = true;
      if (visible) refresh().catch(() => {});
    }
  });

  // ---- Bookmark tree helpers ----------------------------------------------

  function indexTree() {
    nodes.clear();
    const walk = (n) => {
      nodes.set(n.id, n);
      if (n.children) n.children.forEach(walk);
    };
    if (tree.bar) walk(tree.bar);
    if (tree.other) walk(tree.other);
  }

  const isFolder = (n) => !!(n && n.children);
  const isRoot = (id) =>
    (tree.bar && id === tree.bar.id) || (tree.other && id === tree.other.id);

  // True if `ancestorId` is `id` itself or one of its parents.
  function isWithin(id, ancestorId) {
    let n = nodes.get(id);
    while (n) {
      if (n.id === ancestorId) return true;
      n = nodes.get(n.parentId);
    }
    return false;
  }

  function indexOf(node) {
    const parent = nodes.get(node.parentId);
    return parent ? parent.children.indexOf(node) : 0;
  }

  function findByUrl(url) {
    for (const n of nodes.values()) if (n.url === url) return n;
    return null;
  }

  function countBookmarks(folder) {
    let c = 0;
    for (const ch of folder.children) c += ch.children ? countBookmarks(ch) : 1;
    return c;
  }

  function urlsIn(folder) {
    return folder.children.filter((c) => c.url && !c.url.startsWith("javascript:")).map((c) => c.url);
  }

  function fixUrl(s) {
    s = s.trim();
    if (!s) return s;
    try {
      new URL(s);
      return s;
    } catch {
      return "https://" + s;
    }
  }

  // ---- DOM helpers --------------------------------------------------------

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function svg(markup) {
    const t = document.createElement("template");
    t.innerHTML = markup.trim();
    return t.content.firstChild;
  }

  const ICONS = {
    folder:
      '<svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M2 3.5C2 2.7 2.7 2 3.5 2h2.9c.4 0 .8.2 1.1.4L8.6 3.5h3.9c.8 0 1.5.7 1.5 1.5v7.5c0 .8-.7 1.5-1.5 1.5h-9C2.7 14 2 13.3 2 12.5z"/></svg>',
    globe:
      '<svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="6.2"/><path d="M1.8 8h12.4M8 1.8c-2 2.2-2 10.2 0 12.4M8 1.8c2 2.2 2 10.2 0 12.4"/></g></svg>',
    plus:
      '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M8 3v10M3 8h10"/></svg>',
    star:
      '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 1.6l1.9 4 4.3.5-3.2 3 .9 4.3L8 11.2l-3.9 2.2.9-4.3-3.2-3 4.3-.5z"/></svg>',
  };

  function makeIcon(node) {
    if (isFolder(node)) return svg(ICONS.folder);
    if (!node.url || node.url.startsWith("javascript:")) return svg(ICONS.globe);
    const img = h("img", "icon");
    img.width = 16;
    img.height = 16;
    img.alt = "";
    img.decoding = "async";
    img.src = chrome.runtime.getURL(
      "/_favicon/?pageUrl=" + encodeURIComponent(node.url) + "&size=32"
    );
    img.addEventListener("error", () => img.replaceWith(svg(ICONS.globe)), { once: true });
    return img;
  }

  function makeItem(node, kind) {
    const el = h("div", kind === "bar" ? "item" : "row");
    el.dataset.id = node.id;
    if (isFolder(node)) el.classList.add("folder");
    el.draggable = !isRoot(node.id);
    el.title = node.url ? (node.title ? node.title + "\n" + node.url : node.url) : node.title;
    el.appendChild(makeIcon(node));
    const label = kind === "bar" ? node.title : node.title || node.url || "";
    if (label) el.appendChild(h("span", "label", label));
    else el.classList.add("icon-only");
    if (kind === "row" && isFolder(node)) el.appendChild(h("span", "sub", "›"));
    return el;
  }

  // ---- Building the UI ----------------------------------------------------

  function ensureUI() {
    if (ui) {
      if (!host.isConnected) document.documentElement.appendChild(host);
      return;
    }
    host = document.createElement("hover-bookmarks-bar");
    host.style.cssText =
      "all:initial !important;position:fixed !important;top:0 !important;left:0 !important;" +
      "width:0 !important;height:0 !important;z-index:2147483647 !important;" +
      "display:block !important;pointer-events:none !important;";
    root = host.attachShadow({ mode: "closed" });

    const style = h("style");
    style.textContent = CSS_TEXT;
    root.appendChild(style);

    const wrap = h("div", "wrap");
    const bar = h("div", "bar");
    bar.setAttribute("role", "toolbar");
    const items = h("div", "items");
    const chevron = h("div", "item chevron", "»");
    chevron.title = "More bookmarks";
    chevron.hidden = true;
    const spacer = h("div", "spacer");
    const otherSlot = h("div", "other-slot");
    const add = h("div", "item add");
    bar.append(items, chevron, spacer, otherSlot, add);
    const layer = h("div", "layer");
    wrap.append(bar, layer);
    root.appendChild(wrap);

    ui = { wrap, bar, items, chevron, otherSlot, add, layer };
    wireUI();
    document.documentElement.appendChild(host);
  }

  function renderBar() {
    ui.items.textContent = "";
    if (tree.bar && tree.bar.children.length) {
      for (const child of tree.bar.children) ui.items.appendChild(makeItem(child, "bar"));
    } else {
      ui.items.appendChild(h("div", "hint", "Bookmarks bar is empty — drag links here or press +"));
    }
    ui.otherSlot.textContent = "";
    if (tree.other) ui.otherSlot.appendChild(makeItem(tree.other, "bar"));
    updateAddButton();
  }

  // The extension's own pages (welcome, etc.) aren't worth bookmarking.
  const bookmarkable = () => /^(https?|file):$/.test(location.protocol);

  function updateAddButton() {
    ui.add.hidden = !bookmarkable();
    const existing = tree ? findByUrl(location.href) : null;
    ui.add.textContent = "";
    ui.add.appendChild(svg(existing ? ICONS.star : ICONS.plus));
    ui.add.classList.toggle("starred", !!existing);
    ui.add.title = existing ? "Edit bookmark for this page" : "Bookmark this page";
  }

  // Hide whatever doesn't fit and list it in the » menu.
  function layoutOverflow() {
    const kids = [...ui.items.children];
    kids.forEach((k) => (k.hidden = false));
    ui.chevron.hidden = true;
    overflowIds = [];
    if (ui.items.scrollWidth <= ui.items.clientWidth) return;
    ui.chevron.hidden = false;
    const avail = ui.items.clientWidth;
    for (const k of kids) {
      if (k.offsetLeft + k.offsetWidth > avail) {
        k.hidden = true;
        if (k.dataset.id) overflowIds.push(k.dataset.id);
      }
    }
  }

  async function refresh() {
    const chain = menus.map((m) => m.id);
    const prevMode = tree && tree.colorMode;
    tree = await send("getTree");
    treeDirty = false;
    indexTree();
    closeCtx();
    closeAllMenus(true);
    renderBar();
    if (visible) {
      // The Bar color setting changed while the bar was open: recolor now. (No
      // snapshot here, it would capture the bar itself; read the page's CSS.)
      if (tree.colorMode !== prevMode) {
        if (pageMode()) matchPageColor(null);
        else useThemeColor();
      }
      layoutOverflow();
      reopenChain(chain);
    }
  }

  function reopenChain(chain) {
    for (let level = 0; level < chain.length; level++) {
      const id = chain[level];
      let anchor;
      if (level === 0) {
        anchor = id === OVERFLOW_ID ? ui.chevron : ui.bar.querySelector(`[data-id="${CSS.escape(id)}"]`);
      } else {
        anchor = menus[level - 1].el.querySelector(`[data-id="${CSS.escape(id)}"]`);
      }
      if (!anchor || anchor.hidden || (id !== OVERFLOW_ID && !isFolder(nodes.get(id)))) break;
      openMenu(id, anchor, level);
    }
  }

  // ---- Matching the page's color -----------------------------------------
  // Dia tints its toolbar to match the top edge of the page. Painting the bar
  // in that same color keeps the toolbar from flashing to a different color.

  let colorCtx = null;
  function parseColor(str) {
    if (!str || str === "transparent" || str === "rgba(0, 0, 0, 0)") return null;
    if (!colorCtx) {
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      colorCtx = c.getContext("2d", { willReadFrequently: true });
    }
    // Let the canvas resolve any CSS color syntax (rgb, hex, oklch, ...).
    colorCtx.clearRect(0, 0, 1, 1);
    colorCtx.fillStyle = "rgba(0,0,0,0)";
    colorCtx.fillStyle = str;
    colorCtx.fillRect(0, 0, 1, 1);
    const d = colorCtx.getImageData(0, 0, 1, 1).data;
    return d[3] ? [d[0], d[1], d[2], d[3] / 255] : null;
  }

  function pageTopColor() {
    const x = Math.round((document.documentElement.clientWidth || innerWidth) / 2);
    for (const el of document.elementsFromPoint(x, 1)) {
      if (el === host) continue;
      const cs = getComputedStyle(el);
      const c = parseColor(cs.backgroundColor);
      if (c && c[3] >= 0.5) return c;
      // A top-to-bottom gradient (e.g. github.com's header) shows its first color at the top edge.
      const grad = /^linear-gradient\((?!\s*(to (left|right)|\d))/.exec(cs.backgroundImage);
      if (grad) {
        const first = parseColor((cs.backgroundImage.match(/rgba?\([^)]*\)/) || [])[0]);
        if (first && first[3] >= 0.5) return first;
      }
    }
    // Nothing painted a background: the page shows the browser's default canvas.
    let scheme = getComputedStyle(document.documentElement).colorScheme || "";
    if (scheme === "normal") {
      const meta = document.querySelector('meta[name="color-scheme"]');
      scheme = (meta && meta.content) || "";
    }
    const darkCanvas = scheme.includes("dark") && (!scheme.includes("light") || matchMedia("(prefers-color-scheme: dark)").matches);
    return darkCanvas ? [18, 18, 18, 1] : [255, 255, 255, 1];
  }

  const mix = (c, to, t) => c.slice(0, 3).map((v, i) => Math.round(v + (to[i] - v) * t));
  const rgb = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  function luminance([r, g, b]) {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  // Prefer the real pixels (sampled by the background script from a snapshot
  // of the visible tab); fall back to reading the page's CSS.
  let colorPromise = null;
  let colorAt = 0;
  // A page that has only just loaded may not have painted its colors yet, so
  // the snapshot waits until it's at least PAINT_SETTLE ms old.
  const PAINT_SETTLE = 1200;

  function sampleColorSoon() {
    if (colorPromise && Date.now() - colorAt < 1000) return;
    colorAt = Date.now();
    const wait = Math.max(0, PAINT_SETTLE - performance.now());
    colorPromise = new Promise((r) => setTimeout(r, wait))
      .then(() => send("sampleTopColor"))
      .catch(() => null);
  }

  // "theme" mode (browsers whose toolbar doesn't change with the page): no
  // snapshot, just the default palette, which follows light/dark and uses the
  // default Chrome toolbar colors.
  function useThemeColor() {
    const w = ui.wrap;
    w.dataset.toolbar = (tree && tree.toolbar) || "chrome";
    w.classList.remove("tone-light", "tone-dark");
    w.style.removeProperty("--bg");
    w.style.removeProperty("--menu-bg");
  }

  const pageMode = () => !!tree && tree.colorMode === "page";

  function matchPageColor(sampled) {
    let c = sampled;
    if (!c) {
      try {
        c = pageTopColor();
      } catch {}
    }
    const w = ui.wrap;
    if (!c) {
      w.classList.remove("tone-light", "tone-dark");
      w.style.removeProperty("--bg");
      w.style.removeProperty("--menu-bg");
      return;
    }
    const dark = luminance(c) < 0.4;
    w.classList.toggle("tone-dark", dark);
    w.classList.toggle("tone-light", !dark);
    w.style.setProperty("--bg", rgb(c));
    w.style.setProperty("--menu-bg", rgb(dark ? mix(c, [255, 255, 255], 0.08) : mix(c, [255, 255, 255], 0.7)));
  }

  // ---- Page zoom ----------------------------------------------------------
  // The bar should feel like part of the browser, so page zoom must not change
  // its size: everything is drawn inside .wrap with CSS zoom = 1 / pageZoom.
  // Positions measured on the page (getBoundingClientRect, clientX/Y) are in
  // page pixels; ui() converts them to pixels inside .wrap.

  const toBar = (px) => px * pageZoom;
  const zone = () => HOVER_ZONE / pageZoom; // hover zone stays the same physical height

  function applyZoom(z) {
    const next = z > 0 ? z : 1;
    const changed = next !== pageZoom;
    pageZoom = next;
    if (!ui) return;
    ui.wrap.style.zoom = String(1 / pageZoom);
    if (changed && visible) {
      closeCtx();
      closeAllMenus(true);
      layoutOverflow();
    }
  }

  // ---- Show / hide --------------------------------------------------------

  const isPinnedOpen = () => menus.length > 0 || !!ctxMenu || !!dialog || !!draggingId;

  async function reveal() {
    revealTimer = null;
    if (visible || document.fullscreenElement || !alive()) return;
    ensureUI();
    try {
      if (treeDirty || !tree) await refresh();
    } catch {
      return;
    }
    if (document.fullscreenElement) return;
    if (pageMode() && !colorPromise) sampleColorSoon(); // first reveal: mode only known now
    const [sampled, zoom] = await Promise.all([pageMode() ? colorPromise : null, zoomPromise]);
    colorPromise = zoomPromise = null;
    if (zoom) applyZoom(zoom);
    if (visible || document.fullscreenElement) return;
    if (pageMode()) matchPageColor(sampled);
    else useThemeColor();
    updateAddButton();
    visible = true;
    ui.bar.classList.add("shown");
    layoutOverflow();
  }

  function hide() {
    clearTimeout(revealTimer);
    clearTimeout(hideTimer);
    revealTimer = hideTimer = null;
    if (!visible) return;
    visible = false;
    closeDialog();
    closeCtx();
    closeAllMenus(true);
    ui.bar.classList.remove("shown");
  }

  function scheduleHide() {
    if (!visible || hideTimer || isPinnedOpen()) return;
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (!isPinnedOpen() && !lastInside) hide();
    }, HIDE_DELAY);
  }

  function cancelHide() {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  function startReveal() {
    if (revealTimer) return;
    if (pageMode()) sampleColorSoon(); // runs while we wait out the reveal delay
    zoomPromise = send("getZoom").catch(() => null);
    revealTimer = setTimeout(reveal, REVEAL_DELAY);
  }

  function cancelReveal() {
    clearTimeout(revealTimer);
    revealTimer = null;
  }

  function pointInsideUI(x, y) {
    if (!root) return false;
    const el = root.elementFromPoint(x, y);
    return !!el && el !== host && root.contains(el);
  }

  // ---- Page-level listeners (cheap; run on every page) --------------------

  let lastY = -1;
  let movingUp = false;

  function onMouseMove(e) {
    movingUp = e.clientY < lastY;
    lastY = e.clientY;
    if (!visible) {
      if (e.clientY <= zone() && e.clientY >= 0 && e.buttons === 0 && !document.fullscreenElement) {
        startReveal();
      } else if (revealTimer) {
        cancelReveal();
      }
      return;
    }
    lastInside = e.target === host;
    if (lastInside) cancelHide();
    else scheduleHide();
  }

  function onMouseOut(e) {
    if (e.relatedTarget) return; // still inside the page
    lastInside = false;
    // Leaving through the top edge (into the browser's toolbar) counts as
    // hovering the top: in Dia the page doesn't start at the screen edge, so
    // the mouse usually overshoots the hover zone.
    const exitTop = e.clientY <= zone() || (movingUp && e.clientY < 60 / pageZoom); // fast flicks skip the zone
    if (exitTop && e.buttons === 0 && !document.fullscreenElement) {
      if (!visible) startReveal();
      return; // already visible: keep it up while the mouse is above the page
    }
    cancelReveal();
    scheduleHide();
  }

  function onPointerDown(e) {
    if (!visible || e.target === host) return;
    hide(); // clicked the page: done with the bar
  }

  function onKeyDown(e) {
    if (!visible || e.key !== "Escape") return;
    if (dialog) closeDialog();
    else if (ctxMenu) closeCtx();
    else if (menus.length) closeMenusFrom(menus.length - 1);
    else hide();
    e.stopPropagation();
    e.preventDefault();
    if (!isPinnedOpen() && !lastInside) scheduleHide();
  }

  function onFullscreen() {
    if (document.fullscreenElement) hide();
  }

  function onVisibility() {
    if (document.hidden) hide();
  }

  let resizeTimer = null;
  function onResize() {
    if (!visible) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      closeCtx();
      closeAllMenus(true);
      layoutOverflow();
    }, 100);
  }

  // Dragging a link from the page up to the top edge reveals the bar too.
  function onPageDragOver(e) {
    if (!visible) {
      if (e.clientY <= zone() * 2 && !document.fullscreenElement && hasDroppableLink(e.dataTransfer)) {
        startReveal();
      } else cancelReveal();
      return;
    }
    lastInside = e.target === host;
    if (lastInside) cancelHide();
  }

  function onPageDragEnd() {
    // A drag from the page (or another app) finished; tidy up if it left us.
    setTimeout(() => {
      clearDropIndicator();
      if (!draggingId && !lastInside && visible) {
        closeAllMenus(true);
        scheduleHide();
      }
    }, 0);
  }

  window.addEventListener("mousemove", onMouseMove, { capture: true, passive: true });
  document.addEventListener("mouseout", onMouseOut, { capture: true, passive: true });
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", onResize, { passive: true });
  document.addEventListener("fullscreenchange", onFullscreen);
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("dragover", onPageDragOver, true);
  document.addEventListener("dragend", onPageDragEnd, true);
  document.addEventListener("drop", onPageDragEnd, true);

  function teardown() {
    dead = true;
    document.removeEventListener(TAKEOVER, teardown);
    window.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("mouseout", onMouseOut, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("fullscreenchange", onFullscreen);
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("dragover", onPageDragOver, true);
    document.removeEventListener("dragend", onPageDragEnd, true);
    document.removeEventListener("drop", onPageDragEnd, true);
    if (host) host.remove();
  }

  // ---- Dropdown menus -----------------------------------------------------

  function openMenu(id, anchor, level) {
    closeMenusFrom(level);
    const el = h("div", "menu");
    el.dataset.level = level;
    el.dataset.folder = id;
    el.setAttribute("role", "menu");
    const list = id === OVERFLOW_ID ? overflowIds.map((i) => nodes.get(i)) : nodes.get(id).children;
    if (list.length) {
      for (const child of list) el.appendChild(makeItem(child, "row"));
    } else {
      const empty = h("div", "empty", "(empty)");
      empty.dataset.dropInto = id;
      el.appendChild(empty);
    }
    ui.layer.appendChild(el);
    anchor.classList.add("open");
    menus[level] = { id, el, anchor };
    positionMenu(el, anchor, level);
  }

  function positionMenu(el, anchor, level) {
    const g = 1 / pageZoom; // spacing below is in screen pixels, not page pixels
    const a = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    el.style.maxHeight = "";
    const w = el.getBoundingClientRect().width;
    let left, top;
    if (level === 0) {
      left = Math.min(a.left, vw - w - 4 * g);
      top = a.bottom + 2 * g;
    } else {
      left = a.right - 2 * g;
      if (left + w > vw - 4 * g) {
        const parent = menus[level - 1].el.getBoundingClientRect();
        left = parent.left - w + 2 * g;
      }
      top = a.top - 5 * g;
    }
    left = Math.max(4 * g, left);
    const maxH = vh - 8 * g;
    el.style.maxHeight = toBar(maxH - (level === 0 ? top : 0)) + "px";
    const hgt = el.getBoundingClientRect().height;
    if (level > 0 && top + hgt > vh - 4 * g) top = Math.max(4 * g, vh - 4 * g - hgt);
    el.style.left = toBar(left) + "px";
    el.style.top = toBar(top) + "px";
  }

  function closeMenusFrom(level) {
    while (menus.length > level) {
      const m = menus.pop();
      m.el.remove();
      m.anchor.classList.remove("open");
    }
  }

  function closeAllMenus(silent) {
    clearTimeout(submenuTimer);
    closeMenusFrom(0);
    if (!silent && !lastInside) scheduleHide();
  }

  function levelOf(el) {
    const menu = el.closest(".menu");
    return menu ? Number(menu.dataset.level) : -1;
  }

  // ---- Opening bookmarks --------------------------------------------------

  function dispositionFor(e) {
    if (e.button === 1) return e.shiftKey ? "foreground" : "background";
    if (e.ctrlKey || e.metaKey) return e.shiftKey ? "foreground" : "background";
    if (e.shiftKey) return "window";
    return "current";
  }

  function openNode(node, disposition) {
    if (!node.url) return;
    if (disposition === "current") hide();
    send("open", { url: node.url, disposition }).catch(() => {});
  }

  function openAll(folder, disposition) {
    const urls = urlsIn(folder);
    if (!urls.length) return;
    const go = () => send("openAll", { urls, disposition }).catch(() => {});
    if (urls.length > 15) {
      confirmDialog(`Open ${urls.length} tabs?`, "Open", go);
    } else go();
  }

  // ---- Context menu -------------------------------------------------------

  function openCtx(x, y, node) {
    closeCtx();
    const el = h("div", "menu ctx");
    el.setAttribute("role", "menu");
    const add = (label, fn, disabled) => {
      const row = h("div", "row action", label);
      if (disabled) row.classList.add("disabled");
      else row._action = fn;
      el.appendChild(row);
    };
    const sep = () => el.appendChild(h("div", "sep"));

    const barId = tree.bar.id;
    const newFolderTarget = node && !isRoot(node.id)
      ? { parentId: node.parentId, index: indexOf(node) + 1 }
      : { parentId: node && isFolder(node) ? node.id : barId };

    if (node && isFolder(node)) {
      const n = urlsIn(node).length;
      add(`Open all (${n})`, () => openAll(node, "background"), !n);
      add("Open all in new window", () => openAll(node, "window"), !n);
      if (!isRoot(node.id)) {
        sep();
        add("Rename…", () => editDialog(node));
        add("Delete", () => deleteNode(node));
      }
    } else if (node) {
      add("Open in new tab", () => openNode(node, "background"));
      add("Open in new window", () => openNode(node, "window"));
      sep();
      add("Edit…", () => editDialog(node));
      add("Delete", () => deleteNode(node));
    } else {
      if (bookmarkable()) add("Bookmark this page", addCurrentPage);
    }
    if (el.children.length) sep();
    add("New folder…", () => newFolderDialog(newFolderTarget));

    ui.layer.appendChild(el);
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const r = el.getBoundingClientRect();
    const g = 4 / pageZoom;
    el.style.left = toBar(Math.max(g, Math.min(x, vw - r.width - g))) + "px";
    el.style.top = toBar(Math.max(g, Math.min(y, vh - r.height - g))) + "px";
    ctxMenu = el;
  }

  function closeCtx() {
    if (ctxMenu) ctxMenu.remove();
    ctxMenu = null;
  }

  // ---- Dialogs ------------------------------------------------------------

  // fields: [{ name, label, value }], buttons: [{ label, primary, danger, run(values) }]
  function openDialog(title, fields, buttons) {
    closeDialog();
    closeCtx();
    const el = h("form", "dialog");
    el.setAttribute("role", "dialog");
    el.appendChild(h("div", "dialog-title", title));
    const inputs = {};
    for (const f of fields) {
      const label = h("label", "field");
      label.appendChild(h("span", "", f.label));
      const input = h("input");
      input.type = "text";
      input.value = f.value || "";
      input.spellcheck = false;
      input.autocomplete = "off";
      label.appendChild(input);
      el.appendChild(label);
      inputs[f.name] = input;
    }
    const row = h("div", "buttons");
    const values = () => Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]));
    let primary = null;
    for (const b of buttons) {
      const btn = h("button", "btn" + (b.primary ? " primary" : "") + (b.danger ? " danger" : ""), b.label);
      btn.type = b.primary ? "submit" : "button";
      if (b.primary) primary = b;
      else
        btn.addEventListener("click", () => {
          closeDialog();
          b.run && b.run(values());
        });
      row.appendChild(btn);
    }
    el.appendChild(row);
    el.addEventListener("submit", (e) => {
      e.preventDefault();
      closeDialog();
      primary && primary.run && primary.run(values());
    });
    ui.layer.appendChild(el);
    dialog = el;
    const first = el.querySelector("input") || el.querySelector(".btn.primary");
    if (first) {
      first.focus();
      if (first.select) first.select();
    }
  }

  function closeDialog() {
    if (!dialog) return;
    const d = dialog;
    dialog = null;
    d.remove();
  }

  function confirmDialog(text, okLabel, run) {
    openDialog(text, [], [
      { label: "Cancel" },
      { label: okLabel, primary: true, danger: okLabel === "Delete", run },
    ]);
  }

  function editDialog(node) {
    const folder = isFolder(node);
    openDialog(
      folder ? "Rename folder" : "Edit bookmark",
      folder
        ? [{ name: "title", label: "Name", value: node.title }]
        : [
            { name: "title", label: "Name", value: node.title },
            { name: "url", label: "URL", value: node.url },
          ],
      [
        { label: "Cancel" },
        {
          label: "Save",
          primary: true,
          run: (v) => {
            const changes = { id: node.id, title: v.title };
            if (!folder && fixUrl(v.url)) changes.url = fixUrl(v.url);
            send("update", changes).catch(() => {});
          },
        },
      ]
    );
  }

  function newFolderDialog({ parentId, index }) {
    openDialog("New folder", [{ name: "title", label: "Name", value: "New folder" }], [
      { label: "Cancel" },
      {
        label: "Create",
        primary: true,
        run: (v) => send("create", { parentId, index, title: v.title || "New folder" }).catch(() => {}),
      },
    ]);
  }

  function deleteNode(node) {
    if (isFolder(node) && node.children.length) {
      const n = countBookmarks(node);
      confirmDialog(
        `Delete “${node.title}” and ${n} bookmark${n === 1 ? "" : "s"} inside it?`,
        "Delete",
        () => send("remove", { id: node.id, isFolder: true }).catch(() => {})
      );
    } else {
      send("remove", { id: node.id, isFolder: isFolder(node) }).catch(() => {});
    }
  }

  // The +/star button: bookmark this page, or edit the existing bookmark.
  async function addCurrentPage() {
    let node = findByUrl(location.href);
    let isNew = false;
    if (!node) {
      try {
        node = await send("create", {
          parentId: tree.bar.id,
          title: document.title || location.href,
          url: location.href,
        });
        isNew = true;
      } catch {
        return;
      }
    }
    const save = (v) => {
      const url = fixUrl(v.url);
      if (v.title !== node.title || (url && url !== node.url)) {
        send("update", { id: node.id, title: v.title, url: url || undefined }).catch(() => {});
      }
    };
    openDialog(
      isNew ? "Bookmark added" : "Edit bookmark",
      [
        { name: "title", label: "Name", value: node.title },
        { name: "url", label: "URL", value: node.url },
      ],
      [
        { label: "Remove", danger: true, run: () => send("remove", { id: node.id }).catch(() => {}) },
        { label: "Done", primary: true, run: save },
      ]
    );
  }

  // ---- Drag and drop ------------------------------------------------------

  function hasDroppableLink(dt) {
    if (!dt) return false;
    const t = [...dt.types];
    return t.includes("text/uri-list") || t.includes("text/x-moz-url");
  }

  function getDropTarget(e) {
    const path = e.composedPath();
    let el = null;
    let empty = null;
    let inBar = false;
    let inChevron = false;
    for (const p of path) {
      if (!(p instanceof Element)) continue;
      if (!el && p.dataset && p.dataset.id) el = p;
      if (!empty && p.classList.contains("empty")) empty = p;
      if (p.classList.contains("chevron")) inChevron = true;
      if (p.classList.contains("bar")) inBar = true;
      if (p === ui.wrap) break;
    }
    if (inChevron) return { mode: "chevron", el: ui.chevron };
    if (el) {
      const node = nodes.get(el.dataset.id);
      if (!node) return null;
      const horizontal = el.classList.contains("item");
      const r = el.getBoundingClientRect();
      const pos = horizontal ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
      if (isFolder(node) && (isRoot(node.id) || (pos > 0.25 && pos < 0.75))) {
        return { mode: "into", el, parentId: node.id, index: undefined, horizontal };
      }
      if (isRoot(node.id)) return null;
      const before = pos < 0.5;
      return {
        mode: before ? "before" : "after",
        el,
        parentId: node.parentId,
        index: indexOf(node) + (before ? 0 : 1),
        horizontal,
      };
    }
    if (empty) return { mode: "into", el: empty, parentId: empty.dataset.dropInto, index: undefined };
    if (inBar) return nearestGap(e.clientX);
    return null;
  }

  // Over the bar but not over a bookmark (the gaps between them, or empty space):
  // insert at the nearest spot between the visible bookmarks, not at the end.
  function nearestGap(x) {
    const items = [...ui.items.children].filter((k) => k.dataset.id && !k.hidden);
    if (!items.length) return { mode: "end", el: null, parentId: tree.bar.id, index: undefined };
    for (const k of items) {
      const r = k.getBoundingClientRect();
      if (x < r.left + r.width / 2) {
        const node = nodes.get(k.dataset.id);
        return { mode: "before", el: k, parentId: node.parentId, index: indexOf(node), horizontal: true };
      }
    }
    const last = items[items.length - 1];
    const node = nodes.get(last.dataset.id);
    return { mode: "after", el: last, parentId: node.parentId, index: indexOf(node) + 1, horizontal: true };
  }

  function validDrop(target) {
    if (!target || target.mode === "chevron") return false;
    if (!draggingId) return true; // new link from the page
    if (target.el && target.el.dataset && target.el.dataset.id === draggingId) return false;
    return !isWithin(target.parentId, draggingId); // can't drop a folder into itself
  }

  let indicator = null;
  let intoEl = null;
  function showDropIndicator(target) {
    clearDropIndicator();
    if (target.mode === "into") {
      intoEl = target.el;
      intoEl.classList.add("drop-into");
      return;
    }
    if (target.mode === "end" || !target.el) return;
    const r = target.el.getBoundingClientRect();
    indicator = h("div", "indicator");
    if (target.horizontal) {
      const x = target.mode === "before" ? r.left - 1 : r.right + 1;
      Object.assign(indicator.style, { left: toBar(x) - 1 + "px", top: toBar(r.top) + "px", width: "2px", height: toBar(r.height) + "px" });
    } else {
      const y = target.mode === "before" ? r.top : r.bottom;
      Object.assign(indicator.style, { left: toBar(r.left) + "px", top: toBar(y) - 1 + "px", width: toBar(r.width) + "px", height: "2px" });
    }
    ui.layer.appendChild(indicator);
  }

  function clearDropIndicator() {
    if (indicator) indicator.remove();
    indicator = null;
    if (intoEl) intoEl.classList.remove("drop-into");
    intoEl = null;
  }

  // Hovering a folder (or ») while dragging opens it so you can drop inside.
  function scheduleDragOpen(target) {
    const el = target && (target.mode === "into" || target.mode === "chevron") ? target.el : null;
    if (el === dragOpenEl) return;
    clearTimeout(dragOpenTimer);
    dragOpenEl = el;
    if (!el || el.classList.contains("empty")) return;
    dragOpenTimer = setTimeout(() => {
      if (!el.isConnected) return;
      if (el === ui.chevron) {
        if (!(menus[0] && menus[0].id === OVERFLOW_ID)) openMenu(OVERFLOW_ID, el, 0);
      } else {
        const level = levelOf(el) + 1;
        const id = el.dataset.id;
        if (!(menus[level] && menus[level].id === id)) openMenu(id, el, level);
      }
    }, DRAG_OPEN_DELAY);
  }

  function linkFromDrop(dt) {
    let url = (dt.getData("text/uri-list") || "")
      .split(/\r?\n/)
      .find((l) => l && !l.startsWith("#"));
    if (!url) url = (dt.getData("text/x-moz-url") || "").split(/\r?\n/)[0];
    if (!url) return null;
    let title = "";
    const html = dt.getData("text/html");
    if (html) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      title = (doc.body.textContent || "").trim().replace(/\s+/g, " ");
    }
    if (!title) {
      const text = (dt.getData("text/plain") || "").trim();
      title = text && text !== url ? text : url;
    }
    return { url, title: title.slice(0, 200) };
  }

  // ---- Wiring events inside the shadow root -------------------------------

  function wireUI() {
    const { wrap, bar, chevron } = ui;

    // Keep our clicks/keys from reaching the page's own handlers.
    for (const type of [
      "click", "auxclick", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup",
      "contextmenu", "keydown", "keyup", "keypress", "input", "wheel",
    ]) {
      root.addEventListener(type, (e) => e.stopPropagation());
    }

    const itemFrom = (e) => {
      const el = e.target.closest && e.target.closest("[data-id]");
      return el && root.contains(el) ? el : null;
    };

    wrap.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault(); // no autoscroll on middle-click
    });

    wrap.addEventListener("pointerdown", (e) => {
      const t = e.target;
      if (ctxMenu && !ctxMenu.contains(t)) closeCtx();
      if (dialog && !dialog.contains(t)) closeDialog();
      if (menus.length && !t.closest(".menu") && !t.closest(".item.folder") && !t.closest(".chevron")) {
        closeAllMenus(true);
      }
    });

    wrap.addEventListener("click", (e) => {
      if (e.button !== 0) return;
      const action = e.target.closest(".row.action");
      if (action) {
        const fn = action._action;
        closeCtx(); // open folders stay open; they refresh after edits
        if (fn) fn();
        return;
      }
      if (e.target.closest(".chevron")) {
        if (menus[0] && menus[0].id === OVERFLOW_ID) closeAllMenus(true);
        else openMenu(OVERFLOW_ID, chevron, 0);
        return;
      }
      if (e.target.closest(".add")) {
        closeAllMenus(true);
        addCurrentPage();
        return;
      }
      const el = itemFrom(e);
      if (!el) return;
      const node = nodes.get(el.dataset.id);
      if (!node) return;
      if (isFolder(node)) {
        const level = levelOf(el) + 1;
        if (menus[level] && menus[level].anchor === el) {
          if (level === 0) closeAllMenus(true);
        } else {
          clearTimeout(submenuTimer);
          openMenu(node.id, el, level);
        }
        return;
      }
      openNode(node, dispositionFor(e)); // menus stay open unless it's a same-tab open
    });

    wrap.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      const el = itemFrom(e);
      const node = el && nodes.get(el.dataset.id);
      if (node && node.url) {
        e.preventDefault();
        openNode(node, dispositionFor(e)); // folder stays open for the next one
      }
    });

    wrap.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (e.target.closest(".ctx") || e.target.closest(".dialog")) return;
      const el = itemFrom(e);
      openCtx(e.clientX, e.clientY, el ? nodes.get(el.dataset.id) : null);
    });

    // Folder switching on the bar, and nested folders opening on hover.
    wrap.addEventListener("mouseover", (e) => {
      if (draggingId) return;
      const onChevron = e.target.closest(".chevron");
      const el = onChevron ? chevron : itemFrom(e);
      if (!el) return;
      const level = levelOf(el) + 1; // 0 for the bar
      if (level === 0) {
        if (!menus.length || menus[0].anchor === el) return;
        if (onChevron) openMenu(OVERFLOW_ID, chevron, 0);
        else if (el.classList.contains("folder")) openMenu(el.dataset.id, el, 0);
        return;
      }
      clearTimeout(submenuTimer);
      if (menus[level] && menus[level].anchor === el) return;
      submenuTimer = setTimeout(() => {
        if (!el.isConnected) return;
        if (el.classList.contains("folder")) openMenu(el.dataset.id, el, level);
        else closeMenusFrom(level);
      }, SUBMENU_DELAY);
    });

    // Drag and drop
    wrap.addEventListener("dragstart", (e) => {
      const el = itemFrom(e);
      const node = el && nodes.get(el.dataset.id);
      if (!node || isRoot(node.id)) return e.preventDefault();
      draggingId = node.id;
      e.dataTransfer.effectAllowed = "copyMove";
      e.dataTransfer.setData("application/x-hover-bookmark", node.id);
      if (node.url) {
        e.dataTransfer.setData("text/uri-list", node.url);
        e.dataTransfer.setData("text/plain", node.url);
      }
      closeCtx();
    });

    wrap.addEventListener("dragover", (e) => {
      const fromUs = !!draggingId;
      if (!fromUs && !hasDroppableLink(e.dataTransfer)) return;
      const target = getDropTarget(e);
      scheduleDragOpen(target);
      if (!validDrop(target)) {
        clearDropIndicator();
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = fromUs ? "move" : "copy";
      showDropIndicator(target);
    });

    wrap.addEventListener("dragleave", (e) => {
      if (!e.relatedTarget || !root.contains(e.relatedTarget)) clearDropIndicator();
    });

    wrap.addEventListener("drop", (e) => {
      const target = getDropTarget(e);
      clearDropIndicator();
      clearTimeout(dragOpenTimer);
      dragOpenEl = null;
      if (!validDrop(target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (draggingId) {
        const id = draggingId;
        draggingId = null; // the source element may be re-rendered before dragend
        send("move", { id, parentId: target.parentId, index: target.index }).catch(() => {});
      } else {
        const link = linkFromDrop(e.dataTransfer);
        if (link) send("create", { parentId: target.parentId, index: target.index, ...link }).catch(() => {});
      }
    });

    wrap.addEventListener("dragend", (e) => {
      draggingId = null;
      clearDropIndicator();
      clearTimeout(dragOpenTimer);
      dragOpenEl = null;
      lastInside = pointInsideUI(e.clientX, e.clientY);
      if (!lastInside) {
        closeAllMenus(true);
        scheduleHide();
      }
    });

    bar.addEventListener("dblclick", (e) => e.preventDefault());
  }

  // ---- Styles -------------------------------------------------------------

  const LIGHT = `--fg: #1f1f23; --muted: #6b6b73; --hover: rgba(0,0,0,.07); --active: rgba(0,0,0,.12);
    --border: rgba(0,0,0,.12); --accent: #2f6fdf; --on-accent: #fff; --danger: #c62828;
    --shadow: 0 6px 24px rgba(0,0,0,.18), 0 1px 3px rgba(0,0,0,.12); color-scheme: light;`;
  const DARK = `--fg: #ececf0; --muted: #a0a0aa; --hover: rgba(255,255,255,.08); --active: rgba(255,255,255,.14);
    --border: rgba(255,255,255,.12); --accent: #7ea8ff; --on-accent: #111; --danger: #ff7a7a;
    --shadow: 0 6px 24px rgba(0,0,0,.5), 0 1px 3px rgba(0,0,0,.4); color-scheme: dark;`;

  const CSS_TEXT = `
    .wrap {
      position: fixed; inset: 0 0 auto 0; pointer-events: none;
      font: 12px/1.25 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: var(--fg); -webkit-font-smoothing: antialiased;
      text-align: left; letter-spacing: normal; text-transform: none;
    }
    /* Palettes. tone-* (picked from the page's own color) beats the system theme. */
    .wrap { --bg: #ffffff; --menu-bg: #ffffff; ${LIGHT} }
    @media (prefers-color-scheme: dark) { .wrap { --bg: #3c3c3c; --menu-bg: #333336; ${DARK} } }
    /* Default dark toolbar colors measured in each browser (light is white in all of them). */
    @media (prefers-color-scheme: dark) {
      .wrap[data-toolbar="edge"] { --bg: #333333; --menu-bg: #2b2b2b; }
      .wrap[data-toolbar="brave"] { --bg: #39393b; --menu-bg: #313133; }
    }
    .wrap.tone-light { ${LIGHT} }
    .wrap.tone-dark { ${DARK} }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }

    .bar {
      position: fixed; top: 0; left: 0; right: 0; height: 34px;
      display: flex; align-items: center; gap: 2px; padding: 0 6px;
      background: var(--bg); border-bottom: 1px solid var(--border);
      box-shadow: 0 2px 10px rgba(0,0,0,.12);
      transform: translateY(-100%); visibility: hidden; pointer-events: auto;
      transition: transform 120ms ease-out, visibility 0s linear 120ms;
      user-select: none;
    }
    .bar.shown { transform: none; visibility: visible; transition: transform 120ms ease-out; }
    @media (prefers-reduced-motion: reduce) { .bar, .bar.shown { transition: none; } }

    .items { position: relative; flex: 0 1 auto; min-width: 0; display: flex; align-items: center; gap: 2px; overflow: hidden; height: 100%; }
    .spacer { flex: 1 1 0; min-width: 8px; }
    .other-slot { display: flex; flex: 0 0 auto; }
    .hint { color: var(--muted); padding: 0 8px; white-space: nowrap; }

    .item {
      display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 8px;
      border-radius: 6px; max-width: 200px; flex: 0 0 auto; cursor: default; white-space: nowrap;
    }
    .item.icon-only { padding: 0 6px; }
    .item:hover, .item.open { background: var(--hover); }
    .item:active { background: var(--active); }
    .chevron { font-size: 15px; padding: 0 7px; color: var(--muted); }
    .add { padding: 0 6px; color: var(--muted); }
    .add.starred { color: var(--accent); }
    .label { overflow: hidden; text-overflow: ellipsis; }
    .icon { width: 16px; height: 16px; flex: 0 0 16px; display: block; }
    svg.icon { color: var(--muted); }
    .folder > svg.icon { color: var(--fg); opacity: .75; }

    .layer { position: fixed; inset: 0; pointer-events: none; }
    .menu {
      position: fixed; pointer-events: auto; min-width: 180px; max-width: 360px; overflow-y: auto;
      padding: 4px; background: var(--menu-bg); border: 1px solid var(--border); border-radius: 8px;
      box-shadow: var(--shadow); user-select: none; overscroll-behavior: contain;
    }
    .row {
      display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 10px;
      border-radius: 5px; white-space: nowrap; cursor: default;
    }
    .row:hover, .row.open { background: var(--hover); }
    .row:active { background: var(--active); }
    .row .label { flex: 1 1 auto; min-width: 0; }
    .row .sub { margin-left: auto; padding-left: 10px; color: var(--muted); font-size: 14px; }
    .row.action { padding: 0 12px; }
    .row.disabled { opacity: .45; pointer-events: none; }
    .sep { height: 1px; margin: 4px 6px; background: var(--border); }
    .empty { padding: 6px 12px; color: var(--muted); font-style: italic; }
    .drop-into { background: var(--active) !important; outline: 2px solid var(--accent); outline-offset: -2px; }
    .indicator { position: fixed; background: var(--accent); border-radius: 1px; pointer-events: none; }

    .dialog {
      position: fixed; top: 46px; left: 50%; transform: translateX(-50%); width: min(340px, calc(100vw - 32px));
      pointer-events: auto; background: var(--menu-bg); border: 1px solid var(--border); border-radius: 10px;
      box-shadow: var(--shadow); padding: 14px; display: flex; flex-direction: column; gap: 10px; margin: 0;
    }
    .dialog-title { font-weight: 600; font-size: 13px; }
    .field { display: flex; flex-direction: column; gap: 4px; color: var(--muted); }
    .field input {
      font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--border);
      border-radius: 6px; padding: 6px 8px; outline: none; width: 100%; margin: 0;
    }
    .field input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent); }
    .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
    .btn {
      font: inherit; color: var(--fg); background: var(--hover); border: 1px solid var(--border);
      border-radius: 6px; padding: 5px 12px; cursor: pointer; margin: 0;
    }
    .btn:hover { background: var(--active); }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
    .btn.danger:not(.primary) { color: var(--danger); }
    .btn.primary.danger { background: var(--danger); border-color: var(--danger); }
  `;
})();
