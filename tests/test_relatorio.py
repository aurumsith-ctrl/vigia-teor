import json
from datetime import timedelta

import pytest

from vigia_thor import relatorio

HISTORICO = {
    "app": "vigia-thor",
    "versao": 1,
    "cachorro": "Thor",
    "exportadoEm": "2026-10-18T09:00:00.000Z",
    "sessoes": [
        {
            "id": "1",
            "inicio": "2026-10-18T01:00:00.000Z",
            "fim": "2026-10-18T09:00:00.000Z",
            "modoTeste": False,
            "episodios": [
                # Parou 20 s depois do alarme -> conta como "alarme funcionou".
                {"inicio": "2026-10-18T03:00:00.000Z", "fim": "2026-10-18T03:00:30.000Z", "alarmes": 1},
                # Continuou 5 min depois do alarme -> não conta.
                {"inicio": "2026-10-18T05:00:00.000Z", "fim": "2026-10-18T05:05:10.000Z", "alarmes": 1},
                {"inicio": "2026-10-18T06:00:00.000Z", "fim": "2026-10-18T06:00:03.000Z", "alarmes": 0},
            ],
            "alarmes": ["2026-10-18T03:00:10.000Z", "2026-10-18T05:00:10.000Z"],
            "interrupcoes": [{"inicio": "2026-10-18T07:00:00.000Z", "fim": "2026-10-18T07:01:00.000Z"}],
        },
        {
            "id": "2",
            "inicio": "2026-10-17T20:00:00.000Z",
            "fim": "2026-10-17T20:10:00.000Z",
            "modoTeste": True,
            "episodios": [],
            "alarmes": [],
            "interrupcoes": [],
        },
    ],
}


@pytest.fixture
def arquivo(tmp_path):
    caminho = tmp_path / "historico.json"
    caminho.write_text(json.dumps(HISTORICO), encoding="utf-8")
    return caminho


def test_ignora_sessoes_de_teste_por_padrao(arquivo):
    assert [s.id for s in relatorio.carregar(arquivo)] == ["1"]
    assert [s.id for s in relatorio.carregar(arquivo, incluir_testes=True)] == ["2", "1"]


def test_metricas_da_sessao(arquivo):
    (sessao,) = relatorio.carregar(arquivo)
    assert sessao.duracao == timedelta(hours=8)
    assert len(sessao.episodios) == 3
    assert sessao.tempo_lambendo == timedelta(seconds=30 + 310 + 3)
    assert sessao.maior_episodio.duracao == timedelta(seconds=310)
    assert sessao.episodios_que_pararam_com_alarme() == 1


def test_resumo_texto(arquivo):
    texto = relatorio.resumo_texto(relatorio.carregar(arquivo))
    assert "Episódios de lambida: 3" in texto
    assert "Parou logo após o alarme: 1 de 2" in texto
    assert "App saiu da tela 1 vez" in texto


def test_rejeita_arquivo_de_outro_app(tmp_path):
    caminho = tmp_path / "outro.json"
    caminho.write_text(json.dumps({"app": "outro"}), encoding="utf-8")
    with pytest.raises(ValueError):
        relatorio.carregar(caminho)


@pytest.mark.parametrize(
    ("segundos", "esperado"),
    [(45, "45s"), (125, "2min 05s"), (3 * 3600 + 7 * 60, "3h 07min")],
)
def test_fmt_duracao(segundos, esperado):
    assert relatorio.fmt_duracao(timedelta(seconds=segundos)) == esperado


def test_main_gera_arquivos(arquivo, tmp_path):
    saida = tmp_path / "saida"
    assert relatorio.main([str(arquivo), "--saida", str(saida), "--sem-grafico"]) == 0
    assert (saida / "resumo.md").exists()


def test_grafico(arquivo, tmp_path):
    pytest.importorskip("matplotlib")
    destino = relatorio.gerar_grafico(relatorio.carregar(arquivo), tmp_path / "grafico.png")
    assert destino is not None and destino.stat().st_size > 0
