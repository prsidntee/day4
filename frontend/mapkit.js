// 지도 어댑터: Leaflet(OpenStreetMap) 또는 카카오맵 JS SDK 를 같은 인터페이스로 사용
//
//   adapter.onClick((lat, lon) => ...)           지도 빈 곳 클릭 (한국 범위 안만)
//   adapter.focus(lat, lon, "city"|"dong"|"point") 해당 위치로 이동/확대
//   adapter.setSelected(lat, lon)                선택 표시(원)
//   adapter.createBadge({ lat, lon, onClick })   미세먼지 배지 -> { update({ html, tip }), show(), hide() }
//   adapter.spots.clear() / add({ lat, lon, label, popup }) / fit()   추천 장소 핀
//
// boot.js 가 SDK 를 로드한 뒤 createMapAdapter("leaflet" | "kakao") 를 호출합니다.
function createMapAdapter(provider, containerId = "map") {
  const KOREA = { s: 32.8, w: 124.4, n: 38.9, e: 132.0 };
  const inKorea = (lat, lon) => lat >= KOREA.s && lat <= KOREA.n && lon >= KOREA.w && lon <= KOREA.e;
  return provider === "kakao" ? kakaoAdapter() : leafletAdapter();

  // ---------------- Leaflet ----------------
  function leafletAdapter() {
    const bounds = L.latLngBounds([KOREA.s, KOREA.w], [KOREA.n, KOREA.e]);
    const map = L.map(containerId, { zoomControl: true, maxBounds: bounds, maxBoundsViscosity: 1.0, minZoom: 6 }).fitBounds(bounds);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    let sel = null;
    const badgeLayer = L.layerGroup().addTo(map);
    const spotLayer = L.layerGroup().addTo(map);
    const spotPts = [];

    return {
      provider: "leaflet",
      onClick(fn) {
        map.on("click", (e) => { if (bounds.contains(e.latlng)) fn(e.latlng.lat, e.latlng.lng); });
      },
      focus(lat, lon, level) {
        const z = level === "dong" ? 11 : level === "point" ? 10 : 9;
        map.flyTo([lat, lon], Math.max(map.getZoom(), z), { duration: 0.6 });
      },
      setSelected(lat, lon) {
        sel?.remove();
        sel = L.circleMarker([lat, lon], { radius: 20, color: "#1d4ed8", weight: 3, fill: false, interactive: false }).addTo(map);
      },
      createBadge({ lat, lon, onClick }) {
        const m = L.marker([lat, lon], { icon: L.divIcon({ className: "", html: "", iconSize: [30, 30] }) });
        m.bindTooltip("", { direction: "top", offset: [0, -14] });
        if (onClick) m.on("click", onClick);
        return {
          update({ html, tip }) {
            m.setIcon(L.divIcon({ className: "", html, iconSize: [30, 30] }));
            m.setTooltipContent(tip);
          },
          show() { if (!badgeLayer.hasLayer(m)) badgeLayer.addLayer(m); },
          hide() { badgeLayer.removeLayer(m); },
        };
      },
      spots: {
        clear() { spotLayer.clearLayers(); spotPts.length = 0; },
        add({ lat, lon, label, popup }) {
          const icon = L.divIcon({ className: "", html: `<div class="spot-pin">${label}</div>`, iconSize: [24, 24] });
          const m = L.marker([lat, lon], { icon }).bindPopup(popup);
          spotLayer.addLayer(m);
          spotPts.push([lat, lon]);
          return { closePopup: () => m.closePopup() };
        },
        fit() { if (spotPts.length) map.fitBounds(L.latLngBounds(spotPts).pad(0.3), { maxZoom: 14 }); },
      },
    };
  }

  // ---------------- 카카오맵 ----------------
  function kakaoAdapter() {
    const km = kakao.maps;
    const el = document.getElementById(containerId);
    const map = new km.Map(el, { center: new km.LatLng(36.3, 127.9), level: 13 });
    map.setMaxLevel(14);
    map.addControl(new km.ZoomControl(), km.ControlPosition.RIGHT);

    const ll = (lat, lon) => new km.LatLng(lat, lon);
    const overlay = (lat, lon, content, z = 1) =>
      new km.CustomOverlay({ position: ll(lat, lon), content, xAnchor: 0.5, yAnchor: 0.5, zIndex: z });

    let selOverlay = null;
    let spotOverlays = [];
    let infoWin = null;
    const spotPts = [];

    return {
      provider: "kakao",
      onClick(fn) {
        km.event.addListener(map, "click", (e) => {
          const lat = e.latLng.getLat(), lon = e.latLng.getLng();
          if (inKorea(lat, lon)) fn(lat, lon);
        });
      },
      focus(lat, lon, level) {
        const target = level === "dong" ? 5 : level === "point" ? 6 : 8; // 카카오 레벨은 작을수록 확대
        if (map.getLevel() > target) map.setLevel(target);
        map.panTo(ll(lat, lon));
      },
      setSelected(lat, lon) {
        selOverlay?.setMap(null);
        const ring = document.createElement("div");
        ring.className = "sel-ring";
        selOverlay = overlay(lat, lon, ring, 2);
        selOverlay.setMap(map);
      },
      createBadge({ lat, lon, onClick }) {
        const box = document.createElement("div");
        box.className = "kk-badge";
        if (onClick) box.addEventListener("click", onClick);
        const ov = overlay(lat, lon, box, 3);
        return {
          update({ html, tip }) { box.innerHTML = html; box.title = tip; },
          show() { if (!ov.getMap()) ov.setMap(map); },
          hide() { ov.setMap(null); },
        };
      },
      spots: {
        clear() {
          spotOverlays.forEach((o) => o.setMap(null));
          spotOverlays = [];
          spotPts.length = 0;
          infoWin?.close();
        },
        add({ lat, lon, label, popup }) {
          const pin = document.createElement("div");
          pin.className = "spot-pin kk-pin";
          pin.textContent = label;
          const close = () => infoWin?.close();
          pin.addEventListener("click", () => {
            infoWin?.close();
            infoWin = new km.InfoWindow({ position: ll(lat, lon), content: popup, removable: true, zIndex: 10 });
            infoWin.open(map);
          });
          const o = overlay(lat, lon, pin, 4);
          o.setMap(map);
          spotOverlays.push(o);
          spotPts.push([lat, lon]);
          return { closePopup: close };
        },
        fit() {
          if (!spotPts.length) return;
          const b = new km.LatLngBounds();
          spotPts.forEach(([la, lo]) => b.extend(ll(la, lo)));
          map.setBounds(b, 60, 60, 60, 60);
        },
      },
    };
  }
}
