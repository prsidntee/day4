// Vercel Serverless Function: POST /api/chat
// 요청: { messages: [{ role: "user" | "assistant", content: string }, ...] }
// 응답: { reply, toolCalls, spots }
import { runAgent, normalizeThinkingLevel } from "../lib/agent.js";
import { tryKakaoFirst } from "../lib/kakao-first.js";

const MAX_MESSAGES = 20;
const MAX_CHARS = 1000;

// 인스턴스 단위(best-effort) 간단한 속도 제한: IP당 10분에 20회
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(), windowMs = 10 * 60 * 1000;
  const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 20;
}

function validate(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages) || !messages.length) return "messages 배열이 필요합니다";
  if (messages.length > MAX_MESSAGES) return `대화는 최대 ${MAX_MESSAGES}개 메시지까지 지원합니다`;
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content.trim()) {
      return "각 메시지는 { role: 'user'|'assistant', content: string } 형식이어야 합니다";
    }
    if (m.content.length > MAX_CHARS) return `메시지는 ${MAX_CHARS}자 이하여야 합니다`;
  }
  if (messages[messages.length - 1].role !== "user") return "마지막 메시지는 user여야 합니다";
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST만 지원합니다" });
  }

  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  if (rateLimited(ip)) return res.status(429).json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." });

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
  const problem = validate(body);
  if (problem) return res.status(400).json({ error: problem });

  const startedAt = Date.now();
  const deadline = startedAt + 55000; // Vercel maxDuration(60초)보다 먼저 응답하기 위한 전체 마감선
  try {
    // 1순위: 카카오 로컬 검색으로 바로 추천 (질문에서 지역·장소 유형을 읽을 수 있고 카카오가 응답할 때)
    // 카카오 경로에는 최대 20초만 쓰고, 넘으면 Gemini 에 시간을 남기기 위해 포기
    const kakao = await Promise.race([
      tryKakaoFirst(body.messages),
      new Promise((ok) => setTimeout(() => ok({ fallbackReason: "카카오 응답이 20초 이상 걸려 중단" }), 20000)),
    ]).catch((err) => {
      console.warn("kakao-first 실패, Gemini 로 대체:", err.message);
      return { fallbackReason: `카카오 경로 오류: ${err.message}` };
    });
    if (kakao?.reply) return res.status(200).json(kakao);
    const fallbackReason = kakao?.fallbackReason || null;

    // 2순위: Gemini 함수 호출 에이전트 (카카오 키 없음·오류·결과 없음·질문 해석 불가일 때만)
    // 복붙하면서 섞이기 쉬운 앞뒤 공백·줄바꿈·따옴표를 제거
    const apiKey = (process.env.GEMINI_API_KEY || "").trim().replace(/^["']+|["']+$/g, "").trim();
    if (!apiKey) {
      return res.status(500).json({ error: "카카오로 추천할 수 없는 질문이고, 서버에 GEMINI_API_KEY 환경 변수도 없습니다 (Vercel 프로젝트 설정 > Environment Variables)" });
    }
    const out = await runAgent({
      messages: body.messages,
      apiKey,
      model: process.env.GEMINI_MODEL || "gemini-3.1-flash-lite",
      thinkingLevel: normalizeThinkingLevel(process.env.GEMINI_THINKING_LEVEL),
      deadline,
      // 혼잡할 때 대신 쓸 모델 (쉼표로 여러 개 가능). 기본: 항상 최신 flash 를 가리키는 별칭
      fallbackModels: (process.env.GEMINI_FALLBACK_MODELS || "gemini-flash-latest").split(",").map((m) => m.trim()).filter(Boolean),
    });
    return res.status(200).json({ ...out, source: "gemini", fallbackReason, elapsedMs: Date.now() - startedAt });
  } catch (err) {
    console.error("agent error:", err);
    const status = err.status === 429 ? 429 : err.status === 504 ? 504 : 502;
    return res.status(status).json({ error: err.message || "에이전트 실행 중 오류가 발생했습니다" });
  }
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
