// 부팅: 지도 제공자를 정하고(카카오맵 / Leaflet) 필요한 스크립트를 순서대로 로드합니다.
//  - /api/config 가 카카오 JavaScript 키를 주면 카카오맵, 아니면(또는 SDK 로드 실패 시) Leaflet(OpenStreetMap)
//  - 주소에 ?map=leaflet 을 붙이면 강제로 Leaflet 사용
(async () => {
  const loadScript = (src) => new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = ok;
    s.onerror = () => fail(new Error(`로드 실패: ${src}`));
    document.head.append(s);
  });
  const loadCss = (href) => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = href;
    document.head.append(l);
  };

  // 카카오맵을 우선 사용하고, 쓸 수 없을 때만 Leaflet(OpenStreetMap)으로 대체. 대체된 이유는 화면에 표시
  let kakaoKey = null;
  let fallbackReason = null;
  if (new URLSearchParams(location.search).get("map") === "leaflet") {
    fallbackReason = "주소에 ?map=leaflet 이 있어 OpenStreetMap 지도를 사용 중";
  } else {
    try {
      const res = await fetch("/api/config", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      kakaoKey = (await res.json()).kakaoJsKey || null;
      if (!kakaoKey) fallbackReason = "서버에 KAKAO_JS_KEY 가 없어 OpenStreetMap 지도를 사용 중 (Vercel 환경 변수 등록 후 Redeploy)";
    } catch (e) {
      fallbackReason = `/api/config 를 불러오지 못해 OpenStreetMap 지도를 사용 중 (${e.message})`;
    }
  }

  let provider = "leaflet";
  if (kakaoKey) {
    try {
      await loadScript(`https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(kakaoKey)}&autoload=false`);
      await new Promise((ok) => kakao.maps.load(ok));
      provider = "kakao";
    } catch (e) {
      console.warn("카카오맵 SDK 로드 실패, Leaflet 로 대체합니다.", e);
      fallbackReason = "카카오맵 SDK 로드 실패로 OpenStreetMap 지도를 사용 중 (JavaScript 키와 'JavaScript SDK 도메인' 등록, 카카오맵 사용 설정을 확인하세요)";
    }
  }

  if (provider === "leaflet") {
    loadCss("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css");
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js");
  }

  await loadScript("mapkit.js");
  window.mapx = createMapAdapter(provider);
  document.body.dataset.map = provider;
  if (provider !== "kakao" && fallbackReason) {
    const note = document.createElement("div");
    note.id = "map-note";
    note.textContent = fallbackReason;
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    x.setAttribute("aria-label", "닫기");
    x.addEventListener("click", () => note.remove());
    note.append(x);
    document.getElementById("map").append(note);
  }

  for (const src of ["cities.js", "app.js", "chat.js"]) await loadScript(src);
})().catch((err) => {
  console.error(err);
  document.getElementById("status").textContent = `초기화 오류: ${err.message}`;
});
