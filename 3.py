#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
3.py (sửa) - Scrape từ API list của bạn + kiểm tra proxy (HTTP/HTTPS only) -> lưu gộp vn.txt cho by.js
- Loại bỏ SOCKS
- Chuẩn hóa proxy thành host:port
- Nếu proxy trả lời được HTTP hoặc HTTPS (qua proxy), sẽ ghi vào vn.txt
- Ghi thêm thông tin tóm tắt: latency và protocls passed
"""

import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading
import os
import warnings
import re
import time

# ---------- Cấu hình ----------
VN_OUTPUT = "vn.txt"
BAD_OUTPUT = "bad_vn.txt"
lock = threading.Lock()

# Tắt cảnh báo SSL khi verify=False
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

# Timeouts và thread mặc định
TIMEOUT_HTTP = 4   # giây cho request HTTP test
TIMEOUT_HTTPS = 6  # giây cho request HTTPS test (thường lâu hơn)
MAX_WORKERS = 40   # thread pool size

# ---------- Helper functions ----------
def normalize_line(line):
    """Chuyển 1 dòng proxy thành host:port hoặc return None (nếu lỗi / socks)"""
    if not line:
        return None
    s = line.strip()
    s = s.split()[0]  # drop trailing comments
    s = s.strip()

    # Loại bỏ quotes
    s = s.strip('\'"')

    # Lower-case scheme check
    l = s.lower()

    # Loại bỏ socks
    if l.startswith("socks") or "socks" in l:
        return None

    # Nếu có schema như http:// hoặc https:// -> parse lấy netloc
    m = re.match(r'^(https?://)?(.+)$', s)
    if m:
        core = m.group(2)
    else:
        core = s

    # Nếu có user:pass@host:port -> lấy phần sau @
    if "@" in core:
        core = core.split("@", 1)[1]

    # Nếu vẫn có slash (path), bỏ path
    if "/" in core:
        core = core.split("/")[0]

    # IPv6 support in basic way: if contains [ ] or multiple :
    # We'll accept anything that contains ":" and last segment numeric port
    if ":" not in core:
        return None
    parts = core.rsplit(":", 1)
    host = parts[0]
    port = parts[1]
    if not port.isdigit():
        return None
    return f"{host}:{port}"

def fetch_proxies_vn():
    """Lấy proxy raw từ API_VN, trả về set các dòng đã chuẩn hóa (host:port)"""
    all_proxies = set()
    for i, url in enumerate(API_VN, 1):
        try:
            print(f"📡 Lấy API {i}/{len(API_VN)}: {url}")
            res = requests.get(url, timeout=6)
            if res.status_code != 200:
                print(f"  ❌ Status {res.status_code}")
                continue
            text = res.text
            lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
            parsed = 0
            for ln in lines:
                norm = normalize_line(ln)
                if norm:
                    all_proxies.add(norm)
                    parsed += 1
            print(f"  ➜ Lấy được {parsed} proxy hợp lệ từ nguồn #{i}")
        except Exception as e:
            print(f"  ❌ Lỗi khi lấy nguồn #{i}: {e}")
    print(f"📥 Tổng proxy (sau chuẩn hóa, loại socks): {len(all_proxies)}")
    return list(all_proxies)

# Check bằng requests qua proxy (http proxy dùng cho cả http và https bằng dạng http://host:port)
def check_proxy(proxy_hostport, timeout_http=TIMEOUT_HTTP, timeout_https=TIMEOUT_HTTPS):
    """
    Kiểm tra proxy:
      - proxy_hostport: "host:port"
    Trả về tuple:
      (hostport, ok_bool, info_str)
    Nếu ok_bool True -> info_str có dạng "http,https lat=XXms" hoặc "http lat=XXms" hoặc "https lat=YYms"
    Nếu False -> info_str là lý do fail
    """
    hostport = proxy_hostport
    proxies = {
        "http": f"http://{hostport}",
        "https": f"http://{hostport}"
    }
    protocols = []
    latencies = []
    # Test HTTP endpoint
    t0 = time.time()
    try:
        r = requests.get("http://httpbin.org/ip", proxies=proxies, timeout=timeout_http)
        lat = int((time.time() - t0) * 1000)
        if r.status_code == 200:
            protocols.append("http")
            latencies.append(lat)
    except Exception as e:
        # không sao, thử HTTPS tiếp
        pass

    # Test HTTPS endpoint (đặt verify=False cho tránh lỗi cert qua proxy public)
    t1 = time.time()
    try:
        r = requests.get("https://httpbin.org/ip", proxies=proxies, timeout=timeout_https, verify=False)
        lat2 = int((time.time() - t1) * 1000)
        if r.status_code == 200:
            protocols.append("https")
            latencies.append(lat2)
    except Exception as e:
        pass

    if protocols:
        # chọn latency min để ghi
        latency = min(latencies) if latencies else 0
        info = f"{','.join(protocols)} lat={latency}ms"
        return (hostport, True, info)
    else:
        return (hostport, False, "no-protocol-ok")

def write_result_line(path, line):
    with lock:
        with open(path, "a") as f:
            f.write(line + "\n")

def run_check_all(proxy_list, workers=MAX_WORKERS):
    # Xóa file output nếu tồn tại
    if os.path.exists(VN_OUTPUT):
        os.remove(VN_OUTPUT)
    if os.path.exists(BAD_OUTPUT):
        os.remove(BAD_OUTPUT)

    total = len(proxy_list)
    checked = 0
    live = 0
    print(f"⚙️ Bắt đầu kiểm tra {total} proxy với {workers} luồng...")
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = { ex.submit(check_proxy, p): p for p in proxy_list }
        for fut in as_completed(futures):
            p = futures[fut]
            try:
                hostport, ok, info = fut.result()
            except Exception as e:
                hostport, ok, info = p, False, f"exception:{e}"
            checked += 1
            if ok:
                live += 1
                line = f"{hostport} # {info}"
                write_result_line(VN_OUTPUT, line)
            else:
                line = f"{hostport} # {info}"
                write_result_line(BAD_OUTPUT, line)
            # in tiến trình (same-line)
            print(f"✅ {checked}/{total} checked | Live: {live}", end="\r", flush=True)

    print()  # newline
    print(f"🔔 Hoàn tất kiểm tra. Live: {live} / {total}")
    print(f"📂 Lưu file sống: {VN_OUTPUT}")
    print(f"📂 Lưu file chết: {BAD_OUTPUT}")

# ---------- Main ----------
if __name__ == "__main__":
    print("🚀 Đang lấy danh sách proxy từ API ...")
    proxies = fetch_proxies_vn()
    if not proxies:
        print("❌ Không có proxy nào để kiểm tra. Thoát.")
        exit(1)

    # Nếu bạn muốn dùng file proxy có sẵn (proxy.txt), bạn có thể uncomment dòng sau:
    # with open("proxy.txt") as f: proxies = [normalize_line(l) for l in f if normalize_line(l)]

    # Bắt đầu check
    run_check_all(proxies, workers=MAX_WORKERS)
