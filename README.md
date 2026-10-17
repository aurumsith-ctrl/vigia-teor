# 🐶 Vigia do Thor

App que usa a câmera de um celular para **vigiar o Thor à noite**. Quando ele fica
**lambendo a pata** (calo de apoio) por alguns segundos seguidos, o celular toca
**a sua voz gravada** chamando o nome dele.

- Roda **100% no celular**, no navegador (Android ou iPhone). Nenhuma imagem sai do aparelho.
- A detecção é **treinada com vídeos do próprio Thor**, no próprio app.
- Guarda um **histórico das noites**, que pode ser analisado no Mac com Python
  (resumo + gráfico para mostrar ao veterinário).

> ⚠️ O app ajuda, mas **não substitui o veterinário** nem o colar elizabetano/inflável.
> Calo de apoio aberto infecciona com facilidade.

---

## Estrutura

```
vigia-thor/
├── docs/                    ← o app (publicado no GitHub Pages)
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── app.js           ← interface e fluxo principal
│       ├── detector.js      ← IA: MobileNet + classificador KNN
│       ├── vigia.js         ← lógica: suavização, episódios, quando alarmar
│       ├── alarme.js        ← toca a voz gravada (ou bipe + voz sintetizada)
│       └── storage.js       ← salva treino, voz e histórico no celular
├── vigia_thor/              ← ferramentas Python (rodam no Mac)
│   ├── relatorio.py         ← relatório das noites a partir do JSON exportado
│   └── servidor.py          ← servidor local para testes
├── tests/                   ← testes (pytest)
└── requirements.txt
```

> **Por que o app em si não é Python?** O que roda dentro do navegador do celular
> (câmera, IA e som) precisa ser JavaScript. O Python fica com as ferramentas do Mac:
> o relatório e o servidor de testes.

### Como a detecção funciona

1. A cada ~0,3 s um quadro da câmera passa pela **MobileNet** (rede pré-treinada), que
   gera um "resumo numérico" da imagem.
2. Um classificador **KNN** compara esse resumo com os exemplos gravados de
   "lambendo" e "normal" e dá uma probabilidade.
3. O [`vigia.js`](docs/js/vigia.js) suaviza a probabilidade, tolera pausas curtas e
   só dispara o alarme depois de **N segundos lambendo**. Depois espera um intervalo
   mínimo antes de poder tocar de novo.

---

## 1. Rodar no Mac (Python)

```bash
cd vigia-thor
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

pytest                                 # roda os testes
python -m vigia_thor.servidor          # abre o app em http://localhost:8000 (webcam do Mac)
```

No **PyCharm**: *File → Open* na pasta `vigia-thor` e selecione `.venv` como interpretador.
No **Cursor**: abra a pasta; ele detecta a `.venv` automaticamente.

## 2. Publicar no GitHub Pages (para usar no celular)

1. Crie um repositório no GitHub (por exemplo `vigia-thor`) e envie o projeto.
2. No repositório: **Settings → Pages → Build and deployment**
   - *Source*: **Deploy from a branch**
   - *Branch*: **main** e pasta **/docs** → **Save**
3. Em ~1 minuto o app fica em `https://SEU-USUARIO.github.io/vigia-thor/`.

> Alternativa sem GitHub: `python -m vigia_thor.servidor --https` e abra no celular o
> endereço exibido (o celular mostra um aviso de certificado que precisa ser aceito).

## 3. Usar no celular

1. Abra o endereço do GitHub Pages no **Chrome (Android)** ou no **Safari (iPhone)**.
   Dica: use "Adicionar à tela de início" para abrir como app.
2. **Ligar câmera** e permitir o acesso.
3. Aba **Voz**: grave "Thor! Não!" e toque em **Ouvir** para conferir o volume.
4. Aba **Treinar** (com o celular já na posição da noite):
   - **Gravar: lambendo** quando ele estiver lambendo (10 s por toque, repita algumas vezes).
   - **Gravar: normal** com ele dormindo, deitado, com a cabeça na pata, se mexendo
     e até com a cama vazia. Quanto mais variado, menos alarme falso.
   - Mínimo de 20 de cada; o ideal é 150 ou mais. Treine também com a luz da noite.
   - Ative **Mostrar detecção ao vivo** e confira se a barra só fica vermelha quando ele lambe.
5. Aba **Vigiar**: na primeira noite, use o **Modo teste** (registra, mas não toca)
   para conferir no histórico se ele acerta. Depois desligue o modo teste.
6. **Iniciar vigília** → **Modo noite** (tela preta). Toque duas vezes para sair.

### Checklist da noite
- Celular **na tomada**, apontado para a cama do Thor.
- Uma **luz fraca** acesa: no escuro total a câmera não enxerga.
- Volume alto, **sem silencioso e sem "não perturbe"**.
- iPhone: *Ajustes → Tela e Brilho → Bloqueio Automático → Nunca*.
- O app tem que ficar **aberto na tela**. Se outro app for aberto, a vigília pausa
  (fica registrado no histórico).

### Ajustes úteis
| Ajuste | Quando mexer |
|---|---|
| Certeza mínima | Tocando sem ele lamber → aumente. Ele lambe e não toca → diminua. |
| Lambendo por quanto tempo até tocar | Padrão 5 s. Diminua se quiser reação mais rápida. |
| Espera mínima entre alarmes | Padrão 30 s. Se ele continuar lambendo, o alarme repete. |
| Análises por segundo | Celular velho esquentando ou travando → diminua. |

## 4. Relatório das noites (Mac)

Na aba **Histórico**, toque em **Exportar histórico (JSON)** e mande o arquivo para o
Mac (AirDrop, e-mail, WhatsApp…). Depois:

```bash
source .venv/bin/activate
python -m vigia_thor.relatorio ~/Downloads/vigia-thor-2026-10-18.json
```

Gera em `relatorios/`:
- `resumo.md`: por noite, quantas lambidas, tempo lambendo, maior episódio, quantos
  alarmes e **quantas vezes ele parou logo depois do alarme**;
- `linha_do_tempo.png`: os horários das lambidas em cada noite.

## Limitações
- Precisa de internet ao abrir o app (para baixar a IA). Depois de carregado, a análise é local.
- No escuro total a detecção não funciona; deixe uma luz fraca acesa.
- Se o Thor dormir fora do enquadramento, o app não vê.
- Com o tempo ele pode se acostumar com o alarme. Por isso o colar continua sendo
  a proteção principal enquanto a ferida cicatriza.
