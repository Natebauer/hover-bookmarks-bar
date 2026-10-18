# Chrome Web Store submission notes

## Listing

**Name:** Hover Bookmarks Bar

**Short description (≤132 chars):**
Your bookmarks bar, hidden until you hover at the top of the page. Uses your existing bookmarks — nothing to sync.

**Category:** Workflow & Planning (or Accessibility → "Tools")

**Detailed description:**

Keep your screen clean without giving up your bookmarks bar.

Hover Bookmarks Bar hides your bookmarks bar until you rest the mouse at the top edge of the page,
then slides it down over the page. Move away and it tucks itself back up.

• Uses your browser's real bookmarks bar — no separate list, changes sync both ways instantly
• Folders, nested folders, and a » menu for bookmarks that don't fit
• Middle-click or Ctrl+click several bookmarks in a folder without it closing
• Bookmark the current page with one click; edit, rename, delete, and create folders by right-clicking
• Drag to reorder, drop into folders, or drag a link from the page to bookmark it
• Takes on the color of the page you're on, so your browser's toolbar tint doesn't change
• Stays out of the way in fullscreen video
• Lightweight: nothing is added to a page until you hover, and it never slows page loading
• No data collection, no network requests

Made for browsers like Dia that don't offer an auto-hiding bookmarks bar.

## Assets needed

- Icon: `icons/icon128.png` (included)
- Screenshots: at least one 1280×800 or 640×400 PNG/JPEG — capture the bar open with a folder dropdown.
- Optional small promo tile: 440×280.

## Privacy practices tab

**Single purpose:**
Shows the browser's bookmarks bar as an overlay that appears when the mouse hovers at the top of the page.

**Permission justifications:**

- `bookmarks` — Required to display the user's bookmarks bar folder and to apply the edits the user
  makes in the bar (add, rename, move, delete).
- `favicon` — Shows each bookmark's site icon from the browser's local favicon cache.
- Host access (`<all_urls>`) — The bar is drawn inside the current web page, so the script must be
  able to run on any site the user visits. It only reads the page's URL and title when the user clicks
  "bookmark this page". Host access is also what allows `tabs.captureVisibleTab`, used to read the
  color of the page's top edge so the bar matches it (browsers such as Dia tint their toolbar from
  those pixels). The snapshot is processed in memory and discarded; nothing is stored or sent.

**Remote code:** No, the extension does not use remote code.

**Data usage:** Check none of the data categories. Certify: not sold to third parties, not used for
purposes unrelated to the single purpose, not used for creditworthiness/lending.

**Privacy policy URL:** https://github.com/Natebauer/hover-bookmarks-bar/blob/main/PRIVACY.md

## Packaging

Zip the folder contents (manifest.json at the zip root), excluding `README.md`, `PRIVACY.md`, and this file.
