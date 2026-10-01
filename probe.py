#!/usr/bin/env python3
"""
probe.py - Gemini Quota Probe for Cinnamon Applet
Discovers local Antigravity language server / agy process and retrieves
the 5-hour rolling limit and weekly quota for Gemini models.
Supports background daemon management and intelligent projection caching.
"""

import sys
import os
import re
import json
import ssl
import subprocess
import urllib.request
from datetime import datetime, timezone

CACHE_FILE = os.path.expanduser("~/.cache/gemini-quota-cache.json")
SERVICE_NAME = "gemini-quota-daemon.service"

def format_time_delta(seconds: int) -> str:
    if seconds <= 0:
        return "Refreshing now..."
    days = seconds // 86400
    hours = (seconds % 86400) // 3600
    minutes = (seconds % 3600) // 60
    if days > 0:
        return f"{days}d {hours}h"
    elif hours > 0:
        return f"{hours}h {minutes}m"
    else:
        return f"{minutes}m"

def make_bucket(fraction=1.0, percentage=100, reset_time="", reset_local="", reset_seconds=0, reset_human="Full", description=""):
    return {
        "remaining_fraction": fraction,
        "percentage": percentage,
        "reset_time": reset_time,
        "reset_local": reset_local,
        "reset_in_seconds": reset_seconds,
        "reset_human": reset_human,
        "description": description,
    }

def is_daemon_active() -> bool:
    try:
        res = subprocess.run(["systemctl", "--user", "is-active", SERVICE_NAME], capture_output=True, text=True, timeout=1.0)
        return res.stdout.strip() == "active"
    except Exception:
        return False

def is_daemon_installed() -> bool:
    service_path = os.path.expanduser(f"~/.config/systemd/user/{SERVICE_NAME}")
    return os.path.exists(service_path)

def save_cache(data: dict):
    try:
        os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
        with open(CACHE_FILE, "w") as f:
            json.dump(data, f, indent=2)
    except Exception:
        pass

def load_and_project_cache():
    if not os.path.exists(CACHE_FILE):
        return None
    try:
        with open(CACHE_FILE, "r") as f:
            cached = json.load(f)
        if not cached.get("success") or not cached.get("gemini"):
            return None

        now_utc = datetime.now(timezone.utc)
        gemini = cached["gemini"]

        for key in ["five_hour", "weekly"]:
            b = gemini.get(key)
            if not b:
                continue
            reset_str = b.get("reset_time", "")
            if reset_str:
                try:
                    dt = datetime.fromisoformat(reset_str.replace("Z", "+00:00"))
                    reset_delta = max(0, int((dt - now_utc).total_seconds()))
                    b["reset_in_seconds"] = reset_delta
                    if reset_delta <= 0:
                        b["remaining_fraction"] = 1.0
                        b["percentage"] = 100
                        b["reset_human"] = "Full"
                    else:
                        b["reset_human"] = format_time_delta(reset_delta)
                    local_dt = dt.astimezone()
                    b["reset_local"] = local_dt.strftime("%a %I:%M %p")
                except Exception:
                    pass

        daemon_act = is_daemon_active()
        cached["source"] = "daemon_cache" if daemon_act else "projected_cache"
        cached["status"] = "idle"
        cached["daemon_active"] = daemon_act
        cached["daemon_installed"] = is_daemon_installed()
        cached["timestamp"] = int(now_utc.timestamp())
        return cached
    except Exception:
        return None

def find_language_server_candidates():
    candidates = []
    seen = set()

    # 1. Direct /proc inspection
    try:
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            cmdline_path = os.path.join("/proc", entry, "cmdline")
            try:
                with open(cmdline_path, "rb") as f:
                    cmd_bytes = f.read()
                    cmd_str = cmd_bytes.decode("utf-8", errors="ignore").replace("\0", " ")
                    if "language_server" in cmd_str and "--csrf_token" in cmd_str:
                        m_token = re.search(r"--csrf_token(?:\s+|=)([a-zA-Z0-9-]+)", cmd_str)
                        if m_token:
                            pid = int(entry)
                            if pid not in seen:
                                candidates.append((pid, m_token.group(1)))
                                seen.add(pid)
            except (IOError, PermissionError, ProcessLookupError):
                continue
    except Exception:
        pass

    # 2. Fallback to pgrep
    if not candidates:
        try:
            pgrep = subprocess.run(["pgrep", "-a", "language_server"], capture_output=True, text=True, timeout=1.5)
            for line in pgrep.stdout.strip().split("\n"):
                if "language_server" in line and "--csrf_token" in line:
                    parts = line.strip().split()
                    if parts:
                        pid = int(parts[0])
                        m_token = re.search(r"--csrf_token(?:\s+|=)([a-zA-Z0-9-]+)", line)
                        if m_token and pid not in seen:
                            candidates.append((pid, m_token.group(1)))
                            seen.add(pid)
        except Exception:
            pass

    return candidates

def get_ports_for_pid(target_pid: int):
    ports = []
    try:
        ss_out = subprocess.run(["ss", "-tlnp"], capture_output=True, text=True, timeout=1.5)
        for row in ss_out.stdout.split("\n"):
            if f"pid={target_pid}" in row:
                m_port = re.search(r":(\d+)\s+", row)
                if m_port:
                    ports.append(int(m_port.group(1)))
    except Exception:
        pass

    if not ports:
        try:
            lsof_out = subprocess.run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", str(target_pid)], capture_output=True, text=True, timeout=1.5)
            for row in lsof_out.stdout.split("\n"):
                m_port = re.search(r":(\d+)\s+\(LISTEN\)", row)
                if m_port:
                    ports.append(int(m_port.group(1)))
        except Exception:
            pass

    return list(dict.fromkeys(ports))

def query_candidate(target_pid: int, csrf_token: str):
    ports = get_ports_for_pid(target_pid)
    if not ports:
        return None

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    payload = json.dumps({
        "metadata": {
            "ideName": "antigravity",
            "extensionName": "antigravity",
            "ideVersion": "unknown",
            "locale": "en"
        }
    }).encode("utf-8")

    path = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary"
    now_utc = datetime.now(timezone.utc)

    for port in ports:
        url = f"https://127.0.0.1:{port}{path}"
        req = urllib.request.Request(url, data=payload, headers={
            "Content-Type": "application/json",
            "X-Codeium-Csrf-Token": csrf_token,
            "Connect-Protocol-Version": "1"
        })
        try:
            with urllib.request.urlopen(req, context=ctx, timeout=1.5) as resp:
                if resp.status == 200:
                    raw_json = json.loads(resp.read().decode("utf-8"))
                    response_obj = raw_json.get("response", {})
                    groups = response_obj.get("groups", [])

                    gemini_group = None
                    for g in groups:
                        if "gemini" in g.get("displayName", "").lower():
                            gemini_group = g
                            break

                    if not gemini_group and groups:
                        gemini_group = groups[0]

                    if not gemini_group:
                        continue

                    buckets = gemini_group.get("buckets", [])
                    quota_5h = None
                    quota_weekly = None

                    for b in buckets:
                        b_window = b.get("window", "")
                        b_id = b.get("bucketId", "")
                        rem_fraction = float(b.get("remainingFraction", 0.0))
                        percent = int(round(rem_fraction * 100))
                        reset_str = b.get("resetTime", "")

                        reset_delta = 0
                        local_time_str = ""
                        if reset_str:
                            try:
                                dt = datetime.fromisoformat(reset_str.replace("Z", "+00:00"))
                                reset_delta = max(0, int((dt - now_utc).total_seconds()))
                                local_dt = dt.astimezone()
                                local_time_str = local_dt.strftime("%a %I:%M %p")
                            except Exception:
                                pass

                        bucket_data = make_bucket(
                            fraction=rem_fraction,
                            percentage=percent,
                            reset_time=reset_str,
                            reset_local=local_time_str,
                            reset_seconds=reset_delta,
                            reset_human=format_time_delta(reset_delta),
                            description=b.get("description", "")
                        )

                        if b_window == "5h" or "5h" in b_id:
                            quota_5h = bucket_data
                        elif b_window == "weekly" or "weekly" in b_id:
                            quota_weekly = bucket_data

                    daemon_act = is_daemon_active()
                    result = {
                        "success": True,
                        "source": "local_language_server",
                        "status": "active",
                        "port": port,
                        "pid": target_pid,
                        "daemon_active": daemon_act,
                        "daemon_installed": is_daemon_installed(),
                        "timestamp": int(now_utc.timestamp()),
                        "gemini": {
                            "five_hour": quota_5h or make_bucket(),
                            "weekly": quota_weekly or make_bucket()
                        }
                    }
                    save_cache(result)
                    return result
        except Exception:
            continue
    return None

def get_quota_from_language_server(force_refresh=False):
    candidates = find_language_server_candidates()
    for pid, token in candidates:
        res = query_candidate(pid, token)
        if res:
            return res

    # If live language server wasn't reachable, try cache
    projected = load_and_project_cache()
    if projected:
        return projected

    daemon_act = is_daemon_active()
    return {
        "success": False,
        "daemon_active": daemon_act,
        "daemon_installed": is_daemon_installed(),
        "can_install_daemon": True,
        "error": "Antigravity language server is not running.",
        "hint": "Open Antigravity IDE or enable the background daemon."
    }

def install_daemon():
    probe_path = os.path.abspath(__file__)
    unit_dir = os.path.expanduser("~/.config/systemd/user")
    os.makedirs(unit_dir, exist_ok=True)
    unit_file = os.path.join(unit_dir, SERVICE_NAME)
    python_bin = sys.executable or "/usr/bin/python3"
    content = f"""[Unit]
Description=Gemini AI Quota Background Monitor
After=network.target

[Service]
Type=simple
ExecStart={python_bin} "{probe_path}" --daemon
Restart=always
RestartSec=15

[Install]
WantedBy=default.target
"""
    try:
        with open(unit_file, "w") as f:
            f.write(content)
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
        subprocess.run(["systemctl", "--user", "enable", "--now", SERVICE_NAME], check=True)
        # Pre-seed cache if possible
        get_quota_from_language_server(force_refresh=True)
        return {"success": True, "message": "Daemon installed and started successfully."}
    except Exception as e:
        return {"success": False, "error": str(e)}

def uninstall_daemon():
    try:
        subprocess.run(["systemctl", "--user", "disable", "--now", SERVICE_NAME], capture_output=True)
        unit_file = os.path.expanduser(f"~/.config/systemd/user/{SERVICE_NAME}")
        if os.path.exists(unit_file):
            os.remove(unit_file)
        subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True)
        return {"success": True, "message": "Daemon uninstalled successfully."}
    except Exception as e:
        return {"success": False, "error": str(e)}

def start_daemon():
    try:
        if not is_daemon_installed():
            return install_daemon()
        subprocess.run(["systemctl", "--user", "start", SERVICE_NAME], check=True)
        return {"success": True, "message": "Daemon started."}
    except Exception as e:
        return {"success": False, "error": str(e)}

def stop_daemon():
    try:
        subprocess.run(["systemctl", "--user", "stop", SERVICE_NAME], check=True)
        return {"success": True, "message": "Daemon stopped."}
    except Exception as e:
        return {"success": False, "error": str(e)}

def run_daemon():
    import time
    import signal

    running = True
    def _sig_handler(sig, frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, _sig_handler)
    signal.signal(signal.SIGINT, _sig_handler)

    while running:
        try:
            get_quota_from_language_server(force_refresh=True)
        except Exception:
            pass
        for _ in range(30):
            if not running:
                break
            time.sleep(1)

def main():
    if len(sys.argv) > 1:
        arg = sys.argv[1]
        if arg == "--daemon":
            run_daemon()
            sys.exit(0)
        elif arg in ("--install-daemon", "install-daemon"):
            res = install_daemon()
            print(json.dumps(res, indent=2))
            sys.exit(0 if res.get("success") else 1)
        elif arg in ("--uninstall-daemon", "uninstall-daemon"):
            res = uninstall_daemon()
            print(json.dumps(res, indent=2))
            sys.exit(0 if res.get("success") else 1)
        elif arg in ("--start-daemon", "start-daemon"):
            res = start_daemon()
            print(json.dumps(res, indent=2))
            sys.exit(0 if res.get("success") else 1)
        elif arg in ("--stop-daemon", "stop-daemon"):
            res = stop_daemon()
            print(json.dumps(res, indent=2))
            sys.exit(0 if res.get("success") else 1)
        elif arg in ("--daemon-status", "daemon-status"):
            res = {
                "installed": is_daemon_installed(),
                "active": is_daemon_active()
            }
            print(json.dumps(res, indent=2))
            sys.exit(0)

    result = get_quota_from_language_server()
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()
