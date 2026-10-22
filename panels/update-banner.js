async function refreshUpdateBanner() {
  const el = document.getElementById("updateBanner");
  const response = await send({ type: "GET_UPDATE_INFO" });
  if (!response.ok || !response.info || !response.info.available || response.dismissed) {
    el.hidden = true;
    return;
  }
  const { version, zipUrl, htmlUrl } = response.info;
  el.innerHTML = "";

  const text = document.createElement("span");
  text.textContent = `NovacuraBuddy v${version} is available.`;

  const howTo = document.createElement("p");
  howTo.className = "update-howto";
  howTo.hidden = true;
  // chrome:// pages can't be opened with a plain <a href>, only via chrome.tabs.create. An extension
  // can't read its own folder path, but its details page shows it under "Source" (unpacked installs),
  // and clicking that opens the folder in the file manager.
  const chromeLink = (label, url) => {
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = label;
    a.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url }); };
    return a;
  };
  howTo.append(
    "Unzip it over your NovacuraBuddy folder (replace the files — same folder keeps your saved instances and settings; find the folder under \"Source\" on ",
    chromeLink("this extension's details page", `chrome://extensions/?id=${chrome.runtime.id}`),
    "), then open ",
    chromeLink("chrome://extensions", "chrome://extensions"),
    " and click Reload on NovacuraBuddy."
  );

  const download = document.createElement("button");
  download.className = "btn-primary";
  download.textContent = "Download";
  download.onclick = () => {
    if (zipUrl) chrome.downloads.download({ url: zipUrl, filename: `NovacuraBuddy-v${version}.zip` });
    else chrome.tabs.create({ url: htmlUrl });
    howTo.hidden = false;
  };

  const howToBtn = document.createElement("button");
  howToBtn.className = "btn-ghost";
  howToBtn.textContent = "How to install";
  howToBtn.onclick = () => { howTo.hidden = !howTo.hidden; };

  const later = document.createElement("button");
  later.className = "btn-ghost";
  later.textContent = "Later";
  later.onclick = async () => { await send({ type: "DISMISS_UPDATE", version }); el.hidden = true; };

  el.append(text, download, howToBtn, later, howTo);
  el.hidden = false;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.updateInfo) refreshUpdateBanner();
});
