"""SellPoint ওয়েবহুক যাচাই — Python 3 (শুধু স্ট্যান্ডার্ড লাইব্রেরি)

Flask-এ ব্যবহার:
    raw = request.get_data()          # JSON পার্স করার আগের হুবহু বডি
    ok, reason = verify_signature(raw, request.headers.get("X-DinGet-Signature"), SECRET)
"""
import hashlib
import hmac
import re
import time

TOLERANCE_SEC = 300  # ৫ মিনিটের বেশি পুরনো/ভবিষ্যতের কল বাতিল — replay ঠেকাতে


def verify_signature(raw_body, header, secret, now_sec=None, tolerance_sec=TOLERANCE_SEC):
    """raw_body: bytes বা str, header: X-DinGet-Signature-এর মান, secret: admin panel-এর Signing secret.
    ফেরত: (True, None) অথবা (False, কারণ)"""
    if not secret:
        return False, "no_secret"
    now_sec = int(time.time()) if now_sec is None else now_sec

    parts = {}
    for piece in str(header or "").split(","):
        if "=" in piece:
            k, v = piece.split("=", 1)
            parts[k.strip()] = v.strip()
    t, v1 = parts.get("t", ""), parts.get("v1", "")
    if not re.fullmatch(r"\d+", t) or not re.fullmatch(r"[0-9a-fA-F]{64}", v1):
        return False, "malformed_header"

    if abs(now_sec - int(t)) > tolerance_sec:
        return False, "stale_timestamp"

    body = raw_body.decode("utf-8") if isinstance(raw_body, (bytes, bytearray)) else raw_body
    expected = hmac.new(secret.encode("utf-8"), f"{t}.{body}".encode("utf-8"), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(expected, v1.lower()):
        return False, "bad_signature"
    return True, None
