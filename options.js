// Options page: choose which bookmark folder the hover bar shows.
const list = document.getElementById("list");
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

render();
