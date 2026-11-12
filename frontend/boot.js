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

  let kakaoKey = null;
  if (new URLSearchParams(location.search).get("map") !== "leaflet") {
    try {
      const res = await fetch("/api/config", { cache: "no-store" });
      if (res.ok) kakaoKey = (await res.json()).kakaoJsKey || null;
    } catch { /* /api 가 없는 환경(정적 서버)이면 Leaflet */ }
  }

  let provider = "leaflet";
  if (kakaoKey) {
    try {
      await loadScript(`https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(kakaoKey)}&autoload=false`);
      await new Promise((ok) => kakao.maps.load(ok));
      provider = "kakao";
    } catch (e) {
      console.warn("카카오맵 SDK 로드 실패, Leaflet 로 대체합니다.", e);
    }
  }

  if (provider === "leaflet") {
    loadCss("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css");
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js");
  }

  await loadScript("mapkit.js");
  window.mapx = createMapAdapter(provider);
  document.body.dataset.map = provider;

  for (const src of ["cities.js", "app.js", "chat.js"]) await loadScript(src);
})().catch((err) => {
  console.error(err);
  document.getElementById("status").textContent = `초기화 오류: ${err.message}`;
});
