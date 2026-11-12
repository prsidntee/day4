// GET /api/config — 브라우저가 쓸 공개 설정 (카카오맵 JavaScript 키는 원래 브라우저에 노출되는 키이며
// 카카오 개발자 콘솔의 '플랫폼 > Web 사이트 도메인' 등록으로 보호됩니다)
export default function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "GET만 지원합니다" });
  }
  const clean = (v) => (v || "").trim().replace(/^["']+|["']+$/g, "").trim();
  res.setHeader("Cache-Control", "public, max-age=60");
  return res.status(200).json({ kakaoJsKey: clean(process.env.KAKAO_JS_KEY) || null });
}
