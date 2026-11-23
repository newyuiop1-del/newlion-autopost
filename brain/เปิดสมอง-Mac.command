#!/bin/bash
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null 2>&1 || ! python3 -c "import sys" >/dev/null 2>&1; then
  echo ""
  echo "  ยังไม่มี Python ในเครื่องนี้ — กำลังเปิดหน้าดาวน์โหลด"
  echo "  ติดตั้งเสร็จแล้วดับเบิลคลิกไฟล์นี้ใหม่"
  open "https://www.python.org/downloads/"
  read -n 1 -s -r -p "  กดปุ่มใดก็ได้เพื่อปิด"
  exit 1
fi
echo "  กำลังเปิดสมอง... (ปิดหน้าต่างนี้ = ปิดสมอง)"
(sleep 4; open "http://localhost:8765") &
python3 brain.py serve "$@"
