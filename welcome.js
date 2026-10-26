// Welcome page: opened once, right after the extension is installed.
document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
