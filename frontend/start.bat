@echo off
rem frontend 폴더를 로컬 서버로 띄우고 브라우저를 엽니다. (http://localhost:8765)
cd /d "%~dp0"
start "" http://localhost:8765/
python -m http.server 8765
