"""Relatório das noites do Thor a partir do JSON exportado pelo app.

Uso:
    python -m vigia_thor.relatorio vigia-thor-2026-10-18.json
    python -m vigia_thor.relatorio historico.json --saida relatorios --incluir-testes

Gera um resumo no terminal, um arquivo ``resumo.md`` e (com matplotlib instalado)
um gráfico ``linha_do_tempo.png`` com os horários das lambidas de cada noite —
útil para mostrar ao veterinário.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

#: Se o episódio terminou até este tempo depois do último alarme, contamos que o alarme funcionou.
JANELA_EFEITO_ALARME = timedelta(seconds=60)


def ler_data(texto: str) -> datetime:
    """Converte a data ISO do app (UTC, terminando em 'Z') para o horário local."""
    return datetime.fromisoformat(texto.replace("Z", "+00:00")).astimezone()


def fmt_duracao(td: timedelta) -> str:
    segundos = round(td.total_seconds())
    if segundos < 60:
        return f"{segundos}s"
    minutos, seg = divmod(segundos, 60)
    if minutos < 60:
        return f"{minutos}min {seg:02d}s"
    horas, minutos = divmod(minutos, 60)
    return f"{horas}h {minutos:02d}min"


@dataclass
class Episodio:
    inicio: datetime
    fim: datetime
    alarmes: int

    @property
    def duracao(self) -> timedelta:
        return self.fim - self.inicio


@dataclass
class Sessao:
    id: str
    inicio: datetime
    fim: datetime
    modo_teste: bool
    episodios: list[Episodio] = field(default_factory=list)
    alarmes: list[datetime] = field(default_factory=list)
    interrupcoes: list[tuple[datetime, datetime | None]] = field(default_factory=list)

    @property
    def noite(self) -> date:
        """Data da noite: uma vigília que começa à 01:00 pertence à noite anterior."""
        return (self.inicio - timedelta(hours=12)).date()

    @property
    def duracao(self) -> timedelta:
        return self.fim - self.inicio

    @property
    def tempo_lambendo(self) -> timedelta:
        return sum((ep.duracao for ep in self.episodios), timedelta())

    @property
    def maior_episodio(self) -> Episodio | None:
        return max(self.episodios, key=lambda ep: ep.duracao, default=None)

    def episodios_que_pararam_com_alarme(self) -> int:
        """Quantos episódios com alarme terminaram logo depois do último alarme."""
        total = 0
        for ep in self.episodios:
            if not ep.alarmes:
                continue
            alarmes_no_ep = [a for a in self.alarmes if ep.inicio <= a <= ep.fim + timedelta(seconds=1)]
            if alarmes_no_ep and ep.fim - max(alarmes_no_ep) <= JANELA_EFEITO_ALARME:
                total += 1
        return total


def carregar(caminho: Path, incluir_testes: bool = False) -> list[Sessao]:
    dados = json.loads(Path(caminho).read_text(encoding="utf-8"))
    if dados.get("app") != "vigia-thor":
        raise ValueError(f"{caminho} não parece ser um histórico exportado pelo Vigia do Thor.")

    sessoes = []
    for s in dados.get("sessoes", []):
        if s.get("modoTeste") and not incluir_testes:
            continue
        sessoes.append(
            Sessao(
                id=s["id"],
                inicio=ler_data(s["inicio"]),
                fim=ler_data(s["fim"]),
                modo_teste=bool(s.get("modoTeste")),
                episodios=[
                    Episodio(ler_data(e["inicio"]), ler_data(e["fim"]), int(e.get("alarmes", 0)))
                    for e in s.get("episodios", [])
                ],
                alarmes=[ler_data(a) for a in s.get("alarmes", [])],
                interrupcoes=[
                    (ler_data(i["inicio"]), ler_data(i["fim"]) if i.get("fim") else None)
                    for i in s.get("interrupcoes", [])
                ],
            )
        )
    return sorted(sessoes, key=lambda s: s.inicio)


def resumo_texto(sessoes: list[Sessao], nome: str = "Thor") -> str:
    if not sessoes:
        return "Nenhuma vigília encontrada no arquivo."

    linhas = [f"# Relatório de lambedura — {nome}", ""]
    for s in sessoes:
        titulo = f"## Noite de {s.noite:%d/%m/%Y} ({s.inicio:%H:%M} → {s.fim:%H:%M})"
        linhas.append(titulo + (" — TESTE" if s.modo_teste else ""))
        linhas.append(f"- Tempo vigiado: {fmt_duracao(s.duracao)}")
        linhas.append(f"- Episódios de lambida: {len(s.episodios)}")
        linhas.append(f"- Tempo total lambendo: {fmt_duracao(s.tempo_lambendo)}")
        if s.maior_episodio:
            ep = s.maior_episodio
            linhas.append(f"- Maior episódio: {fmt_duracao(ep.duracao)} (às {ep.inicio:%H:%M})")
        linhas.append(f"- Alarmes disparados: {len(s.alarmes)}")
        com_alarme = sum(1 for ep in s.episodios if ep.alarmes)
        if com_alarme:
            parou = s.episodios_que_pararam_com_alarme()
            linhas.append(f"- Parou logo após o alarme: {parou} de {com_alarme} episódio(s) com alarme")
        if s.interrupcoes:
            linhas.append(f"- ⚠️ App saiu da tela {len(s.interrupcoes)} vez(es) (vigília pausada nesses períodos)")
        linhas.append("")

    total_lambendo = sum((s.tempo_lambendo for s in sessoes), timedelta())
    total_vigiado = sum((s.duracao for s in sessoes), timedelta())
    linhas.append("## Total")
    linhas.append(f"- Noites: {len(sessoes)}")
    linhas.append(f"- Tempo vigiado: {fmt_duracao(total_vigiado)}")
    linhas.append(f"- Tempo lambendo: {fmt_duracao(total_lambendo)}")
    linhas.append(f"- Alarmes: {sum(len(s.alarmes) for s in sessoes)}")
    return "\n".join(linhas)


def gerar_grafico(sessoes: list[Sessao], destino: Path) -> Path | None:
    """Linha do tempo: uma faixa por noite, com as lambidas em laranja e alarmes em vermelho."""
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.dates as mdates
        import matplotlib.pyplot as plt
    except ImportError:
        return None
    if not sessoes:
        return None

    referencia = date(2000, 1, 1)

    def alinhar(dt: datetime, noite: date) -> datetime:
        """Coloca todas as noites no mesmo eixo de horário (18h → 12h do dia seguinte)."""
        return dt.replace(tzinfo=None) + (referencia - noite)

    fig, ax = plt.subplots(figsize=(11, 1.2 + 0.6 * len(sessoes)))
    for linha, s in enumerate(sessoes):
        y = len(sessoes) - 1 - linha
        ini, fim = alinhar(s.inicio, s.noite), alinhar(s.fim, s.noite)
        ax.broken_barh([(mdates.date2num(ini), mdates.date2num(fim) - mdates.date2num(ini))],
                       (y - 0.3, 0.6), facecolors="#e5e7eb")
        barras = [
            (mdates.date2num(alinhar(ep.inicio, s.noite)),
             max(ep.duracao.total_seconds(), 20) / 86400)  # mínimo visível de 20 s
            for ep in s.episodios
        ]
        ax.broken_barh(barras, (y - 0.3, 0.6), facecolors="#f59e0b")
        ax.plot([mdates.date2num(alinhar(a, s.noite)) for a in s.alarmes], [y] * len(s.alarmes),
                "v", color="#dc2626", markersize=6)

    ax.set_yticks(range(len(sessoes)))
    ax.set_yticklabels([f"{s.noite:%d/%m}" for s in reversed(sessoes)])
    ax.xaxis.set_major_locator(mdates.HourLocator())
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M"))
    ax.set_title("Lambidas por noite (laranja = lambendo, ▼ = alarme)")
    ax.grid(axis="x", alpha=0.3)
    fig.tight_layout()

    destino.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(destino, dpi=150)
    plt.close(fig)
    return destino


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Relatório das noites do Thor.")
    parser.add_argument("arquivo", type=Path, help="JSON exportado pelo app (aba Histórico)")
    parser.add_argument("--saida", type=Path, default=Path("relatorios"), help="pasta de saída")
    parser.add_argument("--incluir-testes", action="store_true", help="inclui vigílias em modo teste")
    parser.add_argument("--sem-grafico", action="store_true", help="não gera o PNG")
    args = parser.parse_args(argv)

    try:
        sessoes = carregar(args.arquivo, incluir_testes=args.incluir_testes)
    except (OSError, ValueError, KeyError) as erro:
        print(f"Erro: {erro}", file=sys.stderr)
        return 1

    texto = resumo_texto(sessoes)
    print(texto)

    args.saida.mkdir(parents=True, exist_ok=True)
    (args.saida / "resumo.md").write_text(texto + "\n", encoding="utf-8")
    print(f"\n📝 Resumo salvo em {args.saida / 'resumo.md'}")

    if not args.sem_grafico:
        grafico = gerar_grafico(sessoes, args.saida / "linha_do_tempo.png")
        if grafico:
            print(f"📈 Gráfico salvo em {grafico}")
        elif sessoes:
            print("(Instale o matplotlib para gerar o gráfico: pip install -r requirements.txt)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
