#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
3.py - Lấy proxy từ API + kiểm tra sống, chỉ lưu ip:port sạch sẽ vào vn.txt
"""

import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading
import os
import warnings
import re

VN_OUTPUT = "pp.txt"
lock = threading.Lock()

warnings.filterwarnings("ignore", message="Unverified HTTPS request")

API_VN = [
    "https://openproxylist.xyz/http.txt",
    "https://openproxylist.xyz/https.txt",
    "http://36.50.134.20:3000/download/http.txt",
    "http://36.50.134.20:3000/download/vn.txt",
    "http://36.50.134.20:3000/api/proxies",
    "https://api.lumiproxy.com/web_v1/free-proxy/list?page_size=60&page=1&protocol=1&language=en-us",
    "https://api.lumiproxy.com/web_v1/free-proxy/list?page_size=60&page=1&protocol=2&speed=2&uptime=0&language=en-us",
    "http://pubproxy.com/api/proxy?limit=20&format=txt&type=http",
    "http://pubproxy.com/api/proxy?limit=20&format=txt&type=https",
    "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/all/data.txt",
]

TIMEOUT = 3
MAX_WORKERS = 80

def normalize_line(line):
    """Chuẩn hóa dòng proxy thành host:port, bỏ socks"""
    if not line:
        return None
    s = line.strip().split()[0].strip('\'"')
    l = s.lower()
    if l.startswith("socks") or "socks" in l:
        return None
    m = re.match(r'^(https?://)?(.+)$', s)
    core = m.group(2) if m else s
    if "@" in core:
        core = core.split("@", 1)[1]
    if "/" in core:
        core = core.split("/")[0]
    if ":" not in core:
        return None
    host, port = core.rsplit(":", 1)
    if not port.isdigit():
        return None
    return f"{host}:{port}"

def fetch_proxies():
    all_proxies = set()
    for i, url in enumerate(API_VN, 1):
        try:
            print(f"📡 Lấy API {i}/{len(API_VN)}: {url}")
            res = requests.get(url, timeout=6)
            if res.status_code != 200:
                continue
            for ln in res.text.splitlines():
                norm = normalize_line(ln)
                if norm:
                    all_proxies.add(norm)
        except Exception as e:
            print(f"  ❌ Lỗi khi lấy nguồn #{i}: {e}")
    print(f"📥 Tổng proxy sau lọc: {len(all_proxies)}")
    return list(all_proxies)

def check_proxy(proxy):
    proxies = {"http": f"http://{proxy}", "https": f"http://{proxy}"}
    try:
        if requests.get("http://httpbin.org/ip", proxies=proxies, timeout=TIMEOUT).status_code == 200:
            return True
    except:
        pass
    try:
        if requests.get("https://httpbin.org/ip", proxies=proxies, timeout=TIMEOUT, verify=False).status_code == 200:
            return True
    except:
        pass
    return False

def run_check_all(proxy_list):
    if os.path.exists(VN_OUTPUT):
        os.remove(VN_OUTPUT)

    total = len(proxy_list)
    checked = 0
    live = 0
    print(f"⚙️ Bắt đầu kiểm tra {total} proxy...")
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futures = {ex.submit(check_proxy, p): p for p in proxy_list}
        for fut in as_completed(futures):
            p = futures[fut]
            try:
                ok = fut.result()
            except:
                ok = False
            checked += 1
            if ok:
                live += 1
                with lock:
                    with open(VN_OUTPUT, "a") as f:
                        f.write(p + "\n")  # chỉ ip:port
            print(f"✅ {checked}/{total} | Live: {live}", end="\r", flush=True)

    print()
    print(f"🔔 Hoàn tất. Live: {live}/{total}")
    print(f"📂 Proxy sống lưu vào: {VN_OUTPUT}")

if __name__ == "__main__":
    print("🚀 Đang lấy proxy từ API...")
    proxies = fetch_proxies()
    if not proxies:
        print("❌ Không có proxy nào.")
        exit(1)
    run_check_all(proxies)
