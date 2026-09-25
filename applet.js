const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Mainloop = imports.mainloop;
const Settings = imports.ui.settings;
const Util = imports.misc.util;

const UUID = "gemini-quota@antigravity";

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
        this.settings.bind("displayMode", "displayMode", this._on_settings_changed.bind(this));
        this.settings.bind("showIcon", "showIcon", this._on_settings_changed.bind(this));
        this.settings.bind("showPrefix", "showPrefix", this._on_settings_changed.bind(this));
        this.settings.bind("refreshInterval", "refreshInterval", this._on_refresh_interval_changed.bind(this));
        this.settings.bind("warningThreshold", "warningThreshold", this._on_settings_changed.bind(this));
        this.settings.bind("criticalThreshold", "criticalThreshold", this._on_settings_changed.bind(this));
        this.settings.bind("enableNotifications", "enableNotifications");

        // State
        this._quota_data = null;
        this._is_updating = false;
        this._timer_id = 0;
        this._last_warning_sent = 0;

        // Setup Applet UI
        this._apply_icon();
        this.set_applet_label("Loading...");
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

    _apply_icon() {
        if (this.showIcon && GLib.file_test(this.icon_path, GLib.FileTest.EXISTS)) {
            this.set_applet_icon_path(this.icon_path);
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
            style_class: "gemini-popup-box"
        });

        // 1. Header Box
        let headerBox = new St.BoxLayout({
            vertical: false,
            style_class: "gemini-header-box"
        });

        let titleLabel = new St.Label({
            text: "Google Gemini Quota",
            style_class: "gemini-header-title",
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        headerBox.add_actor(titleLabel);

        this.statusBadge = new St.Label({
            text: "Connecting...",
            style_class: "gemini-status-badge",
            y_align: Clutter.ActorAlign.CENTER
        });
        headerBox.add_actor(this.statusBadge);

        this.menuContent.add_actor(headerBox);

        // 2. 5-Hour Limit Card
        this.card5h = this._create_quota_card("5-Hour Rolling Limit");
        this.menuContent.add_actor(this.card5h.container);

        // 3. Weekly Limit Card
        this.cardWeekly = this._create_quota_card("Weekly Limit");
        this.menuContent.add_actor(this.cardWeekly.container);

        // 4. Footer Note
        let footerBox = new St.BoxLayout({
            vertical: true,
            style_class: "gemini-footer"
        });
        this.lastUpdatedLabel = new St.Label({
            text: "Last updated: Never",
            style_class: "gemini-footer-text"
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
        let refreshItem = new PopupMenu.PopupIconMenuItem("Refresh Now", "view-refresh-symbolic", St.IconType.SYMBOLIC);
        refreshItem.connect("activate", () => {
            this._fetch_quota();
        });
        this.menu.addMenuItem(refreshItem);

        // Configure Action
        let settingsItem = new PopupMenu.PopupIconMenuItem("Configure...", "preferences-system-symbolic", St.IconType.SYMBOLIC);
        settingsItem.connect("activate", () => {
            Util.spawnCommandLine("cinnamon-settings applets " + UUID + " " + this.instance_id);
        });
        this.menu.addMenuItem(settingsItem);
    }

    _create_quota_card(titleText) {
        let container = new St.BoxLayout({
            vertical: true,
            style_class: "gemini-card"
        });

        // Top row (Title + Percentage)
        let topRow = new St.BoxLayout({
            vertical: false,
            style_class: "gemini-card-header"
        });
        let title = new St.Label({
            text: titleText,
            style_class: "gemini-card-title",
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        let percent = new St.Label({
            text: "--%",
            style_class: "gemini-card-percent",
            y_align: Clutter.ActorAlign.CENTER
        });
        topRow.add_actor(title);
        topRow.add_actor(percent);
        container.add_actor(topRow);

        // Progress bar track & fill
        let barTrack = new St.BoxLayout({
            style_class: "gemini-bar-track",
            width: 270
        });
        let barFill = new St.BoxLayout({
            style_class: "gemini-bar-fill",
            width: 0
        });
        barTrack.add_actor(barFill);
        container.add_actor(barTrack);

        // Subtitle (Reset Time)
        let resetLabel = new St.Label({
            text: "Awaiting data...",
            style_class: "gemini-card-reset"
        });
        container.add_actor(resetLabel);

        return {
            container: container,
            percentLabel: percent,
            barFill: barFill,
            resetLabel: resetLabel
        };
    }

    _fetch_quota() {
        if (this._is_updating) return;
        this._is_updating = true;

        let python = GLib.find_program_in_path("python3") || "/usr/bin/python3";
        let probe = this.probe_path;

        try {
            let proc = new Gio.Subprocess({
                argv: [python, probe],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
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
            this._on_error(data ? (data.error || "Unknown error") : "No data");
            return;
        }

        this._quota_data = data;
        this._update_ui();
    }

    _on_error(errorMsg) {
        let label = "Offline";
        if (this.showPrefix) label = "Gemini: " + label;
        this.set_applet_label(label);
        this.set_applet_tooltip("Gemini AI Quota: " + errorMsg);

        if (this.statusBadge) {
            this.statusBadge.text = "Offline";
            this.statusBadge.style_class = "gemini-status-badge offline";
        }
        if (this.card5h) {
            this.card5h.percentLabel.text = "--%";
            this.card5h.barFill.width = 0;
            this.card5h.resetLabel.text = "Language server inactive";
        }
        if (this.cardWeekly) {
            this.cardWeekly.percentLabel.text = "--%";
            this.cardWeekly.barFill.width = 0;
            this.cardWeekly.resetLabel.text = "Language server inactive";
        }
    }

    _update_ui() {
        if (!this._quota_data || !this._quota_data.success) return;

        let g = this._quota_data.gemini;
        let h5 = g.five_hour;
        let wk = g.weekly;

        let p5h = h5.percentage !== undefined ? h5.percentage : 100;
        let pwk = wk.percentage !== undefined ? wk.percentage : 100;

        // 1. Update Panel Label
        let labelText = "";
        let mode = this.displayMode || "both";

        switch (mode) {
            case "both":
                labelText = "5h: " + p5h + "% | W: " + pwk + "%";
                break;
            case "compact":
                labelText = p5h + "% | " + pwk + "%";
                break;
            case "five_hour":
                labelText = "5h: " + p5h + "%";
                break;
            case "weekly":
                labelText = "W: " + pwk + "%";
                break;
            case "icon_only":
                labelText = "";
                break;
            default:
                labelText = "5h: " + p5h + "% | W: " + pwk + "%";
        }

        if (this.showPrefix && labelText.length > 0) {
            labelText = "Gemini: " + labelText;
        }

        this.set_applet_label(labelText);

        // 2. Update Tooltip
        let tooltipText = "Google Gemini AI Quota\n" +
            "• 5-Hour: " + p5h + "% remaining (resets in " + (h5.reset_human || "--") + ")\n" +
            "• Weekly: " + pwk + "% remaining (resets in " + (wk.reset_human || "--") + ")";
        this.set_applet_tooltip(tooltipText);

        // 3. Update Status Badge
        if (this.statusBadge) {
            this.statusBadge.text = "Active";
            this.statusBadge.style_class = "gemini-status-badge";
        }

        // 4. Update Cards
        const totalBarWidth = 270;
        let warnThresh = this.warningThreshold || 20;
        let critThresh = this.criticalThreshold || 10;

        // Update 5-Hour Card
        if (this.card5h) {
            this.card5h.percentLabel.text = p5h + "%";
            let f5 = Math.max(0, Math.min(1.0, h5.remaining_fraction !== undefined ? h5.remaining_fraction : p5h / 100));
            this.card5h.barFill.width = Math.max(4, Math.round(f5 * totalBarWidth));

            let cls = "gemini-bar-fill";
            let txtCls = "gemini-card-percent";
            if (p5h <= critThresh) {
                cls += " critical";
                txtCls += " critical";
            } else if (p5h <= warnThresh) {
                cls += " warning";
                txtCls += " warning";
            }
            this.card5h.barFill.style_class = cls;
            this.card5h.percentLabel.style_class = txtCls;

            let reset5Str = "Resets in " + (h5.reset_human || "--");
            if (h5.reset_local) reset5Str += " (" + h5.reset_local + ")";
            this.card5h.resetLabel.text = reset5Str;
        }

        // Update Weekly Card
        if (this.cardWeekly) {
            this.cardWeekly.percentLabel.text = pwk + "%";
            let fwk = Math.max(0, Math.min(1.0, wk.remaining_fraction !== undefined ? wk.remaining_fraction : pwk / 100));
            this.cardWeekly.barFill.width = Math.max(4, Math.round(fwk * totalBarWidth));

            let cls = "gemini-bar-fill";
            let txtCls = "gemini-card-percent";
            if (pwk <= critThresh) {
                cls += " critical";
                txtCls += " critical";
            } else if (pwk <= warnThresh) {
                cls += " warning";
                txtCls += " warning";
            }
            this.cardWeekly.barFill.style_class = cls;
            this.cardWeekly.percentLabel.style_class = txtCls;

            let resetWkStr = "Resets in " + (wk.reset_human || "--");
            if (wk.reset_local) resetWkStr += " (" + wk.reset_local + ")";
            this.cardWeekly.resetLabel.text = resetWkStr;
        }

        // 5. Update Footer
        if (this.lastUpdatedLabel) {
            let now = new Date();
            let hours = String(now.getHours()).padStart(2, "0");
            let mins = String(now.getMinutes()).padStart(2, "0");
            let secs = String(now.getSeconds()).padStart(2, "0");
            this.lastUpdatedLabel.text = "Last updated: " + hours + ":" + mins + ":" + secs;
        }

        // 6. Threshold notifications
        if (this.enableNotifications && (p5h <= warnThresh || pwk <= warnThresh)) {
            let nowTs = Math.floor(Date.now() / 1000);
            if (nowTs - this._last_warning_sent > 1800) { // Notify at most once every 30 mins
                this._last_warning_sent = nowTs;
                let lowest = Math.min(p5h, pwk);
                let which = p5h <= pwk ? "5-Hour" : "Weekly";
                Util.spawnCommandLine(
                    'notify-send -i ' + this.icon_path +
                    ' "Gemini AI Quota Low" "' + which + ' quota is at ' + lowest + '% remaining."'
                );
            }
        }
    }

    on_applet_clicked(event) {
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
