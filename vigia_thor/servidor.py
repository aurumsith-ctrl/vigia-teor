"""Servidor local com suporte a transmissão em tempo real para o 2º monitor.

Uso:
    python -m vigia_thor.servidor
"""

from __future__ import annotations

import argparse
import functools
import json
import socket
import ssl
import subprocess
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
PASTA_APP = RAIZ / "docs"
PASTA_CERTS = RAIZ / ".certs"

# Estado compartilhado em memória da transmissão do celular
ESTADO_STREAM = {
    "ultimo_frame_bytes": None,
    "timestamp": 0,
    "lambendo": False,
    "probabilidade": 0.0,
    "total_alarmes": 0
}


class MonitorHandler(SimpleHTTPRequestHandler):
    """Serve arquivos e gerencia a API de streaming entre Celular e 2º Monitor."""

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.end_headers()

    def do_POST(self) -> None:
        if self.path.startswith("/api/frame"):
            tamanho = int(self.headers.get("Content-Length", 0))
            corpo = self.rfile.read(tamanho)
            try:
                dados = json.loads(corpo.decode("utf-8"))
                ESTADO_STREAM["ultimo_frame_bytes"] = dados.get("imagem") # Base64 JPEG
                ESTADO_STREAM["timestamp"] = int(time.time() * 1000)
                ESTADO_STREAM["lambendo"] = bool(dados.get("lambendo", False))
                ESTADO_STREAM["probabilidade"] = float(dados.get("probabilidade", 0.0))
                ESTADO_STREAM["total_alarmes"] = int(dados.get("totalAlarmes", 0))

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"status":"ok"}')
            except Exception as e:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(str(e).encode("utf-8"))
            return

        super().do_POST()

    def do_GET(self) -> None:
        if self.path.startswith("/api/status"):
            agora = int(time.time() * 1000)
            online = (agora - ESTADO_STREAM["timestamp"]) < 4000
            resposta = {
                "online": online,
                "frameTimestamp": ESTADO_STREAM["timestamp"],
                "lambendo": ESTADO_STREAM["lambendo"],
                "probabilidade": ESTADO_STREAM["probabilidade"],
                "totalAlarmes": ESTADO_STREAM["total_alarmes"]
            }
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(resposta).encode("utf-8"))
            return

        if self.path.startswith("/api/frame"):
            img_b64 = ESTADO_STREAM["ultimo_frame_bytes"]
            if img_b64 and "," in img_b64:
                import base64
                header, dados_b64 = img_b64.split(",", 1)
                img_bytes = base64.b64decode(dados_b64)
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.end_headers()
                self.wfile.write(img_bytes)
                return
            self.send_response(204)
            self.end_headers()
            return

        super().do_GET()


def ip_local() -> str:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
        except OSError:
            return "127.0.0.1"


def gerar_certificado(ip: str) -> tuple[Path, Path]:
    PASTA_CERTS.mkdir(exist_ok=True)
    cert, chave = PASTA_CERTS / "cert.pem", PASTA_CERTS / "chave.pem"
    if cert.exists() and chave.exists():
        return cert, chave
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(chave), "-out", str(cert), "-days", "825",
            "-subj", "/CN=vigia-thor",
            "-addext", f"subjectAltName=DNS:localhost,IP:127.0.0.1,IP:{ip}",
        ],
        check=True,
        capture_output=True,
    )
    return cert, chave


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Serve o app Vigia do Thor com transmissão para monitor.")
    parser.add_argument("--porta", type=int, default=8000, help="porta (padrão: 8000)")
    parser.add_argument("--https", action="store_true", help="usa HTTPS")
    args = parser.parse_args(argv)

    ip = ip_local()
    handler = functools.partial(MonitorHandler, directory=str(PASTA_APP))
    servidor = ThreadingHTTPServer(("0.0.0.0", args.porta), handler)

    esquema = "http"
    if args.https:
        cert, chave = gerar_certificado(ip)
        contexto = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        contexto.load_cert_chain(cert, chave)
        servidor.socket = contexto.wrap_socket(servidor.socket, server_side=True)
        esquema = "https"

    print("=" * 60)
    print("🐶 VIGIA DO THOR — SERVIDOR DE MONITORAMENTO ATIVO")
    print("=" * 60)
    print(f"📺 NO SEU 2º MONITOR (Mac):  {esquema}://localhost:{args.porta}/monitor.html")
    print(f"📱 NO IPHONE DO THOR:       {esquema}://{ip}:{args.porta}/")
    print("=" * 60)
    print("Pressione Ctrl+C para encerrar.")

    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor encerrado.")
    finally:
        servidor.server_close()


if __name__ == "__main__":
    main()
