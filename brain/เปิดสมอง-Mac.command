#!/bin/bash
cd "$(dirname "$0")"
(sleep 3; open http://localhost:8765) &
python3 brain.py serve "$@"
