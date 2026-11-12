// 에이전트가 호출하는 도구 2개: get_weather, find_spots
// 모두 키가 필요 없는 공개 API(Open-Meteo, OpenStreetMap Nominatim)만 사용합니다.

import { KOREA_CITIES } from "./korea-cities.js";

const UA = "korea-weather-agent/1.0 (Vercel serverless function)";

const WMO_KO = {
  0: "맑음", 1: "대체로 맑음", 2: "구름 조금", 3: "흐림", 45: "안개", 48: "서리 안개",
  51: "약한 이슬비", 53: "이슬비", 55: "강한 이슬비", 56: "어는 이슬비", 57: "강한 어는 이슬비",
  61: "약한 비", 63: "비", 65: "강한 비", 66: "어는 비", 67: "강한 어는 비",
  71: "약한 눈", 73: "눈", 75: "강한 눈", 77: "싸락눈",
  80: "약한 소나기", 81: "소나기", 82: "강한 소나기", 85: "약한 눈 소나기", 86: "강한 눈 소나기",
  95: "뇌우", 96: "우박 동반 뇌우", 99: "강한 우박 뇌우",
};

async function getJson(url, timeoutMs = 8000, extraHeaders = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...extraHeaders }, signal: ac.signal });
    if (!res.ok) {
      let detail = "";
      if (extraHeaders.Authorization) detail = await res.text().then((t) => ` ${t.slice(0, 160)}`).catch(() => "");
      throw new Error(`HTTP ${res.status} (${new URL(url).hostname})${detail}`);
    }
    return await res.json();
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`${new URL(url).hostname} 응답 시간 초과 (${timeoutMs / 1000}초)`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const qs = (o) => new URLSearchParams(o).toString();
const round = (v, d = 1) => (typeof v === "number" ? Math.round(v * 10 ** d) / 10 ** d : v);

// ---------- 카카오 로컬 API (KAKAO_REST_API_KEY 가 있을 때 우선 사용, 실패하면 OSM 으로 대체) ----------
const kakaoKey = () => (process.env.KAKAO_REST_API_KEY || "").trim().replace(/^["']+|["']+$/g, "").trim();

async function kakaoGet(path, params) {
  const key = kakaoKey();
  if (!key) throw new Error("KAKAO_REST_API_KEY 없음");
  const data = await getJson(`https://dapi.kakao.com/v2/local/${path}?${qs(params)}`, 8000, { Authorization: `KakaoAK ${key}` });
  return data.documents || [];
}

// 카카오 장소 카테고리 그룹 코드 / 키워드 검색어
const KAKAO_CATEGORY = {
  cafe: { code: "CE7" },
  restaurant: { code: "FD6" },
  tourist_attraction: { code: "AT4" },
  museum: { keyword: "박물관" },
  park: { keyword: "공원" },
  beach: { keyword: "해수욕장" },
  viewpoint: { keyword: "전망대" },
};

async function kakaoGeocode(text) {
  // 행정구역·주소는 주소 검색, 그 밖의 지명·상호는 키워드 검색
  let docs = await kakaoGet("search/address.json", { query: text, size: 1 }).catch(() => []);
  if (!docs.length) docs = await kakaoGet("search/keyword.json", { query: text, size: 1 });
  const d = docs[0];
  if (!d) return null;
  return {
    name: d.place_name || d.address_name || text,
    region: d.address_name || "",
    latitude: Number(d.y),
    longitude: Number(d.x),
  };
}

async function kakaoSpots({ latitude, longitude, category, keyword, radiusKm, limit }) {
  const common = { x: longitude, y: latitude, radius: Math.round(radiusKm * 1000), size: Math.min(limit * 2, 15) };
  const spec = keyword ? { keyword } : KAKAO_CATEGORY[category];
  let docs;
  if (spec.code) docs = await kakaoGet("search/category.json", { category_group_code: spec.code, sort: "distance", ...common });
  else docs = await kakaoGet("search/keyword.json", { query: spec.keyword, sort: "distance", ...common });
  return docs.slice(0, limit).map((d) => ({
    name: d.place_name,
    type: d.category_name,
    address: d.road_address_name || d.address_name,
    latitude: Number(d.y),
    longitude: Number(d.x),
    distance_km: round(Number(d.distance) / 1000),
    url: d.place_url,
  }));
}

// ---------- 위치 이름 -> 좌표 ----------
// Nominatim 이용 정책(초당 1회 이하)을 지키기 위한 간단한 간격 제한
let lastNominatim = 0;
async function nominatim(path, params) {
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
  const url = `https://nominatim.openstreetmap.org/${path}?${qs({ format: "jsonv2", "accept-language": "ko", countrycodes: "kr", ...params })}`;
  try {
    return await getJson(url, 10000);
  } catch (err) {
    if (!String(err.message).includes("429")) throw err;
    await new Promise((r) => setTimeout(r, 2500)); // 요청 제한에 걸리면 한 번만 재시도
    lastNominatim = Date.now();
    return getJson(url, 10000);
  }
}

const stripAdmin = (s) => String(s).replace(/\(.*\)/, "").replace(/(특별자치도|특별자치시|특별시|광역시|시|군)$/, "").trim();

function findLocalCity(token) {
  const key = stripAdmin(token);
  if (!key) return null;
  const hit = KOREA_CITIES.find(([name]) => stripAdmin(name) === key);
  return hit ? { name: stripAdmin(hit[0]), region: hit[1], latitude: hit[2], longitude: hit[3] } : null;
}

export async function geocode(name) {
  const text = String(name).trim().slice(0, 60);
  if (!text) throw new Error("위치 이름이 비어 있습니다");
  const tokens = text.split(/\s+/);

  // 1) 시·군 단위는 내장 좌표로 즉시 해결 (예: 서울, 제주, 강릉)
  const local = findLocalCity(text);
  if (local) return local;

  // 2-a) 카카오 키가 있으면 카카오 로컬로 먼저 검색 (실패하면 아래 OSM 으로 대체)
  if (kakaoKey()) {
    const k = await kakaoGeocode(text).catch((e) => { console.warn("kakao geocode 실패:", e.message); return null; });
    if (k) return k;
  }

  // 2-b) 그 밖의 지명(구·동·관광지 등, 예: 서울 종로, 해운대)은 Nominatim 검색
  const found = await nominatim("search", { q: text, limit: 6 }).catch(() => []);
  // 역·도로 등보다 행정구역/지명(boundary, place)을 우선
  const x = found.find((r) => r.category === "boundary" || r.category === "place") || found[0];
  if (x) {
    return {
      name: x.name || tokens[tokens.length - 1],
      region: String(x.display_name || "").split(",").slice(1, 4).map((p) => p.trim()).join(" "),
      latitude: Number(x.lat),
      longitude: Number(x.lon),
    };
  }

  // 3) "부산 맛집"처럼 첫 단어만 도시인 경우 그 도시로 대체
  const first = findLocalCity(tokens[0]);
  if (first) return first;
  throw new Error(`'${text}' 위치를 한국에서 찾지 못했습니다`);
}

async function resolvePlace({ location, latitude, longitude }) {
  if (typeof latitude === "number" && typeof longitude === "number") {
    return { name: location || "지정한 좌표", region: "", latitude, longitude };
  }
  if (!location) throw new Error("location 또는 latitude/longitude 중 하나가 필요합니다");
  return geocode(location);
}

// ---------- 도구 1: get_weather ----------
const gradeOf = (v, [a, b, c]) => (v <= a ? "좋음" : v <= b ? "보통" : v <= c ? "나쁨" : "매우나쁨");

export async function get_weather(args) {
  const place = await resolvePlace(args);
  const { latitude, longitude } = place;

  const forecastP = getJson(`https://api.open-meteo.com/v1/forecast?${qs({
    latitude, longitude, timezone: "Asia/Seoul", forecast_days: 3,
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
  })}`);
  const airP = getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?${qs({
    latitude, longitude, timezone: "Asia/Seoul", current: "pm10,pm2_5",
  })}`).catch(() => null); // 미세먼지는 실패해도 날씨는 반환

  const [f, air] = await Promise.all([forecastP, airP]);
  const c = f.current, d = f.daily;

  const result = {
    location: { name: place.name, region: place.region, latitude, longitude },
    current: {
      time: c.time,
      condition: WMO_KO[c.weather_code] ?? "알 수 없음",
      temperature_c: round(c.temperature_2m),
      feels_like_c: round(c.apparent_temperature),
      humidity_pct: c.relative_humidity_2m,
      wind_kmh: round(c.wind_speed_10m),
      precipitation_mm: c.precipitation,
    },
    forecast: d.time.map((date, i) => ({
      date,
      condition: WMO_KO[d.weather_code[i]] ?? "알 수 없음",
      min_c: round(d.temperature_2m_min[i]),
      max_c: round(d.temperature_2m_max[i]),
      rain_probability_pct: d.precipitation_probability_max[i],
      rain_mm: d.precipitation_sum[i],
    })),
  };
  if (air?.current) {
    const { pm10, pm2_5 } = air.current;
    result.air_quality = {
      pm10: pm10 == null ? null : { value: round(pm10), grade: gradeOf(pm10, [30, 80, 150]) },
      pm25: pm2_5 == null ? null : { value: round(pm2_5), grade: gradeOf(pm2_5, [15, 35, 75]) },
      note: "예측 모델 값이며 관측소 실측과 다를 수 있음",
    };
  }
  return result;
}

// ---------- 도구 2: find_spots ----------
// 카테고리 -> Nominatim 이 이해하는 영어 장소 유형 (동작을 확인한 것만 포함. 그 밖의 장소는 keyword 로 검색)
export const SPOT_CATEGORIES = {
  cafe: "cafe",
  restaurant: "restaurant",
  tourist_attraction: "attraction",
  museum: "museum",
  park: "park",
  beach: "beach",
  viewpoint: "viewpoint",
};

const haversineKm = (a, b, c, d) => {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (c - a) * rad, dLon = (d - b) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

export async function find_spots(args) {
  const place = await resolvePlace(args);
  const category = args.category && SPOT_CATEGORIES[args.category] ? args.category : null;
  const keyword = typeof args.keyword === "string" ? args.keyword.trim().slice(0, 40) : "";
  if (!category && !keyword) throw new Error("category 또는 keyword 중 하나가 필요합니다");

  const radiusKm = Math.min(Math.max(Number(args.radius_km) || 5, 1), 20);
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 5, 1), 8);
  const { latitude: lat, longitude: lon } = place;
  const dLat = radiusKm / 111, dLon = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));

  // 카카오 로컬 우선 (키가 없거나 실패하면 OSM Nominatim)
  if (kakaoKey()) {
    try {
      const kspots = await kakaoSpots({ latitude: lat, longitude: lon, category, keyword, radiusKm, limit });
      return {
        source: "kakao",
        center: { name: place.name, region: place.region, latitude: lat, longitude: lon },
        search: { category, keyword: keyword || null, radius_km: radiusKm },
        count: kspots.length,
        spots: kspots,
        ...(kspots.length ? {} : { note: "검색 결과가 없습니다. 반경을 넓히거나 다른 category/keyword로 다시 시도하세요." }),
      };
    } catch (e) {
      console.warn("kakao find_spots 실패, OSM 으로 대체:", e.message);
    }
  }

  const data = await nominatim("search", {
    q: keyword || SPOT_CATEGORIES[category],
    viewbox: `${lon - dLon},${lat + dLat},${lon + dLon},${lat - dLat}`,
    bounded: 1, limit: limit * 3, addressdetails: 0,
  });

  const seen = new Set();
  const spots = [];
  for (const x of data) {
    const name = (x.name || "").trim();
    if (!name || seen.has(name)) continue; // 이름 없는 항목·중복 제외
    seen.add(name);
    const sLat = Number(x.lat), sLon = Number(x.lon);
    spots.push({
      name,
      type: `${x.category}/${x.type}`,
      address: String(x.display_name || "").split(",").slice(0, 4).map((s) => s.trim()).join(", "),
      latitude: sLat,
      longitude: sLon,
      distance_km: round(haversineKm(lat, lon, sLat, sLon)),
    });
    if (spots.length >= limit) break;
  }
  return {
    source: "osm",
    center: { name: place.name, region: place.region, latitude: lat, longitude: lon },
    search: { category, keyword: keyword || null, radius_km: radiusKm },
    count: spots.length,
    spots,
    ...(spots.length ? {} : { note: "검색 결과가 없습니다. 반경을 넓히거나 다른 category/keyword로 다시 시도하세요." }),
  };
}

// ---------- Gemini 함수 선언 ----------
export const toolDeclarations = [
  {
    name: "get_weather",
    description:
      "한국 지역의 실시간 날씨(기온·체감·습도·바람·강수), 3일 예보, 미세먼지(PM10/PM2.5)를 조회한다. " +
      "location(지역 이름) 또는 latitude/longitude 중 하나를 준다. 장소를 추천하기 전에 날씨를 확인할 때 사용한다.",
    parameters: {
      type: "OBJECT",
      properties: {
        location: { type: "STRING", description: "한국의 시·군·구·동 이름. 예: 서울, 제주, 강릉, 역삼동" },
        latitude: { type: "NUMBER", description: "위도 (find_spots 결과 좌표로 날씨를 볼 때 사용)" },
        longitude: { type: "NUMBER", description: "경도" },
      },
    },
  },
  {
    name: "find_spots",
    description:
      "한국의 특정 지역 주변에서 실제 장소(카페·식당·관광지·박물관·공원 등)를 검색해 이름, 주소, 좌표, 거리를 반환한다. " +
      "category(유형) 또는 keyword(이름 검색어) 중 하나는 필수다.",
    parameters: {
      type: "OBJECT",
      properties: {
        location: { type: "STRING", description: "검색 중심 지역 이름. 예: 서울 종로, 부산 해운대, 전주" },
        latitude: { type: "NUMBER", description: "검색 중심 위도 (location 대신 사용 가능)" },
        longitude: { type: "NUMBER", description: "검색 중심 경도" },
        category: { type: "STRING", enum: Object.keys(SPOT_CATEGORIES), description: "장소 유형" },
        keyword: { type: "STRING", description: "장소 이름 검색어 (category 대신 사용). 예: 해수욕장, 한옥마을" },
        radius_km: { type: "NUMBER", description: "검색 반경 km (기본 5, 최대 20)" },
        limit: { type: "INTEGER", description: "최대 결과 수 (기본 5, 최대 8)" },
      },
    },
  },
];

const registry = { get_weather, find_spots };

export async function executeTool(name, args) {
  const fn = registry[name];
  if (!fn) throw new Error(`알 수 없는 도구: ${name}`);
  return fn(args && typeof args === "object" ? args : {});
}
