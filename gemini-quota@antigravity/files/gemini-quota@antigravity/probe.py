#!/usr/bin/env python3
"""
probe.py - Gemini Quota Probe for Cinnamon Applet
Discovers local Antigravity language server / agy process and retrieves
the 5-hour rolling limit and weekly quota for Gemini models.
"""

import sys
import os
import re
import json
import ssl
import subprocess
import urllib.request
from datetime import datetime, timezone

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

def get_quota_from_language_server():
    # Discover language_server or agy process
    target_pid = None
    csrf_token = None

    try:
        # Check /proc directly for fast and silent lookup without external binaries
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
                            target_pid = int(entry)
                            csrf_token = m_token.group(1)
                            break
            except (IOError, PermissionError, ProcessLookupError):
                continue
    except Exception:
        pass

    # Fallback to pgrep if proc inspection did not locate it
    if not target_pid or not csrf_token:
        try:
            pgrep = subprocess.run(["pgrep", "-a", "language_server"], capture_output=True, text=True, timeout=2.0)
            for line in pgrep.stdout.strip().split("\n"):
                if "language_server" in line and "--csrf_token" in line:
                    parts = line.strip().split()
                    if parts:
                        target_pid = int(parts[0])
                        m_token = re.search(r"--csrf_token\s+([a-zA-Z0-9-]+)", line)
                        if m_token:
                            csrf_token = m_token.group(1)
                            break
        except Exception:
            pass

    if not target_pid or not csrf_token:
        return {
            "success": False,
            "error": "Antigravity language server is not running.",
            "hint": "Open Antigravity IDE or run the agy CLI."
        }

    # Discover listening TCP ports for target_pid
    ports = []
    # Fast lookup via /proc/net/tcp and /proc/net/tcp6
    # or using ss
    try:
        ss_out = subprocess.run(["ss", "-tlnp"], capture_output=True, text=True, timeout=2.0)
        for row in ss_out.stdout.split("\n"):
            if f"pid={target_pid}" in row:
                m_port = re.search(r":(\d+)\s+", row)
                if m_port:
                    ports.append(int(m_port.group(1)))
    except Exception:
        pass

    if not ports:
        try:
            lsof_out = subprocess.run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", str(target_pid)], capture_output=True, text=True, timeout=2.0)
            for row in lsof_out.stdout.split("\n"):
                m_port = re.search(r":(\d+)\s+\(LISTEN\)", row)
                if m_port:
                    ports.append(int(m_port.group(1)))
        except Exception:
            pass

    ports = list(dict.fromkeys(ports))
    if not ports:
        return {
            "success": False,
            "error": f"No listening ports found for language server (PID {target_pid})."
        }

    # Query the local RPC endpoint
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
                        return {
                            "success": False,
                            "error": "Gemini quota group not found in response.",
                            "raw": raw_json
                        }

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

                    return {
                        "success": True,
                        "source": "local_language_server",
                        "port": port,
                        "pid": target_pid,
                        "timestamp": int(now_utc.timestamp()),
                        "gemini": {
                            "five_hour": quota_5h or make_bucket(),
                            "weekly": quota_weekly or make_bucket()
                        }
                    }
        except Exception:
            continue

    return {
        "success": False,
        "error": "Failed to connect to local language server RPC."
    }

if __name__ == "__main__":
    result = get_quota_from_language_server()
    print(json.dumps(result, indent=2))
