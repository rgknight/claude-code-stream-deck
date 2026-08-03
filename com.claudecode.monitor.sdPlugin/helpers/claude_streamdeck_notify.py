#!/usr/bin/env python3
"""Claude Code hook helper for the Stream Deck monitor plugin.

Claude Code invokes this script for configured hook events with a JSON payload
on stdin. The script minimizes the payload to session metadata (no prompt or
response text), POSTs it to the plugin's loopback notify bridge, and spools it
locally when the bridge is unavailable. It must always exit 0 quickly so hooks
never slow down or block a Claude Code session.
"""

import json
import os
import secrets
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone

MAX_STDIN_BYTES = 1024 * 1024
MAX_EVENT_BYTES = 256 * 1024
MAX_MESSAGE_CHARS = 1024
SEND_TIMEOUT_SECONDS = 0.75

EVENT_TYPES = {
    "SessionStart": "session-start",
    "UserPromptSubmit": "prompt-submit",
    "Notification": "notification",
    "PostToolUse": "post-tool",
    "Stop": "stop",
    "StopFailure": "stop-failure",
    "SessionEnd": "session-end",
}

# High-volume, low-value once stale; do not spool when the bridge is down.
SPOOL_SKIP_TYPES = {"post-tool"}


def data_directory():
    override = os.environ.get("CLAUDE_STREAMDECK_DATA_DIR")
    if override:
        return override
    home = os.path.expanduser("~")
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
        return os.path.join(base, "ClaudeStreamDeck")
    if sys.platform == "darwin":
        return os.path.join(home, "Library", "Application Support", "ClaudeStreamDeck")
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(home, ".local", "state")
    return os.path.join(base, "claude-streamdeck")


def spool_directory():
    return os.path.join(data_directory(), "spool")


def clean_text(value, limit):
    if not isinstance(value, str) or not value or "\0" in value:
        return None
    return value[:limit]


def minimize(payload):
    if not isinstance(payload, dict):
        return None
    event_type = EVENT_TYPES.get(payload.get("hook_event_name"))
    if not event_type:
        return None
    session_id = clean_text(payload.get("session_id"), 200)
    cwd = clean_text(payload.get("cwd"), 32768)
    if not session_id or not cwd or not os.path.isabs(cwd):
        return None
    event = {
        "version": 2,
        "type": event_type,
        "sessionId": session_id,
        "cwd": cwd,
        "observedAt": datetime.now(timezone.utc).isoformat(),
    }
    notification_type = clean_text(payload.get("notification_type"), 64)
    if notification_type:
        event["notificationType"] = notification_type
    if event_type == "notification":
        message = clean_text(payload.get("message"), MAX_MESSAGE_CHARS)
        if message:
            event["message"] = message
    source = clean_text(payload.get("source"), 100)
    if source:
        event["source"] = source
    reason = clean_text(payload.get("reason"), 100)
    if reason:
        event["reason"] = reason
    return event


def send(event):
    endpoint_path = os.path.join(data_directory(), "notify-endpoint.json")
    try:
        with open(endpoint_path, "r", encoding="utf-8") as handle:
            endpoint = json.load(handle)
        host = endpoint.get("host")
        port = endpoint.get("port")
        token = endpoint.get("token")
        if host != "127.0.0.1":
            return False
        if not isinstance(port, int) or port < 1 or port > 65535:
            return False
        if not isinstance(token, str) or len(token) < 40 or len(token) > 200:
            return False
        body = json.dumps(event).encode("utf-8")
        if len(body) > MAX_EVENT_BYTES:
            return False
        request = urllib.request.Request(
            "http://127.0.0.1:%d/event" % port,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer %s" % token,
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=SEND_TIMEOUT_SECONDS) as response:
            return response.status == 204
    except Exception:
        return False


def spool(event):
    try:
        directory = spool_directory()
        os.makedirs(directory, mode=0o700, exist_ok=True)
        body = json.dumps(event).encode("utf-8")
        if len(body) > MAX_EVENT_BYTES:
            return
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
        final_name = "%s-%s.json" % (stamp, secrets.token_hex(8))
        descriptor, temp_path = tempfile.mkstemp(dir=directory, suffix=".tmp")
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(body)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temp_path, 0o600)
            os.replace(temp_path, os.path.join(directory, final_name))
        except Exception:
            try:
                os.unlink(temp_path)
            except OSError:
                pass
    except Exception:
        pass


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
        if not raw or len(raw) > MAX_STDIN_BYTES:
            return 0
        payload = json.loads(raw.decode("utf-8", errors="replace"))
        event = minimize(payload)
        if event is None:
            return 0
        if not send(event) and event["type"] not in SPOOL_SKIP_TYPES:
            spool(event)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
