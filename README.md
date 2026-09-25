# Gemini AI Quota Widget for Cinnamon

A sleek, lightweight Cinnamon desktop panel applet that monitors your Google Gemini AI **5-hour rolling limit** and **weekly quota** in real time.

![Gemini Quota Icon](icon.svg)

## Features

- **Glanceable Panel Display:** Shows remaining percentages directly on your panel (e.g., `5h: 86% | W: 87%`).
- **Interactive Popup Menu:**
  - Visual color-coded progress bars (Normal, Amber warning, Red critical).
  - Exact time until refresh (e.g. `Resets in 4h 38m (Fri 03:25 PM)`).
  - Live status indicator (Active / Offline).
  - One-click **Refresh Now** button.
- **Customizable Appearance:**
  - Multiple display modes: `5h: 85% | W: 90%`, `85% | 90% (compact)`, `5h: 85% only`, `W: 90% only`, or `Icon only`.
  - Configurable update interval (default: 60s).
  - Low-quota desktop notifications with custom thresholds.
- **High Performance & Privacy:**
  - Queries the local Antigravity language server via secure loopback RPC.
  - Zero external npm/pip dependencies (uses pure Python standard library & Cinnamon GJS).
  - Completely non-blocking asynchronous execution.

---

## Installation

### Quick Install & Enable
Run the included installation script from the project folder:

```bash
cd ~/Documents/cinnamon-gemini-widget
./install.sh enable
```

This installs the applet files to `~/.local/share/cinnamon/applets/gemini-quota@antigravity` and automatically adds it to your panel.

### Manual Activation via System Settings
If you prefer to add it manually:
1. Run `./install.sh install`
2. Open **System Settings** -> **Applets**
3. Select **Gemini AI Quota**
4. Click **+** to add it to your panel

---

## Configuration

Right-click the applet in your panel and select **Configure...** to customize:
- **Panel Label Style:** Choose between full text, compact, 5h-only, weekly-only, or icon-only.
- **Update Frequency:** Set polling interval between 15 and 600 seconds.
- **Thresholds & Notifications:** Set custom percentages for amber warning and red critical states, plus desktop notifications when quota runs low.

---

## Commands

```bash
# Check current quota in terminal
./install.sh status

# Re-install files after updates
./install.sh install

# Remove from Cinnamon panel and delete files
./install.sh uninstall
```

---

## Architecture

```
cinnamon-gemini-widget/
├── metadata.json           # Cinnamon applet manifest
├── applet.js               # Cinnamon GJS applet implementation
├── stylesheet.css          # Modern styling for popup cards & progress bars
├── settings-schema.json    # Native Cinnamon settings GUI definition
├── probe.py                # Fast Python loopback probe for Antigravity RPC
├── icon.svg                # Vector Gemini sparkle icon
├── icon.png                # 48x48 icon for panel and notification tray
├── install.sh              # One-command installer & panel manager
└── README.md               # Documentation
```
