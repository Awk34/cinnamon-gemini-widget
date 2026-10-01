# Gemini AI Quota Widget (Spice) for Cinnamon

A lightweight Cinnamon desktop panel applet that monitors your Google Gemini AI **5-hour rolling limit** and **weekly quota** in real time.

![Donuts with Icon](pictures/donut_rings_only_with_icon.png)

## Features

- **Glanceable Panel Display:** Shows remaining percentages directly on your panel (e.g., `5h: 86% | W: 87%`).
- **Interactive Popup Menu:**
  - Cards with circular donut/torus charts.
  - Exact time until refresh (e.g. `Resets in 4h 38m (Fri 03:25 PM)`).
- **Customizable Appearance:**
  - Multiple panel display modes
  - Configurable update interval (default: 60s).
  - Optional low-quota desktop notifications with custom thresholds.
- **Privacy:**
  - Queries the local Antigravity language server via secure loopback RPC.
  - Zero external dependencies (uses pure Python standard library & Cinnamon GJS).

|    Interactive Hover / Popup Card     |         Preferences & Configuration         |
| :-----------------------------------: | :-----------------------------------------: |
| ![Popup Menu](pictures/hovercard.png) | ![Settings Window](pictures/settings_1.png) |

### Panel Display Styles

Choose how your quota is displayed directly on your Cinnamon panel:

| Style                          |                        Panel Preview                         | Description                                      |
| :----------------------------- | :----------------------------------------------------------: | :----------------------------------------------- |
| **Donuts with Icon (Default)** | ![Donuts with Icon](pictures/donut_rings_only_with_icon.png) | Circular progress rings with the Gemini icon     |
| **Standard Text**              |             ![Standard Text](pictures/image.png)             | 5h and weekly percentages with labels            |
| **Donut Rings & Text**         |  ![Donut Rings and Text](pictures/donut_rings_and_text.png)  | Circular progress rings with text                |
| **Donut Rings Only**           |      ![Donut Rings Only](pictures/donut_rings_only.png)      | Circular progress rings only                     |
| **Compact Text**               |        ![Compact Text](pictures/compressed_text.png)         | Just percentage values separated by a divider    |
| **5-Hour Only**                |            ![5h Only](pictures/5h_only_text.png)             | Only your active 5-hour rolling limit percentage |
| **Weekly Only**                |           ![Weekly Only](pictures/w_only_text.png)           | Only your active weekly limit percentage         |
| **Icon Only**                  |             ![Icon Only](pictures/icon_only.png)             | If you only want the hovercard                   |

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

- **Panel Display Style:** Choose between Standard Text, Donut Rings with Text, Donut Rings Only, Compact Text, 5h-only, Weekly-only, or Icon-only.
- **Popup Card Style:** Choose between circular Donut/Torus charts, linear Progress Bars, or both.
- **Panel Icon & Prefix:** Toggle the Gemini sparkle icon and optional `Gemini:` label prefix.
- **Update Frequency:** Set polling interval between 15 and 600 seconds (default: 60s).
- **Thresholds & Notifications:** Set custom warning (amber) and critical (red) thresholds, plus desktop notifications when quota runs low.

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

## Architecture & Cinnamon Spices Structure

This repository follows the official [Cinnamon Spices layout](https://github.com/linuxmint/cinnamon-spices-applets):

```
cinnamon-gemini-widget/
├── gemini-quota@antigravity/           # Root Spices distribution directory
│   ├── info.json                       # Author metadata for cinnamon-spices.linuxmint.com
│   ├── screenshot.png                  # Showcase screenshot for Spices catalog
│   ├── README.md                       # Documentation shown on the Spices website
│   └── files/
│       └── gemini-quota@antigravity/   # Payload extracted to ~/.local/share/cinnamon/applets/
│           ├── metadata.json           # Cinnamon applet manifest
│           ├── applet.js               # Cinnamon GJS applet implementation
│           ├── stylesheet.css          # Styling for popup cards & progress bars
│           ├── settings-schema.json    # Native Cinnamon settings GUI definition
│           ├── probe.py                # Python loopback probe for Antigravity RPC
│           ├── icon.svg                # Vector Gemini sparkle icon
│           └── icon.png                # 48x48 icon for panel and notification tray
├── pictures/                           # Showcase assets used in documentation
├── install.sh                          # Installer, panel manager & Spices validator
└── README.md                           # Main repository documentation
```
