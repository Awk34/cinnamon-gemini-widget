#!/usr/bin/env bash
set -e

UUID="gemini-quota@antigravity"
APPLET_DIR="$HOME/.local/share/cinnamon/applets/$UUID"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
    echo "Usage: $0 [install|enable|uninstall|status|validate|daemon-install|daemon-uninstall|daemon-status]"
    echo "  install          : Copy applet files to ~/.local/share/cinnamon/applets/$UUID"
    echo "  enable           : Install and add to Cinnamon panel"
    echo "  uninstall        : Remove applet from Cinnamon"
    echo "  status           : Test probe.py and show current quota"
    echo "  validate         : Validate adherence to Cinnamon Spices standards"
    echo "  daemon-install   : Install and start systemd user daemon (alias: daemon)"
    echo "  daemon-uninstall : Stop and uninstall background user daemon"
    echo "  daemon-status    : Check systemd status of background user daemon"
    exit 1
}

do_install() {
    echo "Installing Gemini Quota Applet to $APPLET_DIR..."
    mkdir -p "$APPLET_DIR"
    SRC_DIR="$SCRIPT_DIR/$UUID/files/$UUID"
    if [ ! -d "$SRC_DIR" ]; then
        SRC_DIR="$SCRIPT_DIR"
    fi
    cp -u "$SRC_DIR"/{metadata.json,applet.js,stylesheet.css,settings-schema.json,probe.py,icon.svg,icon.png} "$APPLET_DIR/"
    chmod +x "$APPLET_DIR/probe.py"

    # Reload in Cinnamon if already running
    gdbus call --session --dest org.Cinnamon --object-path /org/Cinnamon --method org.Cinnamon.ReloadXlet "$UUID" "APPLET" >/dev/null 2>&1 || true

    echo "Applet files installed successfully!"
    echo "You can add it via System Settings -> Applets -> 'Gemini AI Quota'."
}

do_enable() {
    do_install
    echo "Checking Cinnamon enabled applets..."
    CURRENT=$(gsettings get org.cinnamon enabled-applets)
    if [[ "$CURRENT" == *"$UUID"* ]]; then
        echo "Applet is already enabled in Cinnamon."
    else
        # Find next available instance id
        MAX_ID=0
        for id in $(echo "$CURRENT" | grep -o -E '[0-9]+' || true); do
            if [ "$id" -gt "$MAX_ID" ]; then
                MAX_ID=$id
            fi
        done
        NEXT_ID=$((MAX_ID + 1))
        ENTRY="'panel1:right:1:$UUID:$NEXT_ID'"
        NEW_LIST=$(echo "$CURRENT" | sed "s/]$/, $ENTRY]/")
        gsettings set org.cinnamon enabled-applets "$NEW_LIST"
        echo "Added $UUID with instance ID $NEXT_ID to panel1:right."
    fi
}

do_uninstall() {
    echo "Removing $UUID..."
    do_daemon_uninstall 2>/dev/null || true
    CURRENT=$(gsettings get org.cinnamon enabled-applets)
    # Remove entry from enabled-applets if present
    python3 -c "
import subprocess, ast
current = ast.literal_eval(subprocess.check_output(['gsettings', 'get', 'org.cinnamon', 'enabled-applets']).decode().strip())
filtered = [x for x in current if '$UUID' not in x]
subprocess.run(['gsettings', 'set', 'org.cinnamon', 'enabled-applets', str(filtered)])
" 2>/dev/null || true
    rm -rf "$APPLET_DIR"
    echo "Applet uninstalled."
}

do_status() {
    PROBE="$SCRIPT_DIR/$UUID/files/$UUID/probe.py"
    if [ ! -f "$PROBE" ]; then
        PROBE="$SCRIPT_DIR/probe.py"
    fi
    python3 "$PROBE"
}

do_daemon_install() {
    PROBE="$APPLET_DIR/probe.py"
    if [ ! -f "$PROBE" ]; then
        PROBE="$SCRIPT_DIR/$UUID/files/$UUID/probe.py"
    fi
    if [ ! -f "$PROBE" ]; then
        PROBE="$SCRIPT_DIR/probe.py"
    fi
    echo "Installing background user daemon..."
    python3 "$PROBE" --install-daemon
}

do_daemon_uninstall() {
    PROBE="$APPLET_DIR/probe.py"
    if [ ! -f "$PROBE" ]; then
        PROBE="$SCRIPT_DIR/$UUID/files/$UUID/probe.py"
    fi
    if [ ! -f "$PROBE" ]; then
        PROBE="$SCRIPT_DIR/probe.py"
    fi
    echo "Uninstalling background user daemon..."
    python3 "$PROBE" --uninstall-daemon
}

do_daemon_status() {
    PROBE="$APPLET_DIR/probe.py"
    if [ ! -f "$PROBE" ]; then
        PROBE="$SCRIPT_DIR/$UUID/files/$UUID/probe.py"
    fi
    if [ ! -f "$PROBE" ]; then
        PROBE="$SCRIPT_DIR/probe.py"
    fi
    python3 "$PROBE" --daemon-status
    systemctl --user status gemini-quota-daemon.service --no-pager || true
}

do_validate() {
    python3 -c "
import glob, json, os, sys
from PIL import Image

uuid = '$UUID'
os.chdir(uuid)
try:
    for file in ['info.json', 'screenshot.png', 'files/%s/metadata.json' % uuid, 'files/%s/icon.png' % uuid]:
        if not os.path.exists(file):
            raise Exception('Missing file: %s' % file)

    for file in glob.glob('*'):
        if file.endswith('.po') or file.endswith('.pot'):
            raise Exception('Invalid location for translation files!')

    found = False
    for root, dirs, files in os.walk('files/%s' % uuid):
        for file in files:
            if file == 'applet.js':
                found = True
    if not found:
        raise Exception('Missing main applet.js')

    for file in ['icon.png']:
        if os.path.exists(file):
            raise Exception('Forbidden file: %s' % file)

    for directory in ['files', 'files/%s' % uuid]:
        if not os.path.isdir(directory):
            raise Exception('Missing directory: %s' % directory)

    if len(os.listdir('files')) != 1:
        raise Exception('The files directory should ONLY contain the $uuid directory!')

    with open('info.json') as f:
        info = json.load(f)
        if 'author' not in info:
            raise Exception('Missing author in info.json')
        if any(char.isspace() for char in info['author']):
            raise Exception('Whitespace in author')

    with open('files/%s/metadata.json' % uuid) as f:
        metadata = json.load(f)
        for field in ['icon', 'dangerous', 'last-edited']:
            if field in metadata:
                raise Exception('Forbidden field %s in metadata.json' % field)
        for field in ['uuid', 'name', 'description']:
            if field not in metadata:
                raise Exception('Missing field %s in metadata.json' % field)
        if metadata['uuid'] != uuid:
            raise Exception('Wrong uuid in metadata.json')
        for field in metadata:
            strval = str(metadata[field])
            if len(strval.encode()) != len(strval):
                raise Exception('Forbidden unicode in %s' % field)

    im = Image.open('files/%s/icon.png' % uuid)
    if im.size[0] != im.size[1]:
        raise Exception('icon.png not square')

    print('[OK] Structure fully adheres to Cinnamon Spices repository standards!')
except Exception as e:
    print('[FAIL] Validation error:', e)
    sys.exit(1)
"
}

case "${1:-install}" in
    install)
        do_install
        ;;
    enable)
        do_enable
        ;;
    uninstall)
        do_uninstall
        ;;
    status)
        do_status
        ;;
    daemon|daemon-install)
        do_daemon_install
        ;;
    daemon-uninstall)
        do_daemon_uninstall
        ;;
    daemon-status)
        do_daemon_status
        ;;
    validate)
        do_validate
        ;;
    *)
        usage
        ;;
esac
