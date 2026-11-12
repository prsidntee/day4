// Gemini 함수 호출(Function Calling) 에이전트 루프
import { toolDeclarations, executeTool } from "./tools.js";

const MAX_STEPS = 5; // 도구 호출 왕복 최대 횟수
const GEMINI_TIMEOUT_MS = 45000; // 호출 1회당 제한 (vercel.json 의 maxDuration 60초 안에서)
const TOTAL_BUDGET_MS = 54000;   // 전체 처리 시간 예산 (함수 maxDuration 60초보다 조금 짧게)
const RETRIES_PER_MODEL = 2;     // 혼잡 오류 시 모델당 재시도 횟수 (1초, 2초 간격)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 일시적 오류(과부하·내부 오류·한도)는 재시도/대체 모델 대상
const isTransient = (err) =>
  [429, 500, 502, 503, 504].includes(err.status) || /high demand|overloaded|unavailable|try again/i.test(err.message || "");

const SYSTEM_PROMPT = `당신은 한국 여행·나들이 장소를 추천하는 친절한 에이전트입니다.

규칙:
- 장소를 추천하기 전에 반드시 get_weather로 해당 지역의 날씨(비 예보, 기온, 미세먼지)를 확인하고, find_spots로 실제 장소를 검색합니다. 필요하면 두 도구를 여러 번 호출합니다.
- 도구가 돌려준 장소만 추천합니다. 도구 결과에 없는 장소 이름·주소·영업시간 등은 지어내지 않습니다.
- 날씨를 근거로 추천합니다. 비·눈이 오거나 미세먼지가 '나쁨' 이상이면 실내(박물관·카페·쇼핑몰 등)를, 맑고 선선하면 야외(공원·해변·전망대 등)를 우선합니다.
- 답변은 한국어로 간결하게: 먼저 날씨 한두 문장, 이어서 추천 장소 3~5곳을 목록으로(이름, 거리, 추천 이유 한 줄).
- 한국 밖이거나 여행·장소·날씨와 무관한 질문에는 정중히 범위를 안내합니다.
- 지역이 불분명하면 한 번만 되묻습니다.`;

async function callGemini({ apiKey, model, contents }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), GEMINI_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        tools: [{ functionDeclarations: toolDeclarations }],
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
        generationConfig: { temperature: 0.6 },
      }),
      signal: ac.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || `HTTP ${res.status}`;
      const err = new Error(`Gemini API 오류: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (err) {
    if (err.name === "AbortError") {
      const e = new Error(`Gemini 응답이 ${GEMINI_TIMEOUT_MS / 1000}초 안에 오지 않았습니다 (모델: ${model}). 잠시 후 다시 시도하거나 GEMINI_MODEL 을 더 빠른 모델로 바꿔 보세요.`);
      e.status = 504;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 혼잡·일시 오류면 재시도(점진 대기), 계속 실패하면 다음 모델로. 인증·요청 오류는 즉시 중단
async function callGeminiResilient({ apiKey, models, contents, deadline }) {
  let lastErr;
  for (const model of models) {
    for (let attempt = 0; attempt <= RETRIES_PER_MODEL; attempt++) {
      try {
        return { data: await callGemini({ apiKey, model, contents }), model };
      } catch (err) {
        lastErr = err;
        if (!isTransient(err)) {
          // 대체 모델이 없는 모델(404)은 다음 모델로, 그 밖의 비일시 오류(키·요청 오류)는 즉시 중단
          if (err.status === 404 && model !== models[0]) break;
          throw err;
        }
        const wait = 1000 * 2 ** attempt;
        if (Date.now() + wait + 3000 > deadline) break; // 시간 예산이 부족하면 더 시도하지 않음
        await sleep(wait);
      }
    }
    if (Date.now() + 3000 > deadline) break;
  }
  const msg = isTransient(lastErr)
    ? "Gemini 서버가 지금 혼잡합니다. 잠시 후 다시 시도해 주세요."
    : lastErr.message;
  const e = new Error(`${msg} (${lastErr.message})`);
  e.status = lastErr.status;
  throw e;
}

/**
 * @param {{ messages: {role:'user'|'assistant', content:string}[], apiKey:string, model:string }} opts
 * @returns {{ reply:string, toolCalls:object[], spots:object[] }}
 */
export async function runAgent({ messages, apiKey, model, fallbackModels = [] }) {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let activeModel = model; // 한 번 대체 모델로 넘어가면 이후 단계도 같은 모델 사용(함수 호출 이력 호환)
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const toolCalls = []; // UI 표시용 호출 기록
  const spots = [];     // 지도 마커용

  for (let step = 0; step < MAX_STEPS; step++) {
    const got = await callGeminiResilient({ apiKey, models: [activeModel, ...fallbackModels.filter((m) => m !== activeModel)], contents, deadline });
    activeModel = got.model;
    const data = got.data;
    const cand = data.candidates?.[0];
    const content = cand?.content;
    if (!content?.parts?.length) {
      const reason = data.promptFeedback?.blockReason || cand?.finishReason || "빈 응답";
      return { reply: `답변을 생성하지 못했습니다 (${reason}). 질문을 바꿔 다시 시도해 주세요.`, toolCalls, spots };
    }

    const calls = content.parts.filter((p) => p.functionCall);
    if (!calls.length) {
      const reply = content.parts.map((p) => p.text || "").join("").trim();
      return { reply: reply || "답변을 생성하지 못했습니다.", toolCalls, spots };
    }

    // 모델의 함수 호출 턴을 그대로 이력에 추가 (thought signature 등 보존)
    contents.push(content);

    const responseParts = await Promise.all(
      calls.map(async ({ functionCall: { name, args } }) => {
        const record = { name, args: args || {} };
        toolCalls.push(record);
        try {
          const result = await executeTool(name, args);
          record.ok = true;
          if (name === "find_spots") {
            result.spots?.forEach((s) => spots.push({ ...s, area: result.center?.name }));
          }
          return { functionResponse: { name, response: { result } } };
        } catch (err) {
          record.ok = false;
          record.error = err.message;
          // 오류도 모델에 돌려줘서 다른 방법을 시도하거나 사용자에게 설명하게 함
          return { functionResponse: { name, response: { error: err.message } } };
        }
      })
    );
    contents.push({ role: "user", parts: responseParts });
  }

  return { reply: "도구 호출이 너무 많아 답변을 마치지 못했습니다. 질문을 더 구체적으로 해 주세요.", toolCalls, spots };
}
