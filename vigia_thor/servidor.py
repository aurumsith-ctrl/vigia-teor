"""Servidor local para testar o app (pasta ``docs/``) no Mac ou na rede Wi-Fi.

Uso:
    python -m vigia_thor.servidor              # http://localhost:8000 (testar no navegador do Mac)
    python -m vigia_thor.servidor --https      # https://<ip-do-mac>:8443 (testar no celular)

Observação: navegadores só liberam a câmera em ``localhost`` ou em HTTPS. No modo
``--https`` é usado um certificado autoassinado, então o celular vai mostrar um aviso
de segurança que precisa ser aceito. Para o uso no dia a dia, prefira o GitHub Pages.
"""

from __future__ import annotations

import argparse
import functools
import socket
import ssl
import subprocess
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
PASTA_APP = RAIZ / "docs"
PASTA_CERTS = RAIZ / ".certs"


class SemCacheHandler(SimpleHTTPRequestHandler):
    """Serve arquivos sem cache, para as alterações aparecerem ao recarregar."""

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def ip_local() -> str:
    """Descobre o IP do Mac na rede local (nenhum pacote é enviado de fato)."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
        except OSError:
            return "127.0.0.1"


def gerar_certificado(ip: str) -> tuple[Path, Path]:
    """Gera (uma vez) um certificado autoassinado usando o ``openssl`` do macOS."""
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
    parser = argparse.ArgumentParser(description="Serve o app Vigia do Thor localmente.")
    parser.add_argument("--porta", type=int, help="porta (padrão: 8000, ou 8443 com --https)")
    parser.add_argument("--https", action="store_true", help="usa HTTPS para testar no celular")
    args = parser.parse_args(argv)

    porta = args.porta or (8443 if args.https else 8000)
    ip = ip_local()
    handler = functools.partial(SemCacheHandler, directory=str(PASTA_APP))
    servidor = ThreadingHTTPServer(("0.0.0.0", porta), handler)

    esquema = "http"
    if args.https:
        cert, chave = gerar_certificado(ip)
        contexto = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        contexto.load_cert_chain(cert, chave)
        servidor.socket = contexto.wrap_socket(servidor.socket, server_side=True)
        esquema = "https"

    print(f"🐶 Vigia do Thor servindo {PASTA_APP}")
    print(f"   No Mac:     {esquema}://localhost:{porta}")
    if args.https:
        print(f"   No celular: {esquema}://{ip}:{porta}  (aceite o aviso de certificado)")
    else:
        print("   Para abrir no celular use --https (a câmera exige HTTPS fora do localhost).")
    print("   Ctrl+C para parar.")
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor encerrado.")
    finally:
        servidor.server_close()


if __name__ == "__main__":
    main()
