// Toolbar button menu.
const go = (fn) => () => {
  fn();
  window.close();
};
document.getElementById("welcome").addEventListener("click", go(() => chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") })));
document.getElementById("options").addEventListener("click", go(() => chrome.runtime.openOptionsPage()));
document.getElementById("help").addEventListener("click", go(() => chrome.tabs.create({ url: "https://hoverbookmarksbar.com" })));
