// Vercel Serverless Function: POST /api/chat
// 요청: { messages: [{ role: "user" | "assistant", content: string }, ...] }
// 응답: { reply, toolCalls, spots }
import { runAgent } from "../lib/agent.js";

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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "서버에 GEMINI_API_KEY 환경 변수가 설정되지 않았습니다 (Vercel 프로젝트 설정 > Environment Variables)" });
  }

  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  if (rateLimited(ip)) return res.status(429).json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." });

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
  const problem = validate(body);
  if (problem) return res.status(400).json({ error: problem });

  try {
    const out = await runAgent({
      messages: body.messages,
      apiKey,
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    });
    return res.status(200).json(out);
  } catch (err) {
    console.error("agent error:", err);
    const status = err.status === 429 ? 429 : 502;
    return res.status(status).json({ error: err.message || "에이전트 실행 중 오류가 발생했습니다" });
  }
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
