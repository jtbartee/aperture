#!/bin/bash
# Starts APERTURE locally and opens it in your browser.
cd "$(dirname "$0")"
PORT=8772
URL="http://localhost:$PORT/spectral-atlas/"
if ! command -v npm >/dev/null; then echo "Node.js is required: https://nodejs.org"; read -n 1; exit 1; fi
[ -d node_modules ] || npm install
[ -d dist ] || npm run build
npx vite preview --port $PORT --strictPort &
SERVER=$!
trap "kill $SERVER 2>/dev/null" EXIT
# wait until THIS app answers on the port before opening the browser
for i in $(seq 1 60); do
  if curl -s "$URL" | grep -q "APERTURE"; then open "$URL"; echo "Running at $URL — close this window to stop."; wait $SERVER; exit 0; fi
  sleep 0.5
done
echo "Warning: something else may be using port $PORT; the app did not start. Close other servers and try again."
read -n 1
