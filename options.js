// Options page: the bar's color mode and which bookmark folder it shows.
const list = document.getElementById("list");
const colors = document.getElementById("colors");

const COLOR_CHOICES = [
  ["auto", "Auto (recommended)", "Matches the page in Dia, whose toolbar takes on the page's color. Everywhere else, matches your browser's light or dark theme."],
  ["page", "Match the page you're on", "The bar takes the color at the top of each page."],
  ["theme", "Match my browser", "A plain light or dark bar, like the browser's own toolbar."],
];

async function renderColors() {
  const current = (await HBBSettings.get("barColor").catch(() => null)) || "auto";
  colors.textContent = "";
  for (const [value, title, hint] of COLOR_CHOICES) {
    const label = document.createElement("label");
    label.className = "choice";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "barColor";
    input.value = value;
    input.checked = value === current;
    input.addEventListener("change", async () => {
      await HBBSettings.set("barColor", value === "auto" ? null : value);
      chrome.runtime.sendMessage({ type: "settingsChanged" }).catch(() => {});
      status.textContent = "Saved — open tabs update right away.";
    });
    const text = document.createElement("span");
    text.textContent = title;
    const small = document.createElement("small");
    small.textContent = hint;
    text.appendChild(small);
    label.append(input, text);
    colors.appendChild(label);
  }
}
const status = document.getElementById("status");
const DEFAULT = "";

function option(value, text, depth, count, checked) {
  const label = document.createElement("label");
  label.style.paddingLeft = 8 + depth * 18 + "px";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = "folder";
  input.value = value;
  input.checked = checked;
  input.addEventListener("change", () => save(value));
  const name = document.createElement("span");
  name.textContent = text;
  label.append(input, name);
  if (count !== null) {
    const c = document.createElement("span");
    c.className = "count";
    c.textContent = count;
    label.appendChild(c);
  }
  return label;
}

async function save(value) {
  await HBBSettings.set("barFolderId", value || null);
  chrome.runtime.sendMessage({ type: "settingsChanged" }).catch(() => {});
  status.textContent = "Saved — open tabs update right away.";
}

async function render() {
  const [tree, chosen] = await Promise.all([
    chrome.bookmarks.getTree(),
    HBBSettings.get("barFolderId").catch(() => null),
  ]);
  list.textContent = "";
  const def = option(DEFAULT, "Browser’s bookmarks bar (default)", 0, null, !chosen);
  def.classList.add("default");
  list.appendChild(def);
  list.appendChild(Object.assign(document.createElement("div"), { className: "sep" }));
  const walk = (node, depth) => {
    for (const child of node.children || []) {
      if (child.url !== undefined) continue;
      const n = child.children.filter((c) => c.url !== undefined).length;
      list.appendChild(option(child.id, child.title || "(untitled)", depth, n, child.id === chosen));
      walk(child, depth + 1);
    }
  };
  walk(tree[0], 0);
  // A chosen folder that was since deleted falls back to the default.
  if (!list.querySelector("input:checked")) def.querySelector("input").checked = true;
}

renderColors();
render();
