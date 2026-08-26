#!/usr/bin/env bash
# V4/S10 end-to-end workspace verification against a LIVE daemon + REAL repo.
# Boots the daemon on a scratch port/data dir, exercises files/git/terminal/
# conversation/contract APIs, then shuts down cleanly.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${DEVFLOW_VERIFY_PORT:-47761}"
DATA="$(mktemp -d)"
REPO="$(mktemp -d)"
cleanup() {
  [[ -n "${DAEMON_PID:-}" ]] && kill "$DAEMON_PID" 2>/dev/null || true
  rm -rf "$DATA" "$REPO"
}
trap cleanup EXIT

# Real project repo with a working-tree change
git init -q "$REPO"
git -C "$REPO" config user.email t@local && git -C "$REPO" config user.name t
mkdir -p "$REPO/src"
echo "export const login = () => true;" > "$REPO/src/auth.ts"
echo "# demo" > "$REPO/README.md"
git -C "$REPO" add . && git -C "$REPO" commit -qm initial
echo "export const login = () => 'oauth';" > "$REPO/src/auth.ts"

cd "$ROOT/apps/daemon"
DEVFLOW_HTTP_PORT="$PORT" DEVFLOW_DATA_DIR="$DATA" npx tsx src/main.ts >"$DATA/daemon.log" 2>&1 &
DAEMON_PID=$!

for i in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null && break
  sleep 0.5
done
B="http://127.0.0.1:$PORT/api"
PASS=0; FAIL=0
check() { # check <label> <actual> <expected-substring>
  if echo "$2" | grep -q "$3"; then PASS=$((PASS+1)); echo "  ok: $1";
  else FAIL=$((FAIL+1)); echo "  FAIL: $1 — got: $(echo "$2" | head -c 200)"; fi
}

PROJECT=$(curl -sf -X POST "$B/projects" -H 'Content-Type: application/json' \
  -d "{\"name\":\"V4 Verify\",\"repositoryPath\":\"$REPO\"}")
PID=$(echo "$PROJECT" | sed -E 's/.*"id":"([^"]+)".*/\1/')
echo "== project $PID =="

# Real mission → real planned task (readiness gate overridden for brevity)
curl -sf -X POST "$B/projects/$PID/mission" -H 'Content-Type: application/json' \
  -d '{"rawRequest":"Improve the login flow"}' >/dev/null
PLAN=$(curl -s -X POST "$B/projects/$PID/plan" -H 'Content-Type: application/json' -d '{"overrideReadinessGate":true}')
check "plan produced tasks" "$PLAN" '"stableKey"'

TREE=$(curl -sf "$B/projects/$PID/files")
check "file tree lists src/" "$TREE" '"src"'
FILE=$(curl -sf "$B/projects/$PID/file?path=src/auth.ts")
check "file read returns oauth change" "$FILE" 'oauth'
DIFF=$(curl -sf "$B/projects/$PID/git/diff")
check "working-tree diff shows hunks" "$DIFF" '@@'
check "diff contains the oauth change" "$DIFF" "oauth"
STATUS=$(curl -sf "$B/projects/$PID/git/status")
check "git status flags auth.ts" "$STATUS" 'auth.ts'
LOG=$(curl -sf "$B/projects/$PID/git/log?path=src/auth.ts")
check "file history has initial commit" "$LOG" 'initial'
SEARCH=$(curl -sf "$B/projects/$PID/files/search?q=auth")
check "search finds auth.ts" "$SEARCH" 'src/auth.ts'

TRAVERSAL=$(curl -s -o /dev/null -w '%{http_code}' "$B/projects/$PID/file?path=../../../etc/passwd")
check "traversal rejected (4xx)" "$TRAVERSAL" '4'

SESSION=$(curl -sf -X POST "$B/projects/$PID/terminal" -H 'Content-Type: application/json' -d '{"type":"USER"}')
TID=$(echo "$SESSION" | sed -E 's/.*"id":"([^"]+)".*/\1/')
echo "== terminal $TID =="
MARKER="TERM_OK_$$"
curl -sf -X POST "$B/terminal/$TID/input" -H 'Content-Type: application/json' -d "{\"data\":\"echo $MARKER\"}" >/dev/null
SEEN=""
for i in $(seq 1 40); do
  OUT=$(curl -sf "$B/terminal/$TID/output?afterSeq=0")
  case "$OUT" in *"$MARKER"*) SEEN=yes;; esac
  [ -n "$SEEN" ] && break
  sleep 0.25
done
check "real shell executed command" "${SEEN:-no}" 'yes'

CONV=$(curl -sf -X POST "$B/projects/$PID/conversation" -H 'Content-Type: application/json' \
  -d '{"text":"생각해보니 회원가입 자체를 없애자"}')
check "conversation classifies REQUIREMENT_CHANGE" "$CONV" 'REQUIREMENT_CHANGE'
TASKS=$(curl -sf "$B/projects/$PID/tasks")
echo "$TASKS" | grep -q '"status":"BLOCKED"' && { PASS=$((PASS+1)); echo "  ok: requirement change blocked tasks"; } || { FAIL=$((FAIL+1)); echo "  FAIL: tasks not blocked"; }

CONTRACT=$(curl -sf -X POST "$B/projects/$PID/contract/refresh")
check "contract compiled with readiness" "$CONTRACT" 'readiness'
check "contract surfaces open questions" "$CONTRACT" 'openQuestions'

kill "$DAEMON_PID" 2>/dev/null || true
sleep 1
if pgrep -P "$DAEMON_PID" >/dev/null 2>&1; then FAIL=$((FAIL+1)); echo "  FAIL: daemon still alive"; else PASS=$((PASS+1)); echo "  ok: daemon exited cleanly"; fi

echo "== RESULT: PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ]
