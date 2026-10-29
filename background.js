// Hover Bookmarks Bar - service worker.
// Owns all chrome.bookmarks / chrome.tabs calls so the content script stays tiny,
// and tells open tabs when bookmarks change so every bar stays in sync.

importScripts("settings.js");

// ---- Locating the bookmarks bar and "Other bookmarks" folders -------------

function findRoots(tree) {
  const top = (tree[0] && tree[0].children) || [];
  // Chrome 134+ exposes folderType; older builds use well-known ids "1" / "2".
  const bar =
    top.find((n) => n.folderType === "bookmarks-bar") ||
    top.find((n) => n.id === "1") ||
    top[0];
  const other =
    top.find((n) => n.folderType === "other") ||
    top.find((n) => n.id === "2" && n !== bar) ||
    null;
  return { bar, other };
}

function slim(node) {
  const out = { id: node.id, parentId: node.parentId, title: node.title || "" };
  if (node.url !== undefined) out.url = node.url;
  else out.children = (node.children || []).map(slim);
  return out;
}

function findNode(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const hit = findNode(n.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

// The bar shows the browser's bookmarks bar unless the user picked another
// folder on the options page (needed for Vivaldi, whose bar folder isn't the
// one Chromium labels "bookmarks bar").
// ---- Bar color ------------------------------------------------------------
// Dia tints its toolbar from the top of the page, so there the bar copies the
// page's color to keep that tint steady. Other browsers have a fixed toolbar,
// so there the bar matches the browser's light/dark theme instead.
// Setting "barColor": "auto" (default) | "page" | "theme".

// Dia reports only the generic "Chromium" brand; Chrome, Edge, Brave, Opera
// and Vivaldi (which poses as Chrome) all report a brand of their own.
function looksLikeDia() {
  const brands = ((navigator.userAgentData && navigator.userAgentData.brands) || []).map((b) => b.brand);
  const vendor = /Google Chrome|Microsoft Edge|Brave|Opera|Vivaldi|Yandex|Samsung|Whale|Arc/i;
  return brands.includes("Chromium") && !brands.some((b) => vendor.test(b));
}

// Which browser's toolbar colors to copy in "theme" mode (measured defaults).
function toolbarFamily() {
  const brands = ((navigator.userAgentData && navigator.userAgentData.brands) || []).map((b) => b.brand).join(" ");
  if (/Microsoft Edge/i.test(brands)) return "edge";
  if (/Brave/i.test(brands)) return "brave";
  return "chrome";
}

async function resolveColorMode() {
  const setting = await HBBSettings.get("barColor").catch(() => null);
  if (setting === "page" || setting === "theme") return setting;
  return looksLikeDia() ? "page" : "theme";
}

async function getBarTree() {
  const tree = await chrome.bookmarks.getTree();
  let { bar, other } = findRoots(tree);
  const chosenId = await HBBSettings.get("barFolderId").catch(() => null);
  const chosen = chosenId ? findNode(tree, chosenId) : null;
  if (chosen && chosen.children) {
    // Hide "Other bookmarks" if the chosen folder is it or lives inside it.
    if (other && (chosen === other || findNode(other.children, chosen.id))) other = null;
    bar = chosen;
  }
  return {
    bar: bar ? slim(bar) : null,
    other: other && other.children && other.children.length ? slim(other) : null,
    colorMode: await resolveColorMode(),
    toolbar: toolbarFamily(),
  };
}

// ---- Opening bookmarks ----------------------------------------------------

// Open a background tab next to the sender, after any tabs it already opened,
// so several middle-clicks in a row keep their order (like Chrome does).
// Some browsers (Vivaldi) don't record openerTabId, so also remember which
// tabs we opened from each tab.
const openedFrom = new Map(); // sender tab id -> Set of tab ids opened from it

async function openBackgroundTab(url, senderTab, active) {
  if (!senderTab) return chrome.tabs.create({ url, active });
  const ours = openedFrom.get(senderTab.id) || new Set();
  const tabs = await chrome.tabs.query({ windowId: senderTab.windowId });
  tabs.sort((a, b) => a.index - b.index);
  let index = senderTab.index + 1;
  while (index < tabs.length && (tabs[index].openerTabId === senderTab.id || ours.has(tabs[index].id))) index++;
  const tab = await chrome.tabs.create({
    url,
    active,
    index,
    windowId: senderTab.windowId,
    openerTabId: senderTab.id,
  });
  ours.add(tab.id);
  openedFrom.set(senderTab.id, ours);
  // Vivaldi applies its own new-tab placement and ignores `index`; put it back.
  if (tab.index !== index) await chrome.tabs.move(tab.id, { index }).catch(() => {});
  return tab;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  openedFrom.delete(tabId);
  for (const set of openedFrom.values()) set.delete(tabId);
});

async function openUrl(url, disposition, senderTab) {
  switch (disposition) {
    case "current":
      if (senderTab) return chrome.tabs.update(senderTab.id, { url });
      return chrome.tabs.create({ url });
    case "background":
      return openBackgroundTab(url, senderTab, false);
    case "foreground":
      return openBackgroundTab(url, senderTab, true);
    case "window":
      return chrome.windows.create({ url });
  }
}

// ---- Message handling -----------------------------------------------------

const handlers = {
  async getTree() {
    return getBarTree();
  },
  async open({ url, disposition }, sender) {
    await openUrl(url, disposition, sender.tab);
    return true;
  },
  async openAll({ urls, disposition }, sender) {
    if (disposition === "window") {
      await chrome.windows.create({ url: urls });
      return true;
    }
    for (const url of urls) await openBackgroundTab(url, sender.tab, false);
    return true;
  },
  async create({ parentId, index, title, url }) {
    const details = { parentId, title };
    if (index !== undefined) details.index = index;
    if (url !== undefined) details.url = url;
    const node = await chrome.bookmarks.create(details);
    return slim(node);
  },
  async update({ id, title, url }) {
    const changes = { title };
    if (url !== undefined) changes.url = url;
    await chrome.bookmarks.update(id, changes);
    return true;
  },
  async remove({ id, isFolder }) {
    if (isFolder) await chrome.bookmarks.removeTree(id);
    else await chrome.bookmarks.remove(id);
    return true;
  },
  // The most common color along the top edge of what the tab is showing -
  // the same pixels Dia samples to tint its toolbar.
  async sampleTopColor(_msg, sender) {
    const tab = sender.tab;
    if (!tab || !tab.active) throw new Error("tab not visible");
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const width = bmp.width;
    const rows = Math.min(2, bmp.height);
    const canvas = new OffscreenCanvas(width, rows);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const d = ctx.getImageData(0, 0, width, rows).data;
    const counts = new Map();
    let best = null;
    let bestCount = 0;
    for (let i = 0; i < d.length; i += 4) {
      const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      const c = (counts.get(key) || 0) + 1;
      counts.set(key, c);
      if (c > bestCount) {
        bestCount = c;
        best = key;
      }
    }
    return best === null ? null : [(best >> 16) & 255, (best >> 8) & 255, best & 255, 1];
  },
  async settingsChanged() {
    notifyTabs();
    return true;
  },
  async getZoom(_msg, sender) {
    return sender.tab ? chrome.tabs.getZoom(sender.tab.id) : 1;
  },
  async move({ id, parentId, index }) {
    await chrome.bookmarks.move(id, { parentId, index });
    return true;
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg && msg.type];
  if (!handler) return false;
  handler(msg, sender).then(
    (result) => sendResponse({ ok: true, result }),
    (err) => sendResponse({ ok: false, error: String((err && err.message) || err) })
  );
  return true; // async response
});

// ---- Keep every open bar in sync ------------------------------------------

let notifyTimer = null;
function notifyTabs() {
  // Bulk operations (imports, "open all", drag of a folder) fire many events;
  // coalesce them into one message per tab.
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(async () => {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: "bookmarksChanged" }).catch(() => {});
    }
  }, 50);
}

// ---- Install and update ----------------------------------------------------

// Content scripts only load into pages opened after an install or update, so
// add the bar to every tab that's already open; nobody has to reload anything.
// Pages extensions can't touch (chrome://, the Web Store) just fail quietly.
async function addToOpenTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs
      .filter((t) => !t.discarded && /^(https?|file):/.test(t.url || ""))
      .map((t) =>
        chrome.scripting
          .executeScript({ target: { tabId: t.id }, files: ["content.js"] })
          .catch(() => {})
      )
  );
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== "install" && reason !== "update") return;
  addToOpenTabs();
  // First install only: a page where the bar works right away, instead of the
  // store page people install from (where browsers block all extensions).
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
});

// The bar counter-scales against page zoom so it stays browser-sized.
chrome.tabs.onZoomChange.addListener(({ tabId, newZoomFactor }) => {
  chrome.tabs.sendMessage(tabId, { type: "zoomChanged", zoom: newZoomFactor }).catch(() => {});
});

chrome.bookmarks.onCreated.addListener(notifyTabs);
chrome.bookmarks.onRemoved.addListener(notifyTabs);
chrome.bookmarks.onChanged.addListener(notifyTabs);
chrome.bookmarks.onMoved.addListener(notifyTabs);
chrome.bookmarks.onChildrenReordered.addListener(notifyTabs);
if (chrome.bookmarks.onImportEnded) chrome.bookmarks.onImportEnded.addListener(notifyTabs);
