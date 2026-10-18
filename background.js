// Hover Bookmarks Bar - service worker.
// Owns all chrome.bookmarks / chrome.tabs calls so the content script stays tiny,
// and tells open tabs when bookmarks change so every bar stays in sync.

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

async function getBarTree() {
  const tree = await chrome.bookmarks.getTree();
  const { bar, other } = findRoots(tree);
  return {
    bar: bar ? slim(bar) : null,
    other: other && other.children && other.children.length ? slim(other) : null,
  };
}

// ---- Opening bookmarks ----------------------------------------------------

// Open a background tab next to the sender, after any tabs it already opened,
// so several middle-clicks in a row keep their order (like Chrome does).
async function openBackgroundTab(url, senderTab, active) {
  if (!senderTab) return chrome.tabs.create({ url, active });
  const tabs = await chrome.tabs.query({ windowId: senderTab.windowId });
  tabs.sort((a, b) => a.index - b.index);
  let index = senderTab.index + 1;
  while (index < tabs.length && tabs[index].openerTabId === senderTab.id) index++;
  return chrome.tabs.create({
    url,
    active,
    index,
    windowId: senderTab.windowId,
    openerTabId: senderTab.id,
  });
}

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
