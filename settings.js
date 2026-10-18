// Tiny settings store shared by the service worker and the options page.
// IndexedDB on the extension's own origin, so it needs no "storage" permission.
const HBBSettings = (() => {
  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("hover-bookmarks-bar", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("settings");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function get(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction("settings").objectStore("settings").get(key);
      req.onsuccess = () => {
        db.close();
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function set(key, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("settings", "readwrite");
      if (value === undefined || value === null) tx.objectStore("settings").delete(key);
      else tx.objectStore("settings").put(value, key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  return { get, set };
})();
