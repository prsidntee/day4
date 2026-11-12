// 로컬 개발 서버: frontend/ 정적 서빙 + /api/chat (Vercel 함수와 같은 핸들러 사용)
// 실행: node server.mjs   (GEMINI_API_KEY 는 .env.local 또는 환경 변수)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const staticDir = resolve(root, "frontend");
const PORT = Number(process.env.PORT) || 8765;

// .env.local 읽기 (간단 파서)
const envFile = join(root, ".env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const { default: chatHandler } = await import(pathToFileURL(join(root, "api", "chat.js")).href);
const { default: configHandler } = await import(pathToFileURL(join(root, "api", "config.js")).href);

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

// Vercel 의 req/res 와 비슷하게 맞추는 어댑터
function adapt(req, res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(obj)); return res; };
  return new Promise((ok, fail) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try { req.body = raw ? JSON.parse(raw) : undefined; } catch { req.body = null; }
      ok();
    });
    req.on("error", fail);
  });
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/config") {
      await adapt(req, res);
      return configHandler(req, res);
    }
    if (url.pathname === "/api/chat") {
      await adapt(req, res);
      return await chatHandler(req, res);
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = normalize(join(staticDir, rel));
    if (!file.startsWith(staticDir)) { res.statusCode = 403; return res.end("Forbidden"); }
    const s = await stat(file).catch(() => null);
    if (!s?.isFile()) { res.statusCode = 404; return res.end("Not found"); }
    res.setHeader("Content-Type", MIME[extname(file)] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.end(await readFile(file));
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.end("Internal error");
  }
}).listen(PORT, () => {
  console.log(`http://localhost:${PORT}  (GEMINI_API_KEY ${process.env.GEMINI_API_KEY ? "설정됨" : "없음 — .env.local 에 추가하세요"})`);
});
