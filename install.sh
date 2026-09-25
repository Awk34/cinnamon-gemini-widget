#!/usr/bin/env bash
set -e

UUID="gemini-quota@antigravity"
APPLET_DIR="$HOME/.local/share/cinnamon/applets/$UUID"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
    echo "Usage: $0 [install|enable|uninstall|status]"
    echo "  install   : Copy applet files to ~/.local/share/cinnamon/applets/$UUID"
    echo "  enable    : Install and add to Cinnamon panel"
    echo "  uninstall : Remove applet from Cinnamon"
    echo "  status    : Test probe.py and show current quota"
    exit 1
}

do_install() {
    echo "Installing Gemini Quota Applet to $APPLET_DIR..."
    mkdir -p "$APPLET_DIR"
    cp -u "$SCRIPT_DIR/metadata.json" "$APPLET_DIR/"
    cp -u "$SCRIPT_DIR/applet.js" "$APPLET_DIR/"
    cp -u "$SCRIPT_DIR/stylesheet.css" "$APPLET_DIR/"
    cp -u "$SCRIPT_DIR/settings-schema.json" "$APPLET_DIR/"
    cp -u "$SCRIPT_DIR/probe.py" "$APPLET_DIR/"
    cp -u "$SCRIPT_DIR/icon.svg" "$APPLET_DIR/"
    cp -u "$SCRIPT_DIR/icon.png" "$APPLET_DIR/"
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
    python3 "$SCRIPT_DIR/probe.py"
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
    *)
        usage
        ;;
esac
