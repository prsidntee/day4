// WMO weather code -> [아이콘, 설명]
const WMO = {
  0: ["☀️", "맑음"], 1: ["🌤️", "대체로 맑음"], 2: ["⛅", "구름 조금"], 3: ["☁️", "흐림"],
  45: ["🌫️", "안개"], 48: ["🌫️", "서리 안개"],
  51: ["🌦️", "약한 이슬비"], 53: ["🌦️", "이슬비"], 55: ["🌦️", "강한 이슬비"],
  56: ["🌧️", "어는 이슬비"], 57: ["🌧️", "강한 어는 이슬비"],
  61: ["🌧️", "약한 비"], 63: ["🌧️", "비"], 65: ["🌧️", "강한 비"],
  66: ["🌧️", "어는 비"], 67: ["🌧️", "강한 어는 비"],
  71: ["🌨️", "약한 눈"], 73: ["🌨️", "눈"], 75: ["❄️", "강한 눈"], 77: ["❄️", "싸락눈"],
  80: ["🌦️", "약한 소나기"], 81: ["🌦️", "소나기"], 82: ["⛈️", "강한 소나기"],
  85: ["🌨️", "약한 눈 소나기"], 86: ["🌨️", "강한 눈 소나기"],
  95: ["⛈️", "뇌우"], 96: ["⛈️", "우박 동반 뇌우"], 99: ["⛈️", "강한 우박 뇌우"],
};

const $ = (id) => document.getElementById(id);
const searchEl = $("search");
const listEl = $("suggestions");
const statusEl = $("status");
const weatherEl = $("weather");

let selected = null;
let matches = [];
let activeIdx = -1;

// ---------- 한글 → 영문 로마자 (국어의 로마자 표기법, 음운변화 미적용) ----------
const JL = ["g","kk","n","d","tt","r","m","b","pp","s","ss","","j","jj","ch","k","t","p","h"];
const JV = ["a","ae","ya","yae","eo","e","yeo","ye","o","wa","wae","oe","yo","u","wo","we","wi","yu","eu","ui","i"];
const JT = ["","k","k","ks","n","nj","nh","t","l","lk","lm","lb","ls","lt","lp","lh","m","p","ps","t","t","ng","t","t","k","t","p","t"];

function romanize(str) {
  let out = "";
  let prevFinal = 0;
  for (const ch of str) {
    const code = ch.charCodeAt(0) - 0xac00;
    if (code >= 0 && code < 11172) {
      const l = Math.floor(code / 588), t = code % 28;
      // 강릉 → gangneung: ㅇ·ㅁ 받침 뒤의 ㄹ은 n
      const init = l === 5 && (prevFinal === 21 || prevFinal === 16) ? "n" : JL[l];
      out += init + JV[Math.floor((code % 588) / 28)] + JT[t];
      prevFinal = t;
    } else {
      out += ch.toLowerCase();
      prevFinal = 0;
    }
  }
  return out;
}

// 로마자 비교용 정규화: 공백/하이픈 제거
const normLatin = (s) => s.toLowerCase().replace(/[\s-]/g, "");

// 도시 목록에 로마자·레벨 정보 추가
CITIES.forEach((c) => {
  c.level = "city";
  c.roman = normLatin(romanize(c.name.replace(/\(.*\)/, "")));
});

// ---------- 검색 ----------
const hasLatin = (s) => /[a-z]/i.test(s);

function localMatches(q) {
  const latin = hasLatin(q);
  // "수원시", "Suwon-si" 처럼 행정 단위를 붙여 검색해도 잡히게
  const base = latin
    ? normLatin(q.replace(/[-\s](si|gun|gu)$/i, ""))
    : q.replace(/^(.{2,})[시군]$/, "$1");

  const hit = (c) => latin ? c.roman.startsWith(base) : c.name.startsWith(base);
  const loose = (c) => latin
    ? c.roman.includes(base)
    : c.name.includes(base) || c.region.startsWith(base);
  const starts = CITIES.filter(hit);
  const contains = CITIES.filter((c) => !hit(c) && loose(c));
  return [...starts, ...contains];
}

const DONG_RE = /(읍|면|동|리|가|-?(eup|myeon|dong|ri|ga))$/i;

// Open-Meteo Geocoding: 한글/영문 모두 검색 가능, 읍면동 포함
async function fetchGeo(name, signal) {
  const params = new URLSearchParams({ name, count: "20", language: "ko", countryCode: "KR" });
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { results = [] } = await res.json();
  return results.map((r) => ({ ...r, _q: name }));
}

async function remoteMatches(q, signal) {
  // 지오코더는 "역삼동"처럼 접미사까지 붙은 이름으로 색인하므로, 한글은 읍·면·동을 붙인 변형도 함께 조회
  const variants = hasLatin(q) || /[읍면동리]$/.test(q) ? [q] : [q, q + "동", q + "읍", q + "면"];
  const settled = await Promise.allSettled(variants.map((v) => fetchGeo(v, signal)));
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  const seen = new Set();
  const results = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []))
    .filter((r) => !seen.has(r.id) && seen.add(r.id));
  if (!results.length && settled.every((s) => s.status === "rejected")) throw settled[0].reason;
  return results
    .filter((r) => r.feature_code?.startsWith("PPL")) // 산·공원 등 제외, 거주지만
    .map((r) => (/[가-힣]/.test(r._q) && !/[가-힣]/.test(r.name) ? { ...r, name: r._q } : r)) // 한글 검색이면 한글 이름으로 표시
    .map((r) => {
      const parts = [r.admin1, r.admin2, r.admin3].filter((p, i, a) => p && p !== a[i - 1]);
      const level = DONG_RE.test(r.name) ? "dong" : "city";
      return {
        name: r.name,
        region: parts.filter((p) => p !== r.name).join(" "),
        lat: r.latitude,
        lon: r.longitude,
        level,
        roman: "",
      };
    })
    // 이미 로컬 목록에 있는 시·군(같은 이름)은 중복 제외 (광역 명칭이 옛/새 이름으로 달라도 이름만 비교)
    .filter((r) => !(r.level === "city" && /[시군]$/.test(r.name)
      && CITIES.some((c) => r.name.slice(0, -1) === c.name.replace(/\(.*\)/, ""))));
}

let debounceTimer = null;
let abortCtl = null;
let searchSeq = 0;
let pending = false;
let remoteCache = [];

function onInput() {
  const q = searchEl.value.trim();
  clearTimeout(debounceTimer);
  abortCtl?.abort();
  remoteCache = [];
  pending = false;

  if (!q) return closeList();
  renderSuggestions(q);

  // 읍면동·영문 검색은 2글자 이상부터 서버 조회
  if (q.length >= 2) {
    pending = true;
    renderSuggestions(q);
    const seq = ++searchSeq;
    debounceTimer = setTimeout(async () => {
      abortCtl = new AbortController();
      try {
        const r = await remoteMatches(q, abortCtl.signal);
        if (seq !== searchSeq) return;
        remoteCache = r;
      } catch (e) {
        if (e.name === "AbortError") return;
        remoteCache = [];
      }
      pending = false;
      renderSuggestions(q);
    }, 250);
  }
}

function renderSuggestions(q) {
  const local = localMatches(q).slice(0, 20);
  const dong = remoteCache.filter((r) => r.level === "dong");
  const city = remoteCache.filter((r) => r.level === "city");
  matches = [...local, ...city, ...dong].slice(0, 40);
  activeIdx = matches.length ? 0 : -1;
  listEl.replaceChildren();

  const latin = hasLatin(q);
  matches.forEach((c, i) => {
    const li = document.createElement("li");
    li.role = "option";
    if (c.level === "dong") li.classList.add("dong");

    const name = document.createElement("span");
    name.className = "name";
    const at = c.name.indexOf(q);
    if (at >= 0) {
      const mark = document.createElement("mark");
      mark.textContent = q;
      name.append(c.name.slice(0, at), mark, c.name.slice(at + q.length));
    } else {
      name.textContent = c.name;
    }

    const region = document.createElement("small");
    region.textContent = latin && c.roman ? `${c.region} · ${c.roman}` : c.region;
    li.append(name, region);
    li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(c); });
    li.classList.toggle("active", i === 0);
    listEl.append(li);
  });

  if (pending || !matches.length) {
    const li = document.createElement("li");
    li.className = "note";
    li.textContent = pending ? "읍·면·동 검색 중..." : "검색 결과가 없습니다";
    listEl.append(li);
  }

  listEl.hidden = false;
  searchEl.setAttribute("aria-expanded", "true");
}

function closeList() {
  listEl.hidden = true;
  searchEl.setAttribute("aria-expanded", "false");
}

function setActive(i) {
  if (!matches.length) return;
  activeIdx = (i + matches.length) % matches.length;
  [...listEl.children].forEach((li, n) => li.classList.toggle("active", n === activeIdx));
  listEl.children[activeIdx].scrollIntoView({ block: "nearest" });
}

function choose(city) {
  selected = city;
  focusMap(city);
  searchEl.value = city.name;
  searchSeq++;
  clearTimeout(debounceTimer);
  abortCtl?.abort();
  closeList();
  loadWeather();
}

searchEl.addEventListener("input", onInput);
searchEl.addEventListener("focus", () => { if (searchEl.value.trim()) onInput(); });
searchEl.addEventListener("blur", closeList);
searchEl.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); setActive(activeIdx + 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); setActive(activeIdx - 1); }
  else if (e.key === "Enter" && matches[activeIdx]) { e.preventDefault(); choose(matches[activeIdx]); }
  else if (e.key === "Escape") closeList();
});

// ---------- 날씨 ----------
async function loadWeather() {
  if (!selected) return;
  const city = selected;
  statusEl.hidden = false;
  statusEl.className = "status";
  statusEl.textContent = "불러오는 중...";
  weatherEl.hidden = true;

  const params = new URLSearchParams({
    latitude: city.lat,
    longitude: city.lon,
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
    timezone: "Asia/Seoul",
  });

  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { current: c, current_units: u } = await res.json();
    if (city !== selected) return; // 그 사이 다른 도시를 선택한 경우

    const [icon, desc] = WMO[c.weather_code] ?? ["❔", "알 수 없음"];
    $("place").textContent = `${city.region} ${city.name}`.trim();
    $("icon").textContent = icon;
    $("desc").textContent = desc;
    $("temp").textContent = Math.round(c.temperature_2m);
    $("feels").textContent = `${c.apparent_temperature}${u.apparent_temperature}`;
    $("humidity").textContent = `${c.relative_humidity_2m}${u.relative_humidity_2m}`;
    $("wind").textContent = `${c.wind_speed_10m} ${u.wind_speed_10m}`;
    $("precip").textContent = `${c.precipitation} ${u.precipitation}`;
    $("updated").textContent = `기준 시각 ${c.time.replace("T", " ")}`;

    loadAir(city);
    statusEl.hidden = true;
    weatherEl.hidden = false;
  } catch (err) {
    statusEl.className = "status error";
    statusEl.textContent = `날씨를 불러오지 못했습니다: ${err.message}`;
  }
}

// ---------- 지도 (OpenStreetMap + Leaflet) ----------
// 한국(제주·울릉도·독도 포함)만 보이도록 범위 제한
const KOREA_BOUNDS = L.latLngBounds([32.8, 124.4], [38.9, 132.0]);
const map = L.map("map", {
  zoomControl: true,
  maxBounds: KOREA_BOUNDS,
  maxBoundsViscosity: 1.0,
  minZoom: 6,
}).fitBounds(KOREA_BOUNDS);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

let selMarker = null;
function focusMap(city) {
  selMarker?.remove();
  selMarker = L.circleMarker([city.lat, city.lon], {
    radius: 20, color: "#1d4ed8", weight: 3, fill: false, interactive: false,
  }).addTo(map);
  map.flyTo([city.lat, city.lon], Math.max(map.getZoom(), city.level === "dong" ? 11 : 9), { duration: 0.6 });
}

// 지도 클릭 → 그 위치의 날씨·미세먼지
map.on("click", (e) => {
  if (!KOREA_BOUNDS.contains(e.latlng)) return;
  const lat = +e.latlng.lat.toFixed(4), lon = +e.latlng.lng.toFixed(4);
  selected = { name: "선택한 위치", region: `${lat}, ${lon}`, lat, lon, level: "point" };
  searchEl.value = "";
  focusMap(selected);
  loadWeather();
});

// ---------- 미세먼지 (Open-Meteo Air Quality, 키 불필요) ----------
// 한국 환경부 기준 등급: [상한, 색, 이름]
const GRADES = {
  pm10: [[30, "#3b82f6", "좋음"], [80, "#22c55e", "보통"], [150, "#f59e0b", "나쁨"], [Infinity, "#ef4444", "매우나쁨"]],
  pm25: [[15, "#3b82f6", "좋음"], [35, "#22c55e", "보통"], [75, "#f59e0b", "나쁨"], [Infinity, "#ef4444", "매우나쁨"]],
};
const gradeOf = (metric, v) => GRADES[metric].find(([max]) => v <= max);
const AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";

let metric = "pm10";
const dust = new Map(); // city -> { pm10, pm25 }
const dustMarkers = new Map();
const dustLayer = L.layerGroup().addTo(map);

function renderLegend() {
  const ul = $("legend-list");
  ul.replaceChildren();
  let prev = 0;
  GRADES[metric].forEach(([max, color, name]) => {
    const li = document.createElement("li");
    const dot = document.createElement("i");
    dot.style.background = color;
    li.append(dot, `${name} ${max === Infinity ? prev + "~" : prev + "–" + max}`);
    ul.append(li);
    prev = max + 1;
  });
}

function renderDust() {
  dustMarkers.forEach((m, city) => {
    const d = dust.get(city);
    const v = d?.[metric];
    if (v == null) return m.remove();
    const [, color, name] = gradeOf(metric, v);
    m.setIcon(L.divIcon({
      className: "",
      html: `<div class="dust-badge" style="background:${color}">${Math.round(v)}</div>`,
      iconSize: [30, 30],
    }));
    m.setTooltipContent(`${city.name} · ${metric === "pm10" ? "PM10" : "PM2.5"} ${v} ㎍/㎥ (${name})`);
    if (!dustLayer.hasLayer(m)) dustLayer.addLayer(m);
  });
}

async function loadAllDust() {
  const note = $("dust-status");
  note.textContent = "전국 미세먼지 불러오는 중...";
  const cities = CITIES;
  try {
    for (let i = 0; i < cities.length; i += 50) { // 한 번에 50곳씩 조회
      const chunk = cities.slice(i, i + 50);
      const params = new URLSearchParams({
        latitude: chunk.map((c) => c.lat).join(","),
        longitude: chunk.map((c) => c.lon).join(","),
        current: "pm10,pm2_5",
        timezone: "Asia/Seoul",
      });
      const res = await fetch(`${AIR_URL}?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let json = await res.json();
      if (!Array.isArray(json)) json = [json];
      json.forEach((r, k) => dust.set(chunk[k], { pm10: r.current?.pm10, pm25: r.current?.pm2_5 }));
    }
    const t = [...dust.values()].length;
    note.textContent = `${t}개 시·군 · 출처: Open-Meteo 대기질(CAMS 예측 모델 값, 관측소 실측과 다를 수 있음)`;
    renderDust();
  } catch (err) {
    note.textContent = `미세먼지를 불러오지 못했습니다: ${err.message}`;
  }
}

CITIES.forEach((c) => {
  const m = L.marker([c.lat, c.lon], { icon: L.divIcon({ className: "", html: "", iconSize: [30, 30] }) });
  m.bindTooltip(c.name, { direction: "top", offset: [0, -14] });
  m.on("click", () => choose(c));
  dustMarkers.set(c, m);
});

document.querySelectorAll(".seg button").forEach((b) =>
  b.addEventListener("click", () => {
    metric = b.dataset.metric;
    document.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("on", x === b));
    renderLegend();
    renderDust();
  }));

// 선택한 위치의 미세먼지 (날씨 카드)
async function loadAir(city) {
  $("pm10").textContent = $("pm25").textContent = "--";
  try {
    const params = new URLSearchParams({ latitude: city.lat, longitude: city.lon, current: "pm10,pm2_5", timezone: "Asia/Seoul" });
    const res = await fetch(`${AIR_URL}?${params}`);
    if (!res.ok) throw new Error();
    const { current: c } = await res.json();
    if (city !== selected) return;
    const fmt = (m, v) => {
      if (v == null) return "자료 없음";
      return `${v} ㎍/㎥ (${gradeOf(m, v)[2]})`;
    };
    $("pm10").textContent = fmt("pm10", c.pm10);
    $("pm25").textContent = fmt("pm25", c.pm2_5);
  } catch {
    $("pm10").textContent = $("pm25").textContent = "불러오기 실패";
  }
}

$("refresh").addEventListener("click", () => { loadWeather(); loadAllDust(); });
setInterval(loadWeather, 10 * 60 * 1000); // 10분마다 자동 갱신
setInterval(loadAllDust, 30 * 60 * 1000);

renderLegend();
loadAllDust();
choose(CITIES[0]); // 기본: 서울
