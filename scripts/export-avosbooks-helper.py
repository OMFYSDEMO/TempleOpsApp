#!/usr/bin/env python3
"""Small helpers for scripts/export-avosbooks.sh (JSON parsing without jq)."""
import email
import json
import os
import re
import sys
import urllib.parse

cmd, args = sys.argv[1], sys.argv[2:]

if cmd == "bindings":
    d = json.load(open(os.path.join(args[0], "worker-settings.json")))
    for b in (d.get("result") or {}).get("bindings", []):
        print("binding:", b.get("type"), b.get("name"), b.get("namespace_id") or b.get("id") or b.get("bucket_name") or "")

elif cmd == "split":
    out = args[0]
    raw = open(os.path.join(out, "worker-content.raw"), "rb").read()
    hdr = open(os.path.join(out, "worker-content.headers"), errors="replace").read()
    m = re.search(r"content-type:\s*(.+)", hdr, re.I)
    ct = m.group(1).strip() if m else ""
    if ct.startswith("multipart/"):
        msg = email.message_from_bytes(b"Content-Type: " + ct.encode() + b"\r\n\r\n" + raw)
        for part in msg.walk():
            fn = part.get_filename() or part.get_param("name", header="content-disposition")
            if fn and not part.is_multipart():
                p = os.path.join(out, "src", fn.replace("/", "__"))
                open(p, "wb").write(part.get_payload(decode=True) or b"")
                print("module:", fn, os.path.getsize(p))
    else:
        open(os.path.join(out, "src", "worker.js"), "wb").write(raw)
        print("single script", len(raw), ct)

elif cmd == "namespaces":
    out = args[0]
    d = json.load(open(os.path.join(out, "kv-namespaces.json")))
    ids = {n["id"]: n["title"] for n in d.get("result", []) or []}
    try:
        s = json.load(open(os.path.join(out, "worker-settings.json")))
        for b in (s.get("result") or {}).get("bindings", []):
            if b.get("type") == "kv_namespace":
                ids.setdefault(b["namespace_id"], b["name"])
    except Exception:
        pass
    print(" ".join(f"{k}:{v}" for k, v in ids.items()))

elif cmd == "page":
    d = json.load(open(args[0]))
    with open(args[1], "a") as f:
        for k in d.get("result", []) or []:
            f.write(json.dumps(k) + "\n")
    print((d.get("result_info") or {}).get("cursor") or "")

elif cmd == "keyname":
    print(json.loads(args[0])["name"])

elif cmd == "quote":
    print(urllib.parse.quote(args[0], safe=""))
