#!/usr/bin/env bash
# End-to-end test of the native helper under Wine (Linux), with Wine's
# "null" graphics driver so nothing touches a real desktop.
#
#   test/windows/run-wine.sh <dir-with-harness.exe-helper-and-requests>
#
# Build the inputs on any machine with mingw-w64 + Node:
#   npm run test:windows:prepare        (writes dist/windows-test/)
# then copy dist/windows-test/ to a Linux box with Wine and run this script
# there. WINE defaults to `wine` on PATH (Proton's files/bin works too).
set -euo pipefail
DIR="$(cd "${1:?usage: run-wine.sh <dir>}" && pwd)"
WINE="${WINE:-wine}"
export WINEPREFIX="$DIR/prefix" WINEDEBUG=-all DISPLAY= WAYLAND_DISPLAY=

if [ ! -d "$WINEPREFIX" ]; then
	"$WINE" wineboot -i >/dev/null 2>&1 || true
	"$WINE" reg add 'HKCU\Software\Wine\Drivers' /v Graphics /d null /f >/dev/null 2>&1
fi

fail=0
run() { # scenario requests-file
	"$WINE" "$DIR/harness.exe" "Z:${DIR//\//\\}\\bridge-paste-helper.exe" "$DIR/$2" "$1" 2>/dev/null | tr -d '\r' >"$DIR/out-$1.txt"
}
expect() { # scenario pattern description
	if grep -qF -- "$2" "$DIR/out-$1.txt"; then echo "  ok   $3"; else echo "  FAIL $3 (missing: $2)"; fail=1; fi
}
reject() {
	if grep -qF -- "$2" "$DIR/out-$1.txt"; then echo "  FAIL $3 (unexpected: $2)"; fail=1; else echo "  ok   $3"; fi
}

echo "normal: three rapid presses into a fake Word window"
run normal requests-chain.txt
expect normal 'helper: ready ' 'helper starts and announces itself'
expect normal 'paste_html=Version:0.9' 'CF_HTML offered'
expect normal '<span style="color:#DC0000">♥</span>' 'hearts pasted as red HTML'
expect normal 'paste_rtf={\rtf1\ansi\uc1{\colortbl ;\red220\green0\blue0;}{\cf1 \u9829?}}' 'hearts pasted as red RTF'
expect normal 'paste_rtf={\rtf1\ansi\uc1{\colortbl ;\red0\green138\blue53;}{\cf1 \u9827?}}' 'clubs pasted as green RTF'
expect normal 'paste_text=♠' 'spades plain-text fallback'
expect normal 'responses=3/3' 'all requests answered'
reject normal ' error ' 'no errors'
[ "$(grep -c target_ctrl_space "$DIR/out-normal.txt")" = 2 ] && echo "  ok   Ctrl+Space only when enabled" || { echo "  FAIL Ctrl+Space count"; fail=1; }
expect normal 'after_text=ORIGINAL' 'original text restored'
expect normal 'after_private=xyz' 'original private format restored'
expect normal 'helper_exit=yes code=0' 'helper exits cleanly on stdin EOF'

echo "steal: target replaces the clipboard while pasting"
run steal requests-one.txt
expect steal 'helper: 1 ok clipboard changed by another application' 'helper notices the change'
expect steal 'after_text=STOLEN' 'newer clipboard content is not overwritten'

echo "ignore: target never reads the clipboard"
run ignore requests-one.txt
expect ignore 'helper: 1 error paste_not_observed' 'missing paste is reported'
expect ignore 'after_text=ORIGINAL' 'original clipboard restored anyway'
expect ignore 'after_private=xyz' 'original private format restored anyway'

"${WINE%/wine}/wineserver" -k 2>/dev/null || wineserver -k 2>/dev/null || true
exit $fail
