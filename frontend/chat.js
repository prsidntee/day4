// 장소 추천 에이전트 채팅 UI (/api/chat 호출) + 추천 장소를 지도에 마커로 표시
// app.js 의 전역(map, choose)과 Leaflet(L)을 사용합니다.
(() => {
  const logEl = document.getElementById("chat-log");
  const formEl = document.getElementById("chat-form");
  const inputEl = document.getElementById("chat-input");
  const sendEl = document.getElementById("chat-send");
  const clearEl = document.getElementById("chat-clear");

  const history = []; // { role: 'user' | 'assistant', content }
  const MAX_SEND = 12; // 서버로 보내는 최근 메시지 수
  const spotLayer = L.layerGroup().addTo(map);
  let busy = false;

  // 모델 답변(마크다운 일부)을 안전하게 HTML 로: 먼저 이스케이프한 뒤 **굵게**, 목록, 줄바꿈만 허용
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function renderMarkdown(text) {
    const lines = esc(text).split(/\r?\n/);
    let html = "", inList = false;
    for (const raw of lines) {
      const m = raw.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
      const line = (m ? m[1] : raw).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      if (m) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${line}</li>`; continue; }
      if (inList) { html += "</ul>"; inList = false; }
      html += line.trim() ? `<div>${line}</div>` : "";
    }
    return html + (inList ? "</ul>" : "");
  }

  function addMsg(kind, content, asHtml = false) {
    const el = document.createElement("div");
    el.className = `msg ${kind}`;
    if (asHtml) el.innerHTML = content; else el.textContent = content;
    logEl.append(el);
    logEl.scrollTop = logEl.scrollHeight;
    return el;
  }

  function addToolChips(toolCalls) {
    if (!toolCalls?.length) return;
    const wrap = document.createElement("div");
    wrap.className = "tools";
    toolCalls.forEach((t) => {
      const chip = document.createElement("span");
      chip.className = `tool-chip${t.ok ? "" : " fail"}`;
      const a = t.args || {};
      const label = [a.location, a.category || a.keyword].filter(Boolean).join(" · ");
      chip.textContent = `${t.ok ? "🔧" : "⚠️"} ${t.name}${label ? `(${label})` : ""}`;
      if (!t.ok && t.error) chip.title = t.error;
      wrap.append(chip);
    });
    logEl.append(wrap);
  }

  // 추천 장소를 지도에 번호 마커로 표시
  function showSpots(spots) {
    spotLayer.clearLayers();
    if (!spots?.length) return;
    const pts = [];
    spots.forEach((s, i) => {
      if (!Number.isFinite(s.latitude) || !Number.isFinite(s.longitude)) return;
      const icon = L.divIcon({ className: "", html: `<div class="spot-pin">${i + 1}</div>`, iconSize: [24, 24] });
      const marker = L.marker([s.latitude, s.longitude], { icon });
      const box = document.createElement("div");
      box.className = "spot-popup";
      const title = document.createElement("strong");
      title.textContent = s.name;
      const addr = document.createElement("div");
      addr.textContent = s.address || "";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "이곳 날씨 보기";
      btn.addEventListener("click", () => {
        marker.closePopup();
        choose({ name: s.name, region: s.area || "", lat: s.latitude, lon: s.longitude, level: "point" });
      });
      box.append(title, addr, btn);
      marker.bindPopup(box);
      spotLayer.addLayer(marker);
      pts.push([s.latitude, s.longitude]);
    });
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 14 });
  }

  async function send(text) {
    if (busy || !text.trim()) return;
    busy = true;
    sendEl.disabled = true;
    logEl.querySelector(".chat-suggest")?.remove();
    logEl.querySelector(".chat-hint")?.remove();
    clearEl.hidden = false;

    history.push({ role: "user", content: text.trim() });
    addMsg("user", text.trim());
    const pending = addMsg("bot pending", "날씨와 장소를 확인하는 중...");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.slice(-MAX_SEND) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        throw new Error(data?.error || (res.status === 404 ? "/api/chat 을 찾을 수 없습니다. start.bat(로컬) 또는 Vercel 배포 주소에서 열어 주세요." : `서버 오류 (HTTP ${res.status})`));
      }
      pending.remove();
      addToolChips(data.toolCalls);
      addMsg("bot", renderMarkdown(data.reply), true);
      history.push({ role: "assistant", content: data.reply });
      showSpots(data.spots);
    } catch (err) {
      pending.remove();
      history.pop(); // 실패한 질문은 이력에서 제거 (마지막 메시지가 user 여야 하므로)
      addMsg("err", err.message);
    } finally {
      busy = false;
      sendEl.disabled = false;
      inputEl.focus();
    }
  }

  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = inputEl.value;
    inputEl.value = "";
    send(text);
  });
  logEl.addEventListener("click", (e) => {
    const b = e.target.closest(".chat-suggest button");
    if (b) send(b.textContent);
  });
  clearEl.addEventListener("click", () => {
    history.length = 0;
    spotLayer.clearLayers();
    logEl.replaceChildren();
    clearEl.hidden = true;
  });
})();
