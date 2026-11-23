@echo off
chcp 65001 >nul
title Brain
cd /d "%~dp0"
set PY=
where py >nul 2>nul && set PY=py
if not defined PY where python >nul 2>nul && set PY=python
if not defined PY (
  echo.
  echo  ยังไม่มี Python ในเครื่องนี้
  echo  กำลังเปิดหน้าดาวน์โหลด... ตอนติดตั้งให้ติ๊ก "Add python.exe to PATH" แล้วดับเบิลคลิกไฟล์นี้ใหม่
  start "" https://www.python.org/downloads/
  pause
  exit /b
)
echo  กำลังเปิดสมอง... (ปิดหน้าต่างนี้ = ปิดสมอง)
start "" cmd /c "timeout /t 4 >nul & start http://localhost:8765"
%PY% brain.py serve %*
pause
