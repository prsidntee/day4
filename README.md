# 대한민국 날씨·미세먼지 지도 + 장소 추천 에이전트

지도(OpenStreetMap)에 실시간 날씨·미세먼지를 보여주고, **Gemini 함수 호출(Function Calling)** 에이전트가
날씨와 실제 장소 검색을 조합해 장소를 추천합니다. **모든 기능은 Vercel(정적 파일 + 서버리스 함수)만으로 동작**하며 Railway 등 별도 서버는 쓰지 않습니다.

## 구조

```
frontend/        정적 웹앱 (Leaflet 2D 지도, 날씨·미세먼지, chat.js = 에이전트 채팅 UI)
api/chat.js      Vercel Serverless Function  POST /api/chat
lib/agent.js     Gemini 함수 호출 루프 (모델 -> 도구 실행 -> 결과 전달 -> 최종 답변, 최대 5회)
lib/tools.js     도구 2개: get_weather, find_spots
server.mjs       로컬 개발 서버 (frontend 서빙 + /api/chat, Vercel 없이 테스트)
vercel.json      outputDirectory=frontend, 함수 maxDuration=30초
```

### 도구

| 도구 | 하는 일 | 데이터 |
| --- | --- | --- |
| `get_weather` | 현재 날씨, 3일 예보(강수확률 포함), 미세먼지 PM10/PM2.5 | Open-Meteo (키 불필요) |
| `find_spots` | 지역 주변의 카페·식당·관광지·박물관·공원·해변·전망대 검색 또는 이름 검색 | OpenStreetMap Nominatim (키 불필요) |

모델이 질문을 보고 필요한 도구를 직접 골라 호출합니다(병렬 호출 가능). 예: "제주에서 비 오는 날 갈 카페" →
`get_weather(제주)` + `find_spots(제주, cafe)` → 날씨를 근거로 추천. 추천 장소는 지도에 번호 마커로 표시됩니다.

## 로컬 실행

1. `.env.example` 을 `.env.local` 로 복사하고 `GEMINI_API_KEY` 를 채웁니다 ([Google AI Studio](https://aistudio.google.com/apikey)에서 발급).
2. `start.bat` 실행 (또는 `node server.mjs`) → http://localhost:8765

> `frontend/index.html` 을 파일로 직접 열면 지도 타일이 403으로 막히고 `/api/chat` 도 없습니다. 꼭 위 서버로 접속하세요.

## Vercel 배포

1. 이 저장소를 Vercel에 Import (Framework Preset: **Other**, Root Directory: 저장소 루트, Build Command 비움).
2. **Settings → Environment Variables** 에 `GEMINI_API_KEY` 등록 (선택: `GEMINI_MODEL`, 기본 `gemini-2.5-flash`).
3. Deploy. 이후 `main` 에 push 하면 자동 배포됩니다.

CLI 를 쓰려면: `npm i -g vercel` → `vercel` → `vercel env add GEMINI_API_KEY` → `vercel --prod`

## 알아둘 점

- `/api/chat` 은 인증이 없으므로 누구나 호출하면 Gemini 사용량이 소진됩니다. 인스턴스 단위의 간단한 속도 제한(IP당 10분 20회)과 입력 길이 제한만 있으니, 공개 운영 전 Vercel 방화벽/WAF 규칙이나 Gemini 쿼터 상한을 설정하세요.
- Nominatim 은 공개 서비스라 초당 1회 이하만 허용되고 과하면 429 를 돌려줍니다(코드는 간격을 두고 1회 재시도). 트래픽이 늘면 카카오 로컬 API 등 키 기반 장소 검색으로 `find_spots` 를 교체하세요.
- 미세먼지는 예측 모델 값이며 관측소 실측과 다를 수 있습니다. 공식 실측(에어코리아)은 공공데이터포털 서비스 키가 필요합니다.
