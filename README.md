# Hover Bookmarks Bar

Your bookmarks bar, hidden until you rest the mouse at the top edge of the page — like Zen's
auto-hiding bookmarks toolbar, for Dia (or any Chromium browser).

It shows the browser's own bookmarks bar folder. There is no second list to maintain: anything you
change here shows up in the bookmark manager, and vice versa, in every open tab.

## Install (Dia)

1. Open Dia's extensions page (`dia://extensions` or `chrome://extensions`, or via Settings → Extensions).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this `hover-bookmarks-bar` folder.
4. Turn off Dia's own bookmarks bar if it's showing (Ctrl+Shift+B in most Chromium browsers).
5. Reload tabs that were already open — the extension only runs in pages loaded after install.

After editing any file here, click the reload icon on the extension's card, then reload your tabs.

## How it works

| Action | Result |
| --- | --- |
| Rest the mouse at the very top of a page (~150 ms) | Bar slides down over the page |
| Move the mouse away | Bar hides ~300 ms later (not while a menu, dialog or drag is open) |
| Click / Esc / click the page | Closes menus / hides the bar |
| Click a bookmark | Opens in this tab |
| Middle-click or Ctrl+click | Opens in a background tab — **folders stay open**, so you can open several in a row |
| Ctrl+Shift+click | Opens in a new foreground tab |
| Shift+click | Opens in a new window |
| Click a folder | Opens its dropdown; hover other folders to switch; nested folders open on hover |
| `»` | Bookmarks that don't fit across the width |
| `+` / `★` | Bookmark this page / edit its existing bookmark |
| Right-click | Open in new tab/window, Edit, Rename, Delete, Open all, New folder |
| Drag | Reorder, drop into folders (hover a folder to open it), or drag a link from the page up to the top edge to bookmark it |

The bar never appears in fullscreen (videos, presentations).

The bar takes on the color of the top edge of the page (read from a snapshot of the visible tab just
before it appears). Dia tints its address bar from those same pixels, so the toolbar keeps its color
while the bar is showing.

Page zoom doesn't affect the bar: it's counter-scaled to the tab's zoom level (and rescales live if you
zoom while it's open), so it stays the same size as the rest of the browser's UI.

## Where it can't appear

Browsers don't let extensions run on their own pages: Dia's new-tab page, `dia://` / `chrome://`
pages, the Chrome Web Store, and some built-in PDF views. On those pages the bar won't show.

## Performance

Nothing is added to a page until you first hover at the top. Until then the extension is a
mouse-position check. The script starts after the page has finished loading, so it never delays
page load, and bookmarks are only fetched when the bar first opens.

## Files

- `manifest.json` — permissions: `bookmarks` (read/edit your bookmarks), `favicon` (site icons from the
  browser's local cache), and access to all sites so the bar can appear on any page and match its color.
- `background.js` — talks to the bookmarks and tabs APIs, keeps every tab's bar in sync.
- `content.js` — the bar itself, inside a closed shadow root so sites can't restyle it.
- `PRIVACY.md`, `STORE_LISTING.md` — ready for a Chrome Web Store submission.

## License

MIT — see [LICENSE](LICENSE).
