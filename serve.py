#!/usr/bin/env python3
"""인생샷 카메라 실행 서버.

폰 브라우저는 https 주소에서만 카메라를 열어 주므로, 같은 와이파이의 폰에서
접속할 수 있게 이 Mac에서 자체 서명 인증서로 https 서버를 띄운다.

  python3 serve.py              # 폰 접속용 https (기본 포트 8443)
  python3 serve.py --http 5178  # 이 Mac에서만 확인할 때 (http://localhost:5178)
"""
import argparse
import http.server
import os
import socket
import ssl
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
CERT_DIR = os.path.join(ROOT, ".cert")


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".wasm": "application/wasm",
        ".webmanifest": "application/manifest+json",
        ".task": "application/octet-stream",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # 코드를 고치면 폰에서 바로 반영되게 한다. 모델 파일은 크므로 캐시를 허용한다.
        if self.path.startswith("/vendor/"):
            self.send_header("Cache-Control", "public, max-age=86400")
        else:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        # 인증서·서버 파일은 내려주지 않는다.
        first = self.path.lstrip("/").split("/")[0].split("?")[0]
        if first.startswith(".") or first in ("serve.py",) or first.endswith(".command"):
            self.send_error(404)
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        pass


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def ensure_cert(ip):
    os.makedirs(CERT_DIR, exist_ok=True)
    cert = os.path.join(CERT_DIR, "cert.pem")
    key = os.path.join(CERT_DIR, "key.pem")
    mark = os.path.join(CERT_DIR, "ip.txt")
    current = open(mark).read().strip() if os.path.exists(mark) else None
    if not (os.path.exists(cert) and os.path.exists(key)) or current != (ip or ""):
        san = "subjectAltName=DNS:localhost,IP:127.0.0.1" + (f",IP:{ip}" if ip else "")
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
             "-keyout", key, "-out", cert, "-subj", "/CN=insaengshot-camera", "-addext", san],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        os.chmod(key, 0o600)
        with open(mark, "w") as f:
            f.write(ip or "")
    return cert, key


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--http", type=int, metavar="PORT", help="이 Mac에서만 여는 http 서버")
    ap.add_argument("--port", type=int, default=8443)
    args = ap.parse_args()

    if args.http:
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", args.http), Handler)
        print(f"http://localhost:{args.http}", flush=True)
    else:
        ip = lan_ip()
        cert, key = ensure_cert(ip)
        srv = http.server.ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
        print("인생샷 카메라가 켜졌습니다. 폰을 이 Mac과 같은 와이파이에 연결하고 아래 주소를 여세요.\n")
        print(f"   https://{ip or 'localhost'}:{args.port}\n")
        print("처음 열 때 '연결이 비공개가 아닙니다' 경고가 나오면")
        print("  아이폰 Safari: 세부사항 보기 → 이 웹 사이트 방문")
        print("  안드로이드 Chrome: 고급 → 안전하지 않음으로 이동")
        print("을 누르면 됩니다. (이 Mac이 직접 만든 인증서라서 나오는 경고입니다)\n")
        print("끄려면 이 창에서 Ctrl+C", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
