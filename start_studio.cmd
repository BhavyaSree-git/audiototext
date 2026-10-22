@echo off
cd /d "%~dp0"
".venv\Scripts\python.exe" studio_server.py --open
pause
