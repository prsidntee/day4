// 카카오 우선 추천: 질문에서 지역·장소 유형을 규칙으로 읽어 카카오 로컬 검색으로 바로 추천합니다.
// 읽지 못하거나 카카오가 안 되면(키 없음·오류·결과 없음) null 을 돌려주고, 호출한 쪽에서 Gemini 에이전트를 씁니다.
import { executeTool, hasKakaoKey, findCityInText } from "./tools.js";

const CATEGORY_WORDS = [
  [/카페|커피|디저트/, "cafe", "카페"],
  [/맛집|식당|음식점|레스토랑|밥집|점심|저녁|먹을/, "restaurant", "맛집"],
  [/박물관|미술관|전시/, "museum", "박물관·전시"],
  [/공원|산책/, "park", "공원"],
  [/해수욕장|해변|바다/, "beach", "해변"],
  [/전망대|야경/, "viewpoint", "전망대"],
  [/관광|명소|가볼\s*만|갈\s*만|여행|놀거리|구경|데이트/, "tourist_attraction", "관광 명소"],
];
const OUTDOOR = new Set(["park", "beach", "viewpoint", "tourist_attraction"]);

// 지역 토큰: 시·군 이름 바로 뒤의 구·동·읍·면·리 ("서울 종로구", "제주 한림읍"), 시·군 없이는 2글자 이상의 구·동만 인정
// (동사 어미 "가면"·"하면" 같은 오인식을 막기 위해 읍·면·리는 시·군 뒤에서만 허용)
const AREA_AFTER_CITY = /^\s*([가-힣]{1,6}(?:구|동|읍|면|리))(?![가-힣])/;
const AREA_STANDALONE = /([가-힣]{2,6}(?:구|동))(?![가-힣])/;

export function parseRequest(text) {
  const t = String(text);
  const cat = CATEGORY_WORDS.find(([re]) => re.test(t));
  const city = findCityInText(t);
  let location = null;
  if (city) {
    const rest = t.slice(t.indexOf(city) + city.length);
    const m = rest.match(AREA_AFTER_CITY);
    location = m ? `${city} ${m[1]}` : city; // "서울 종로구"
  } else {
    location = (t.match(AREA_STANDALONE) || [])[1] || null; // "해운대구", "역삼동"
  }
  return { location, category: cat?.[1] || null, label: cat?.[2] || null };
}

// 최근 사용자 메시지부터 거슬러 올라가 지역을 찾음 (후속 질문 "그럼 카페는?" 대응)
function resolve(messages) {
  const users = messages.filter((m) => m.role === "user").map((m) => m.content);
  const last = parseRequest(users[users.length - 1] || "");
  if (!last.category) return null; // 무엇을 찾는지 모르면 Gemini 에 맡김
  let location = last.location;
  for (let i = users.length - 2; !location && i >= 0; i--) location = parseRequest(users[i]).location;
  return location ? { location, category: last.category, label: last.label } : null;
}

const fmtSpot = (s, i) =>
  `- **${s.name}** (${s.distance_km}km) · ${s.address || s.type}${s.url ? ` — [카카오맵](${s.url})` : ""}`;

// 카카오로 처리하지 못했을 때는 { fallbackReason } 을 돌려줘서 화면에서 이유를 볼 수 있게 함
export async function tryKakaoFirst(messages) {
  if (!hasKakaoKey()) return { fallbackReason: "서버에 KAKAO_REST_API_KEY 가 설정되지 않음 (Vercel 환경 변수 등록 후 Redeploy 필요)" };
  const req = resolve(messages);
  if (!req) {
    const last = parseRequest(messages.filter((m) => m.role === "user").at(-1)?.content || "");
    return { fallbackReason: `질문에서 ${last.category ? "지역" : "장소 유형"}을 읽지 못함 (읽은 값 — 지역: ${last.location || "없음"}, 유형: ${last.label || "없음"})` };
  }

  const toolCalls = [];
  const run = async (name, args) => {
    const rec = { name, args };
    toolCalls.push(rec);
    const t0 = Date.now();
    try {
      const result = await executeTool(name, args);
      rec.ok = true;
      rec.ms = Date.now() - t0;
      return result;
    } catch (err) {
      rec.ok = false;
      rec.ms = Date.now() - t0;
      rec.error = err.message;
      return null;
    }
  };

  const [spotsRes, weather] = await Promise.all([
    run("find_spots", { location: req.location, category: req.category, limit: 5 }),
    run("get_weather", { location: req.location }),
  ]);

  // 카카오 결과가 없으면 Gemini 로 넘김 (OSM 으로 대체된 결과도 카카오 결과가 아니므로 넘김)
  if (!spotsRes) return { fallbackReason: `장소 검색 오류: ${toolCalls.find((t) => t.name === "find_spots")?.error || "알 수 없음"}` };
  if (spotsRes.source !== "kakao") return { fallbackReason: `카카오 호출 실패: ${spotsRes.kakao_error || "알 수 없음"}` };
  if (!spotsRes.spots?.length) return { fallbackReason: `카카오 검색 결과 없음 (${req.location}, ${req.label})` };

  const lines = [];
  if (weather) {
    const c = weather.current, today = weather.forecast?.[0], air = weather.air_quality;
    const bits = [`${c.condition} ${c.temperature_c}°C (체감 ${c.feels_like_c}°C)`];
    if (today?.rain_probability_pct != null) bits.push(`오늘 강수확률 ${today.rain_probability_pct}%`);
    if (air?.pm10) bits.push(`미세먼지 ${air.pm10.grade}`);
    lines.push(`**${spotsRes.center.name}** 현재 ${bits.join(", ")}.`);

    const rainy = (today?.rain_probability_pct ?? 0) >= 60;
    const dusty = ["나쁨", "매우나쁨"].includes(air?.pm10?.grade) || ["나쁨", "매우나쁨"].includes(air?.pm25?.grade);
    if (OUTDOOR.has(req.category) && (rainy || dusty)) {
      lines.push(`${rainy ? "비 예보가 있어요" : "미세먼지가 나빠요"}. 야외 활동이 걱정되면 "카페"나 "박물관"으로 다시 물어보세요.`);
    }
    lines.push("");
  }
  lines.push(`카카오맵 기준 가까운 ${req.label} 추천:`);
  spotsRes.spots.forEach((s, i) => lines.push(fmtSpot(s, i)));

  return {
    reply: lines.join("\n"),
    toolCalls,
    spots: spotsRes.spots.map((s) => ({ ...s, area: spotsRes.center?.name })),
    source: "kakao",
  };
}
