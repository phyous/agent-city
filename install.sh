#!/bin/bash
# Build the wallpaper host and register login agents for the collector + wallpaper.
#   ./install.sh            build + install + start
#   ./install.sh uninstall  stop + remove agents (leaves this folder alone)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Applications/AgentCity.app"
LA="$HOME/Library/LaunchAgents"
UID_=$(id -u)
PY="$(command -v python3)"

stop() {
  for l in com.py.agentcity.wallpaper com.py.agentcity.collector; do
    launchctl bootout "gui/$UID_/$l" 2>/dev/null || true
  done
}

if [[ "${1:-}" == "uninstall" ]]; then
  stop
  rm -f "$LA/com.py.agentcity.wallpaper.plist" "$LA/com.py.agentcity.collector.plist"
  rm -rf "$APP"
  echo "Agent City removed."
  exit 0
fi

echo "› building AgentCity.app"
mkdir -p "$APP/Contents/MacOS" "$LA" "$HOME/Library/Logs"
cp "$ROOT/wallpaper/Info.plist" "$APP/Contents/Info.plist"
swiftc -O "$ROOT/wallpaper/main.swift" -o "$APP/Contents/MacOS/AgentCity" -framework Cocoa -framework WebKit
codesign --force -s - "$APP" >/dev/null 2>&1 || true

cat > "$LA/com.py.agentcity.collector.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.py.agentcity.collector</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$ROOT/collector.py</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/agentcity-collector.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/agentcity-collector.log</string>
</dict></plist>
EOF

cat > "$LA/com.py.agentcity.wallpaper.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.py.agentcity.wallpaper</string>
  <key>ProgramArguments</key><array><string>$APP/Contents/MacOS/AgentCity</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/agentcity-wallpaper.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/agentcity-wallpaper.log</string>
</dict></plist>
EOF

echo "› (re)starting agents"
stop
pkill -f "$ROOT/collector.py" 2>/dev/null || true
pkill -f "agent-city.*collector.py|^.*Python collector.py" 2>/dev/null || true
sleep 0.5
launchctl bootstrap "gui/$UID_" "$LA/com.py.agentcity.collector.plist"
launchctl bootstrap "gui/$UID_" "$LA/com.py.agentcity.wallpaper.plist"
echo "✓ Agent City running — menu bar ⌬ for demo/reload/quit. Browser view: http://127.0.0.1:8777/"
