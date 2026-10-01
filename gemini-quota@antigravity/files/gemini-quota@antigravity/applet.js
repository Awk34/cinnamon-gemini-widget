const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Pango = imports.gi.Pango;
const PangoCairo = imports.gi.PangoCairo;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Cairo = imports.cairo;
const Mainloop = imports.mainloop;
const Settings = imports.ui.settings;
const Util = imports.misc.util;

const UUID = "gemini-quota@antigravity";

function getQuotaColor(
  percentage,
  moderateThreshold = 40,
  warnThresh = 20,
  critThresh = 10,
) {
  if (percentage <= critThresh) {
    return {
      r: 239 / 255,
      g: 68 / 255,
      b: 68 / 255,
      hex: "#ef4444",
      name: "critical",
    };
  } else if (percentage <= warnThresh) {
    return {
      r: 245 / 255,
      g: 158 / 255,
      b: 11 / 255,
      hex: "#f59e0b",
      name: "warning",
    };
  } else if (percentage <= moderateThreshold) {
    return {
      r: 250 / 255,
      g: 204 / 255,
      b: 21 / 255,
      hex: "#facc15",
      name: "moderate",
    };
  } else {
    return {
      r: 56 / 255,
      g: 189 / 255,
      b: 248 / 255,
      hex: "#38bdf8",
      name: "healthy",
    };
  }
}

function drawTorusRing(
  area,
  fraction,
  colorRGBA,
  lineWidth = 5.5,
  centerText = null,
  textColor = null,
  fontDescStr = null,
) {
  let cr = area.get_context();
  let [width, height] = area.get_surface_size();
  if (width <= 0 || height <= 0) {
    cr.$dispose();
    return;
  }

  let cx = width / 2;
  let cy = height / 2;
  let radius = Math.min(cx, cy) - lineWidth / 2 - 1.2;
  if (radius < 1) radius = 1;

  // 1. Background ring track
  cr.setSourceRGBA(1.0, 1.0, 1.0, 0.15);
  cr.setLineWidth(lineWidth);
  cr.arc(cx, cy, radius, 0, 2 * Math.PI);
  cr.stroke();

  // 2. Depleting foreground arc (clockwise from 12 o'clock)
  let f = Math.max(0, Math.min(1.0, fraction));
  if (f > 0.005) {
    let startAngle = -Math.PI / 2;
    let endAngle = startAngle + f * 2 * Math.PI;

    cr.setSourceRGBA(colorRGBA.r, colorRGBA.g, colorRGBA.b, 1.0);
    cr.setLineWidth(lineWidth);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.arc(cx, cy, radius, startAngle, endAngle);
    cr.stroke();
  }

  // 3. Optional Center Text (e.g. "5h" and "W")
  if (centerText) {
    let layout = PangoCairo.create_layout(cr);
    let fontStr = fontDescStr || (width >= 24 ? "Sans Bold 7" : "Sans Bold 6");
    layout.set_font_description(Pango.FontDescription.from_string(fontStr));
    layout.set_text(centerText, -1);

    let [textWidth, textHeight] = layout.get_pixel_size();
    let tx = cx - textWidth / 2;
    let ty = cy - textHeight / 2;

    if (textColor) {
      cr.setSourceRGBA(textColor.r, textColor.g, textColor.b, 1.0);
    } else {
      cr.setSourceRGBA(0.95, 0.96, 0.98, 0.95);
    }

    cr.moveTo(tx, ty);
    PangoCairo.show_layout(cr, layout);
  }

  cr.$dispose();
}

class GeminiQuotaApplet extends Applet.TextIconApplet {
  constructor(orientation, panel_height, instance_id) {
    super(orientation, panel_height, instance_id);

    this.instance_id = instance_id;
    this.orientation = orientation;
    this.applet_dir = imports.ui.appletManager.appletMeta[UUID]
      ? imports.ui.appletManager.appletMeta[UUID].path
      : GLib.get_home_dir() + "/.local/share/cinnamon/applets/" + UUID;

    this.probe_path = this.applet_dir + "/probe.py";
    this.icon_path = this.applet_dir + "/icon.png";

    // Bind Settings
    this.settings = new Settings.AppletSettings(this, UUID, instance_id);
    this.settings.bind(
      "displayMode",
      "displayMode",
      this._on_settings_changed.bind(this),
    );
    this.settings.bind(
      "cardVisual",
      "cardVisual",
      this._on_settings_changed.bind(this),
    );
    this.settings.bind(
      "showIcon",
      "showIcon",
      this._on_settings_changed.bind(this),
    );
    this.settings.bind(
      "showPrefix",
      "showPrefix",
      this._on_settings_changed.bind(this),
    );
    this.settings.bind(
      "refreshInterval",
      "refreshInterval",
      this._on_refresh_interval_changed.bind(this),
    );
    this.settings.bind(
      "warningThreshold",
      "warningThreshold",
      this._on_settings_changed.bind(this),
    );
    this.settings.bind(
      "criticalThreshold",
      "criticalThreshold",
      this._on_settings_changed.bind(this),
    );
    this.settings.bind("enableNotifications", "enableNotifications");

    // Internal State
    this._quota_data = null;
    this._is_updating = false;
    this._timer_id = 0;
    this._last_warning_sent = 0;

    // Panel Donut Rings Actor
    this._setup_panel_donuts();

    // Setup Applet UI
    this._apply_icon();
    let initialMode = this.displayMode || "donuts_only";
    const showDonuts =
      initialMode === "donuts_and_text" || initialMode === "donuts_only";
    this._panelDonutsBox[showDonuts ? "show" : "hide"]();

    if (initialMode === "icon_only" || initialMode === "donuts_only") {
      this.set_applet_label("");
    } else {
      this.set_applet_label("Loading...");
    }
    this.set_applet_tooltip("Gemini AI Quota: Initializing...");

    // Setup Popup Menu
    this.menuManager = new PopupMenu.PopupMenuManager(this);
    this.menu = new Applet.AppletPopupMenu(this, orientation);
    this.menuManager.addMenu(this.menu);

    this._build_menu();

    // Initial fetch and start recurring timer
    this._fetch_quota();
    this._start_timer();
  }

  _setup_panel_donuts() {
    this._panelDonutsBox = new St.BoxLayout({
      vertical: false,
      style_class: "gemini-panel-donuts",
      y_align: Clutter.ActorAlign.CENTER,
    });

    let panelSize = Math.min(
      26,
      Math.max(20, Math.round((this._panelHeight || 40) * 0.65)),
    );

    const createDonut = (label) => {
      let area = new St.DrawingArea({
        width: panelSize,
        height: panelSize,
        y_align: Clutter.ActorAlign.CENTER,
      });
      let state = { fraction: 1.0, color: getQuotaColor(100) };
      area.connect("repaint", (a) => {
        drawTorusRing(a, state.fraction, state.color, 2.6, label);
      });
      this._panelDonutsBox.add_actor(area);
      return { area, state };
    };

    this._panel5h = createDonut("5h");
    this._panelWk = createDonut("W");

    this.actor.add(this._panelDonutsBox, {
      y_align: St.Align.MIDDLE,
      y_fill: false,
    });
    this._panelDonutsBox.hide();
  }

  _apply_icon() {
    let forceIcon = this.displayMode === "icon_only";
    let shouldShow =
      (this.showIcon || forceIcon) &&
      GLib.file_test(this.icon_path, GLib.FileTest.EXISTS);
    if (shouldShow) {
      this.set_applet_icon_path(this.icon_path);
      if (this.show_applet_icon) {
        this.show_applet_icon();
      }
    } else {
      this.hide_applet_icon();
    }
  }

  _on_settings_changed() {
    this._apply_icon();
    this._update_ui();
  }

  _on_refresh_interval_changed() {
    this._stop_timer();
    this._start_timer();
  }

  _start_timer() {
    this._stop_timer();
    let interval = Math.max(15, this.refreshInterval || 60);
    this._timer_id = Mainloop.timeout_add_seconds(interval, () => {
      this._fetch_quota();
      return true;
    });
  }

  _stop_timer() {
    if (this._timer_id > 0) {
      Mainloop.source_remove(this._timer_id);
      this._timer_id = 0;
    }
  }

  _build_menu() {
    this.menu.removeAll();

    // Main Container inside popup
    this.menuContent = new St.BoxLayout({
      vertical: true,
      style_class: "gemini-popup-box",
    });

    // 1. Header Box
    let headerBox = new St.BoxLayout({
      vertical: false,
      style_class: "gemini-header-box",
    });

    let titleLabel = new St.Label({
      text: "Google Gemini Quota",
      style_class: "gemini-header-title",
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    headerBox.add_actor(titleLabel);

    this.statusBadge = new St.Label({
      text: "Connecting...",
      style_class: "gemini-status-badge",
      y_align: Clutter.ActorAlign.CENTER,
    });
    headerBox.add_actor(this.statusBadge);

    this.menuContent.add_actor(headerBox);

    // 2. 5-Hour Limit Card
    this.card5h = this._create_quota_card("5-Hour Rolling Limit");
    this.menuContent.add_actor(this.card5h.container);

    // 3. Weekly Limit Card
    this.cardWeekly = this._create_quota_card("Weekly Limit");
    this.menuContent.add_actor(this.cardWeekly.container);

    // 3b. Background Daemon Banner (shown when daemon and IDE are inactive)
    this.daemonBannerBox = new St.BoxLayout({
      vertical: true,
      style_class: "gemini-daemon-banner",
    });
    let daemonTitle = new St.Label({
      text: "⚡ Background Sync Inactive",
      style_class: "gemini-daemon-banner-title",
    });
    let daemonDesc = new St.Label({
      text: "Install daemon to monitor quota when Antigravity IDE is closed.",
      style_class: "gemini-daemon-banner-desc",
    });
    this.daemonButton = new St.Button({
      style_class: "gemini-daemon-banner-button",
      label: "Install & Start Daemon",
      can_focus: true,
    });
    this.daemonButton.connect("clicked", () => {
      this._on_start_daemon_clicked();
    });
    this.daemonBannerBox.add_actor(daemonTitle);
    this.daemonBannerBox.add_actor(daemonDesc);
    this.daemonBannerBox.add_actor(this.daemonButton);
    this.menuContent.add_actor(this.daemonBannerBox);
    this.daemonBannerBox.hide();

    // 4. Footer Note
    let footerBox = new St.BoxLayout({
      vertical: true,
      style_class: "gemini-footer",
    });
    this.lastUpdatedLabel = new St.Label({
      text: "Last updated: Never",
      style_class: "gemini-footer-text",
    });
    footerBox.add_actor(this.lastUpdatedLabel);
    this.menuContent.add_actor(footerBox);

    // Wrap custom box in a generic popup menu item
    let section = new PopupMenu.PopupMenuSection();
    section.actor.add_actor(this.menuContent);
    this.menu.addMenuItem(section);

    // Menu Separator
    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    // Refresh Action
    let refreshItem = new PopupMenu.PopupIconMenuItem(
      "Refresh Now",
      "view-refresh-symbolic",
      St.IconType.SYMBOLIC,
    );
    refreshItem.connect("activate", () => {
      this._fetch_quota();
    });
    this.menu.addMenuItem(refreshItem);

    // Configure Action
    let settingsItem = new PopupMenu.PopupIconMenuItem(
      "Configure...",
      "preferences-system-symbolic",
      St.IconType.SYMBOLIC,
    );
    settingsItem.connect("activate", () => {
      this.configureApplet();
    });
    this.menu.addMenuItem(settingsItem);
  }

  _create_quota_card(titleText) {
    let container = new St.BoxLayout({
      vertical: true,
      style_class: "gemini-card",
    });

    // Horizontal Row: Donut Chart on Left, Info on Right
    let hRow = new St.BoxLayout({
      vertical: false,
      style_class: "gemini-card-hrow",
    });

    // Donut Torus Widget (DrawingArea + centered Label)
    let donutStack = new St.Widget({
      layout_manager: new Clutter.BinLayout(),
      style_class: "gemini-donut-stack",
      width: 60,
      height: 60,
      y_align: Clutter.ActorAlign.CENTER,
    });

    let donutArea = new St.DrawingArea({
      width: 60,
      height: 60,
      x_expand: true,
      y_expand: true,
    });
    let donutState = {
      fraction: 1.0,
      color: getQuotaColor(100),
    };
    donutArea.connect("repaint", (area) => {
      drawTorusRing(area, donutState.fraction, donutState.color, 6.0);
    });

    let donutCenterLabel = new St.Label({
      text: "--%",
      style_class: "gemini-donut-center-text",
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });

    donutStack.add_child(donutArea);
    donutStack.add_child(donutCenterLabel);
    hRow.add_actor(donutStack);

    // Right Column Info
    let infoCol = new St.BoxLayout({
      vertical: true,
      x_expand: true,
      style_class: "gemini-card-info",
      y_align: Clutter.ActorAlign.CENTER,
    });

    let topRow = new St.BoxLayout({
      vertical: false,
      style_class: "gemini-card-header",
    });
    let title = new St.Label({
      text: titleText,
      style_class: "gemini-card-title",
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    let percent = new St.Label({
      text: "--%",
      style_class: "gemini-card-percent",
      y_align: Clutter.ActorAlign.CENTER,
    });
    topRow.add_actor(title);
    topRow.add_actor(percent);
    infoCol.add_actor(topRow);

    let resetLabel = new St.Label({
      text: "Awaiting data...",
      style_class: "gemini-card-reset",
    });
    infoCol.add_actor(resetLabel);

    hRow.add_actor(infoCol);
    container.add_actor(hRow);

    // Horizontal Progress Bar Track & Fill
    let barTrack = new St.BoxLayout({
      style_class: "gemini-bar-track",
      width: 290,
    });
    let barFill = new St.BoxLayout({
      style_class: "gemini-bar-fill",
      width: 0,
    });
    barTrack.add_actor(barFill);
    container.add_actor(barTrack);

    return {
      container: container,
      hRow: hRow,
      donutStack: donutStack,
      donutArea: donutArea,
      donutState: donutState,
      donutCenterLabel: donutCenterLabel,
      percentLabel: percent,
      barTrack: barTrack,
      barFill: barFill,
      resetLabel: resetLabel,
    };
  }

  _on_start_daemon_clicked() {
    if (this.daemonButton) {
      this.daemonButton.label = "Starting Daemon...";
    }
    this._run_daemon_command(
      "--install-daemon",
      "Background daemon installed and started.",
    );
  }

  _on_stop_daemon_clicked() {
    if (this.daemonButton) {
      this.daemonButton.label = "Stopping Daemon...";
    }
    this._run_daemon_command("--stop-daemon", "Background daemon stopped.");
  }

  _on_uninstall_daemon_clicked() {
    if (this.daemonButton) {
      this.daemonButton.label = "Uninstalling Daemon...";
    }
    this._run_daemon_command(
      "--uninstall-daemon",
      "Background daemon uninstalled.",
    );
  }

  _run_daemon_command(arg, defaultMsg) {
    let python = GLib.find_program_in_path("python3") || "/usr/bin/python3";
    let probe = this.probe_path;

    try {
      let proc = new Gio.Subprocess({
        argv: [python, probe, arg],
        flags:
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
      });
      proc.init(null);

      proc.communicate_utf8_async(null, null, (obj, res) => {
        try {
          let [, stdout, stderr] = proc.communicate_utf8_finish(res);
          let msg = defaultMsg;
          if (stdout) {
            try {
              let parsed = JSON.parse(stdout);
              if (parsed.message) {
                msg = parsed.message;
              } else if (parsed.error) {
                msg = "Daemon error: " + parsed.error;
              }
            } catch (e) {}
          }
          Util.spawnCommandLine(
            "notify-send -i " +
              this.icon_path +
              ' "Gemini AI Quota" "' +
              msg +
              '"',
          );
        } catch (e) {
          Util.spawnCommandLine(
            "notify-send -i " +
              this.icon_path +
              ' "Gemini AI Quota" "Daemon action failed: ' +
              e.message +
              '"',
          );
        }
        if (this.daemonButton) {
          this.daemonButton.label = "Install & Start Daemon";
        }
        this._fetch_quota();
      });
    } catch (e) {
      if (this.daemonButton) {
        this.daemonButton.label = "Install & Start Daemon";
      }
      Util.spawnCommandLine(
        "notify-send -i " +
          this.icon_path +
          ' "Gemini AI Quota" "Failed to execute daemon command: ' +
          e.message +
          '"',
      );
    }
  }

  _fetch_quota() {
    if (this._is_updating) return;
    this._is_updating = true;

    let python = GLib.find_program_in_path("python3") || "/usr/bin/python3";
    let probe = this.probe_path;

    try {
      let proc = new Gio.Subprocess({
        argv: [python, probe],
        flags:
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
      });
      proc.init(null);

      proc.communicate_utf8_async(null, null, (obj, res) => {
        this._is_updating = false;
        try {
          let [, stdout, stderr] = proc.communicate_utf8_finish(res);
          if (stdout) {
            let parsed = JSON.parse(stdout);
            this._on_data_received(parsed);
          } else {
            this._on_error(stderr || "Empty output from probe");
          }
        } catch (e) {
          this._on_error(e.message);
        }
      });
    } catch (e) {
      this._is_updating = false;
      this._on_error(e.message);
    }
  }

  _on_data_received(data) {
    if (!data || !data.success) {
      this._on_error(data ? data.error || "Unknown error" : "No data");
      return;
    }

    this._quota_data = data;
    this._update_ui();
  }

  _on_error(errorMsg) {
    this._apply_icon();
    let mode = this.displayMode || "donuts_only";
    if (mode === "icon_only" || mode === "donuts_only") {
      this.set_applet_label("");
    } else {
      let label = "Offline";
      if (this.showPrefix) label = "Gemini: " + label;
      this.set_applet_label(label);
    }
    this.set_applet_tooltip("Gemini AI Quota: " + errorMsg);

    if (this._panelDonutsBox) {
      if (mode === "donuts_and_text" || mode === "donuts_only") {
        this._panel5h.state.fraction = 0;
        this._panel5h.state.color = {
          r: 0.45,
          g: 0.45,
          b: 0.45,
          hex: "#71717a",
          name: "offline",
        };
        this._panel5h.area.queue_repaint();
        this._panelWk.state.fraction = 0;
        this._panelWk.state.color = {
          r: 0.45,
          g: 0.45,
          b: 0.45,
          hex: "#71717a",
          name: "offline",
        };
        this._panelWk.area.queue_repaint();
        this._panelDonutsBox.show();
      } else {
        this._panelDonutsBox.hide();
      }
    }

    if (this.statusBadge) {
      this.statusBadge.text = "Offline";
      this.statusBadge.style_class = "gemini-status-badge offline";
    }

    if (this.daemonBannerBox) {
      this.daemonBannerBox.show();
    }
    if (this.daemonButton) {
      this.daemonButton.label = "Install & Start Daemon";
    }
    if (this.daemonMenuItem) {
      this.daemonMenuItem.label.text = "Install & Start Daemon";
      this.daemonMenuItem.setIconSymbolicName("system-run-symbolic");
    }

    [this.card5h, this.cardWeekly].forEach((card) => {
      if (card) {
        card.percentLabel.text = "--%";
        card.donutCenterLabel.text = "--%";
        card.barFill.width = 0;
        card.resetLabel.text = "Language server inactive";
      }
    });
  }

  _update_card(card, bucket, color, fraction, visualStyle) {
    if (!card) return;
    const totalBarWidth = 290;
    const pct = bucket.percentage !== undefined ? bucket.percentage : 100;
    const pctText = pct + "%";

    card.percentLabel.text = pctText;
    card.donutCenterLabel.text = pctText;
    card.donutCenterLabel.style = "color: " + color.hex + ";";

    card.donutState.fraction = fraction;
    card.donutState.color = color;
    card.donutArea.queue_repaint();

    card.barFill.width = Math.max(4, Math.round(fraction * totalBarWidth));
    const isSpecial = color.name !== "healthy";
    card.barFill.style_class = isSpecial
      ? "gemini-bar-fill " + color.name
      : "gemini-bar-fill";
    card.percentLabel.style_class = isSpecial
      ? "gemini-card-percent " + color.name
      : "gemini-card-percent";

    card.donutStack[visualStyle === "bars" ? "hide" : "show"]();
    card.barTrack[visualStyle === "donuts" ? "hide" : "show"]();

    let resetStr = "Resets in " + (bucket.reset_human || "--");
    if (bucket.reset_local) resetStr += " (" + bucket.reset_local + ")";
    card.resetLabel.text = resetStr;
  }

  _update_ui() {
    if (!this._quota_data || !this._quota_data.success) return;

    let g = this._quota_data.gemini;
    let h5 = g.five_hour;
    let wk = g.weekly;

    let p5h = h5.percentage !== undefined ? h5.percentage : 100;
    let pwk = wk.percentage !== undefined ? wk.percentage : 100;
    let f5h = Math.max(
      0,
      Math.min(
        1.0,
        h5.remaining_fraction !== undefined ? h5.remaining_fraction : p5h / 100,
      ),
    );
    let fwk = Math.max(
      0,
      Math.min(
        1.0,
        wk.remaining_fraction !== undefined ? wk.remaining_fraction : pwk / 100,
      ),
    );

    let moderateThresh = this.moderateThreshold || 40;
    let warnThresh = this.warningThreshold || 20;
    let critThresh = this.criticalThreshold || 10;

    let color5h = getQuotaColor(p5h, moderateThresh, warnThresh, critThresh);
    let colorWk = getQuotaColor(pwk, moderateThresh, warnThresh, critThresh);

    // 1. Update Panel Display
    let mode = this.displayMode || "donuts_only";
    const showDonuts = mode === "donuts_and_text" || mode === "donuts_only";
    this._panelDonutsBox[showDonuts ? "show" : "hide"]();

    const labels = {
      compact: `${p5h}% | ${pwk}%`,
      five_hour: `5h: ${p5h}%`,
      weekly: `W: ${pwk}%`,
      donuts_only: "",
      icon_only: "",
    };
    let labelText =
      labels[mode] !== undefined ? labels[mode] : `5h: ${p5h}% | W: ${pwk}%`;

    if (this.showPrefix && labelText.length > 0) {
      labelText = "Gemini: " + labelText;
    }
    this.set_applet_label(labelText);

    if (showDonuts) {
      this._panel5h.state.fraction = f5h;
      this._panel5h.state.color = color5h;
      this._panel5h.area.queue_repaint();

      this._panelWk.state.fraction = fwk;
      this._panelWk.state.color = colorWk;
      this._panelWk.area.queue_repaint();
    }

    // 2. Update Tooltip
    let tooltipText =
      "Google Gemini AI Quota\n" +
      "• 5-Hour: " +
      p5h +
      "% remaining (resets in " +
      (h5.reset_human || "--") +
      ")\n" +
      "• Weekly: " +
      pwk +
      "% remaining (resets in " +
      (wk.reset_human || "--") +
      ")";
    this.set_applet_tooltip(tooltipText);

    // 3. Update Status Badge & Daemon State
    let isDaemonActive = Boolean(
      this._quota_data && this._quota_data.daemon_active,
    );
    let isLive =
      this._quota_data && this._quota_data.source === "local_language_server";

    if (this.statusBadge) {
      if (isLive) {
        this.statusBadge.text = "Live Sync";
        this.statusBadge.style_class = "gemini-status-badge";
      } else if (isDaemonActive) {
        this.statusBadge.text = "Daemon (Idle)";
        this.statusBadge.style_class = "gemini-status-badge idle";
      } else {
        this.statusBadge.text = "Cached (Idle)";
        this.statusBadge.style_class = "gemini-status-badge idle";
      }
    }

    if (this.daemonBannerBox) {
      if (isDaemonActive) {
        this.daemonBannerBox.hide();
      } else {
        this.daemonBannerBox.show();
      }
    }

    if (this.daemonMenuItem) {
      if (isDaemonActive) {
        this.daemonMenuItem.label.text = "Stop Background Daemon";
        this.daemonMenuItem.setIconSymbolicName("media-playback-stop-symbolic");
      } else {
        this.daemonMenuItem.label.text = "Start Background Daemon";
        this.daemonMenuItem.setIconSymbolicName("system-run-symbolic");
      }
    }

    // 4. Update Cards
    let visualStyle = this.cardVisual || "donuts";
    this._update_card(this.card5h, h5, color5h, f5h, visualStyle);
    this._update_card(this.cardWeekly, wk, colorWk, fwk, visualStyle);

    // 5. Update Footer
    if (this.lastUpdatedLabel) {
      let now = new Date();
      let pad = (n) => String(n).padStart(2, "0");
      this.lastUpdatedLabel.text = `Last updated: ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }

    // Threshold notifications
    if (this.enableNotifications && (p5h <= warnThresh || pwk <= warnThresh)) {
      let nowTs = Math.floor(Date.now() / 1000);
      if (nowTs - this._last_warning_sent > 1800) {
        this._last_warning_sent = nowTs;
        let lowest = Math.min(p5h, pwk);
        let which = p5h <= pwk ? "5-Hour" : "Weekly";
        Util.spawnCommandLine(
          "notify-send -i " +
            this.icon_path +
            ' "Gemini AI Quota Low" "' +
            which +
            " quota is at " +
            lowest +
            '% remaining."',
        );
      }
    }
  }

  on_applet_clicked(event) {
    if (!this.menu.isOpen) {
      this._fetch_quota();
    }
    this.menu.toggle();
  }

  on_applet_removed_from_monitor() {
    this._stop_timer();
    if (this.settings) {
      this.settings.finalize();
    }
  }
}

function main(metadata, orientation, panel_height, instance_id) {
  return new GeminiQuotaApplet(orientation, panel_height, instance_id);
}
