@echo off
rem 로컬 개발 서버 (정적 파일 + /api/chat). 브라우저는 http://localhost:8765 로 접속하세요.
cd /d "%~dp0"
start "" http://localhost:8765/
node server.mjs
