const status = document.getElementById("status");
const peers = document.getElementById("peers");
const overflow = document.getElementById("overflow");
const microphone = document.getElementById("microphone");
window.overlayDisplay.onState((state) => {
  status.textContent = state.status;
  const rows = state.peers.slice(0, state.maxPeers).map((p) => {
    const row = document.createElement("div");
    row.className = "peer" + (p.speaking ? " speaking" : "");
    row.dataset.peer = p.id;
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = p.name.slice(0, 1).toUpperCase();
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = p.name;
    row.append(avatar, name);
    if (p.self) {
      const self = document.createElement("span");
      self.className = "self";
      self.textContent = "Вы";
      row.append(self);
    }
    if (p.speaking) {
      const indicator = document.createElement("span");
      indicator.className = "activity";
      indicator.textContent = "Говорит";
      row.append(indicator);
    }
    return row;
  });
  peers.replaceChildren(...rows);
  overflow.textContent =
    state.peers.length > rows.length
      ? "Ещё участников: " + (state.peers.length - rows.length)
      : "";
  microphone.textContent = state.deaf
    ? "Не слышу и не говорю"
    : state.mic
      ? "Микрофон включён"
      : "Микрофон выключен";
  microphone.className = state.mic && !state.deaf ? "live" : "";
});
