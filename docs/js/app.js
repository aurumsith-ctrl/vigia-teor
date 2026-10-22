/**
 * Vigia do Thor — app principal.
 * Liga a câmera, treina o detector, vigia de noite e toca o alarme.
 */
import * as db from './storage.js';
import { Detector, CLASSES, MIN_EXEMPLOS, MAX_EXEMPLOS } from './detector.js';
import { Vigia } from './vigia.js';
import { Alarme } from './alarme.js';

const NOME_CACHORRO = 'Thor';
const DURACAO_GRAVACAO_S = 10;
const INTERVALO_CAPTURA_MS = 150;
const DURACAO_MAX_VOZ_MS = 5000;
const INTERVALO_SALVAR_SESSAO_MS = 60_000;

const AJUSTES_PADRAO = {
  limiar: 75,
  segundosParaAlarme: 5,
  intervaloEntreAlarmes: 30,
  repeticoes: 2,
  volume: 100,
  analisesPorSegundo: 3,
  camera: 'environment',
};

const CAMPOS_AJUSTES = [
  { chave: 'limiar', rotulo: 'Certeza mínima', min: 50, max: 95, passo: 5, sufixo: '%',
    ajuda: 'Aumente se tocar sem ele estar lambendo; diminua se ele lamber e o app não perceber.' },
  { chave: 'segundosParaAlarme', rotulo: 'Lambendo por quanto tempo até tocar', min: 2, max: 30, passo: 1, sufixo: ' s',
    ajuda: 'Evita alarme por uma lambidinha rápida.' },
  { chave: 'intervaloEntreAlarmes', rotulo: 'Espera mínima entre alarmes', min: 10, max: 120, passo: 5, sufixo: ' s',
    ajuda: 'Se ele continuar lambendo, o alarme repete depois desse tempo.' },
  { chave: 'repeticoes', rotulo: 'Repetições da voz', min: 1, max: 3, passo: 1, sufixo: 'x' },
  { chave: 'volume', rotulo: 'Volume do alarme', min: 20, max: 150, passo: 10, sufixo: '%' },
  { chave: 'analisesPorSegundo', rotulo: 'Análises por segundo', min: 1, max: 6, passo: 1, sufixo: '',
    ajuda: 'Celular velho esquentando ou travando? Diminua.' },
];

const $ = (seletor) => document.querySelector(seletor);
const video = $('#video');
const detector = new Detector();
const alarme = new Alarme();
alarme.nome = NOME_CACHORRO;

const estado = {
  ajustes: { ...AJUSTES_PADRAO },
  stream: null,
  modeloCarregado: false,
  erroModelo: null,
  vigiando: false,
  modoTeste: false,
  sessao: null,
  vigia: null,
  loopAtivo: false,
  previa: false,
  gravandoClasse: null,
  timerTreino: null,
  timerSalvar: null,
  wakeLock: null,
  gravadorVoz: null,
};

// ---------------------------------------------------------------- utilidades

const iso = (t = Date.now()) => new Date(t).toISOString();

function fmtDuracao(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min}min`;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}min`;
}

const fmtHora = (texto) => new Date(texto).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fmtData = (texto) => new Date(texto).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });

function mostrarAviso(elemento, texto) {
  elemento.textContent = texto || '';
  elemento.hidden = !texto;
}

// ---------------------------------------------------------------- câmera

function cameraOk() {
  const trilha = estado.stream?.getVideoTracks()[0];
  return Boolean(trilha && trilha.readyState === 'live' && video.readyState >= 2);
}

function pararCamera() {
  estado.stream?.getTracks().forEach((t) => t.stop());
  estado.stream = null;
}

async function ligarCamera() {
  const erro = $('#camera-erro');
  mostrarAviso(erro, '');
  if (!navigator.mediaDevices?.getUserMedia) {
    mostrarAviso(erro, 'Este navegador não liberou a câmera. Abra o app pelo endereço https:// (GitHub Pages).');
    return false;
  }
  pararCamera();
  try {
    estado.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: estado.ajustes.camera }, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    video.srcObject = estado.stream;
    await video.play();
    $('#camera-aviso').hidden = true;
    estado.stream.getVideoTracks()[0].addEventListener('ended', () => {
      $('#camera-aviso').hidden = false;
    });
    iniciarTransmissorWebRTC();
    // Se já houver um monitor conectado aguardando vídeo, liga pra ele imediatamente
    for (const conn of conexoesMonitor) {
      if (conn.open && conn.peer) peerCelular?.call(conn.peer, estado.stream);
    }
    garantirLoop();
    return true;
  } catch (e) {
    $('#camera-aviso').hidden = false;
    mostrarAviso(erro, `Não consegui acessar a câmera (${e.name}). Confira a permissão do navegador.`);
    return false;
  }
}

// ---------------------------------------------------------------- tela ligada

async function manterTelaLigada() {
  if (!('wakeLock' in navigator) || estado.wakeLock) return;
  try {
    estado.wakeLock = await navigator.wakeLock.request('screen');
    estado.wakeLock.addEventListener('release', () => { estado.wakeLock = null; });
  } catch (_) {
    // Sem suporte/permissão: o usuário precisa desativar o bloqueio automático manualmente.
  }
}

async function liberarTela() {
  try { await estado.wakeLock?.release(); } catch (_) { /* já liberado */ }
  estado.wakeLock = null;
}

// ---------------------------------------------------------------- modelo e treino

async function carregarModelo() {
  try {
    await detector.carregar();
    estado.modeloCarregado = true;
    const salvo = await db.carregar('treino');
    if (salvo && !detector.importar(salvo)) {
      mostrarAviso($('#status-treino'), 'O treino salvo era de outra versão do app. Grave os exemplos de novo.');
    }
  } catch (e) {
    console.error(e);
    estado.erroModelo = 'Falha ao carregar a IA. Confira a internet e recarregue a página.';
  }
  atualizarStatus();
  atualizarContagens();
  garantirLoop();
}

async function salvarTreino() {
  if (!estado.modeloCarregado) return;
  const c = detector.contagem();
  if (c[CLASSES.LAMBENDO] + c[CLASSES.NORMAL] === 0) await db.apagar('treino');
  else await db.salvar('treino', detector.exportar());
}

function alternarGravacaoClasse(classe) {
  if (estado.gravandoClasse === classe) {
    pararGravacaoClasse();
    return;
  }
  if (estado.gravandoClasse) pararGravacaoClasse();

  const status = $('#status-treino');
  if (!estado.modeloCarregado) return mostrarAviso(status, 'Aguarde a IA terminar de carregar…');
  if (estado.vigiando) return mostrarAviso(status, 'Pare a vigília antes de treinar.');
  if (!cameraOk()) return mostrarAviso(status, 'Ligue a câmera primeiro.');
  mostrarAviso(status, '');

  estado.gravandoClasse = classe;
  const botao = document.querySelector(`[data-classe="${classe}"]`);
  botao.classList.add('gravando');
  const inicio = Date.now();

  const passo = () => {
    if (estado.gravandoClasse !== classe) return;
    const restante = DURACAO_GRAVACAO_S - (Date.now() - inicio) / 1000;
    if (restante <= 0) return pararGravacaoClasse();
    if (video.readyState >= 2 && !detector.adicionarExemplo(video, classe)) {
      mostrarAviso(status, `Limite de ${MAX_EXEMPLOS} exemplos atingido para essa classe.`);
      return pararGravacaoClasse();
    }
    botao.textContent = `⏺ Gravando… ${Math.ceil(restante)}s (toque para parar)`;
    atualizarContagens();
    estado.timerTreino = setTimeout(passo, INTERVALO_CAPTURA_MS);
  };
  passo();
}

async function pararGravacaoClasse() {
  clearTimeout(estado.timerTreino);
  estado.gravandoClasse = null;
  $('#btn-gravar-lambendo').textContent = '👅 Gravar: lambendo';
  $('#btn-gravar-normal').textContent = '😴 Gravar: normal';
  document.querySelectorAll('[data-classe]').forEach((b) => b.classList.remove('gravando'));
  atualizarContagens();
  atualizarStatus();
  await salvarTreino();
  garantirLoop();
}

async function limparClasse(classe) {
  const nome = classe === CLASSES.LAMBENDO ? '“lambendo”' : '“normal”';
  if (!confirm(`Apagar todos os exemplos de ${nome}?`)) return;
  detector.limparClasse(classe);
  atualizarContagens();
  atualizarStatus();
  await salvarTreino();
}

// ---------------------------------------------------------------- análise contínua e transmissão

function precisaLoop() {
  return cameraOk();
}

function garantirLoop() {
  if (estado.loopAtivo || !precisaLoop()) return;
  estado.loopAtivo = true;
  ciclo();
}

// --- WebRTC P2P (Funciona mesmo em HTTPS sem bloqueio de Mixed Content) ---
const PEER_ID_CELULAR = 'vigia-thor-cam-eduardo-9921';
let peerCelular = null;
let conexoesMonitor = [];

function atualizarPillRemoto(texto, classe = '') {
  const el = $('#status-remoto');
  if (!el) return;
  el.textContent = texto;
  el.className = 'pill ' + classe;
}

function iniciarTransmissorWebRTC() {
  if (typeof Peer === 'undefined' || peerCelular) return;
  try {
    peerCelular = new Peer(PEER_ID_CELULAR);

    peerCelular.on('open', () => {
      atualizarPillRemoto('📺 Mac: Pronto', '');
    });

    peerCelular.on('connection', (conn) => {
      conexoesMonitor.push(conn);
      atualizarPillRemoto('📺 Mac: Conectado', 'ok');

      conn.on('data', (msg) => {
        if (msg && msg.acao === 'chamar-monitor' && msg.monitorId && estado.stream) {
          peerCelular.call(msg.monitorId, estado.stream);
        }
      });

      conn.on('close', () => {
        conexoesMonitor = conexoesMonitor.filter((c) => c !== conn);
        if (conexoesMonitor.length === 0) atualizarPillRemoto('📺 Mac: Pronto', '');
      });
    });

    peerCelular.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        // Outra aba já está usando o ID; tenta reconectar depois
        setTimeout(() => { peerCelular = null; iniciarTransmissorWebRTC(); }, 5000);
      }
    });
  } catch (e) {
    console.warn('Erro ao iniciar PeerJS:', e);
  }
}

let canvasStream = null;
let ultimoEnvioStream = 0;

function enviarQuadroParaMonitor(probabilidade, lambendo) {
  const agora = Date.now();
  if (agora - ultimoEnvioStream < 350 || !video.videoWidth) return;
  ultimoEnvioStream = agora;

  const totalAlarmes = estado.sessao ? estado.sessao.alarmes.length : 0;

  // 1) Envia telemetria via WebRTC para todos os monitores abertos
  for (const conn of conexoesMonitor) {
    if (conn.open) {
      conn.send({
        tipo: 'telemetria',
        probabilidade,
        lambendo,
        vigiando: estado.vigiando,
        totalAlarmes
      });
    }
  }

  // 2) Envia quadro JPEG para o servidor Python local (192.168.0.116:8000)
  if (!canvasStream) {
    canvasStream = document.createElement('canvas');
  }
  canvasStream.width = 320;
  canvasStream.height = 240;
  const ctx = canvasStream.getContext('2d');
  ctx.drawImage(video, 0, 0, 320, 240);
  const imagemB64 = canvasStream.toDataURL('image/jpeg', 0.5);

  const endpoint = window.location.origin.includes('localhost') || window.location.origin.includes('192.168.') 
    ? '/api/frame' 
    : 'http://192.168.0.116:8000/api/frame';

  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imagem: imagemB64,
      probabilidade,
      lambendo,
      vigiando: estado.vigiando,
      totalAlarmes
    })
  }).then((r) => {
    if (r.ok && conexoesMonitor.length === 0) atualizarPillRemoto('📺 Mac: Online', 'ok');
  }).catch(() => {});
}

async function ciclo() {
  if (!precisaLoop()) {
    estado.loopAtivo = false;
    atualizarMedidor(null);
    return;
  }
  const t0 = performance.now();
  try {
    let p = 0;
    let lambendo = false;

    if (cameraOk() && !estado.gravandoClasse) {
      const podeAnalisarIA = (estado.vigiando || estado.previa) && detector.pronto();
      if (podeAnalisarIA) {
        p = await detector.probabilidadeLambendo(video);
        if (estado.vigiando) {
          const r = estado.vigia.atualizar(p);
          lambendo = r.lambendo;
          atualizarPainel(r);
        } else {
          atualizarMedidor(p);
        }
      }
      // Transmite SEMPRE que a câmera estiver ligada, mesmo sem treino!
      enviarQuadroParaMonitor(p, lambendo);
    }
  } catch (e) {
    console.error('Erro na análise:', e);
  }
  const intervalo = 1000 / estado.ajustes.analisesPorSegundo;
  setTimeout(ciclo, Math.max(30, intervalo - (performance.now() - t0)));
}

// ---------------------------------------------------------------- vigília

function configVigia() {
  const a = estado.ajustes;
  return {
    limiar: a.limiar / 100,
    segundosParaAlarme: a.segundosParaAlarme,
    intervaloEntreAlarmes: a.intervaloEntreAlarmes,
  };
}

async function salvarSessao() {
  if (!estado.sessao) return;
  try { await db.salvarSessao(estado.sessao); } catch (e) { console.error(e); }
}

async function iniciarVigilia() {
  // O áudio precisa ser liberado antes de qualquer outro "await" (exigência do iPhone).
  const audioLiberado = alarme.desbloquear();
  const aviso = $('#aviso-vigiar');
  mostrarAviso(aviso, '');

  if (!detector.pronto()) {
    mostrarAviso(aviso, `Treine primeiro: pelo menos ${MIN_EXEMPLOS} exemplos de “lambendo” e de “normal”.`);
    trocarAba('treinar');
    return;
  }
  if (!cameraOk() && !(await ligarCamera())) {
    mostrarAviso(aviso, 'Não foi possível ligar a câmera.');
    return;
  }
  try { await audioLiberado; } catch (_) { /* tenta seguir mesmo assim */ }

  estado.modoTeste = $('#modo-teste').checked;
  estado.sessao = {
    id: String(Date.now()),
    inicio: iso(),
    fim: iso(),
    modoTeste: estado.modoTeste,
    ajustes: { ...estado.ajustes },
    episodios: [],
    alarmes: [],
    interrupcoes: [],
  };
  estado.vigia = new Vigia(configVigia(), {
    onAlarme: aoAlarmar,
    onEpisodioFim: aoFimEpisodio,
  });
  estado.vigiando = true;

  await manterTelaLigada();
  if (!('wakeLock' in navigator)) {
    mostrarAviso(aviso, 'Desative o bloqueio automático da tela, senão a vigília para quando a tela apagar.');
  }
  await salvarSessao();
  estado.timerSalvar = setInterval(() => {
    estado.sessao.fim = iso();
    salvarSessao();
  }, INTERVALO_SALVAR_SESSAO_MS);

  $('#btn-iniciar').hidden = true;
  $('#btn-parar').hidden = false;
  $('#btn-noite').disabled = false;
  $('#modo-teste').disabled = true;
  atualizarStatus();
  atualizarPainel({ media: 0, lambendo: false, segundosLambendo: 0 });
  garantirLoop();
}

async function pararVigilia() {
  if (!estado.vigiando) return;
  estado.vigiando = false;
  estado.vigia.finalizar();
  clearInterval(estado.timerSalvar);
  estado.sessao.fim = iso();
  await salvarSessao();
  await liberarTela();

  $('#btn-iniciar').hidden = false;
  $('#btn-parar').hidden = true;
  $('#btn-noite').disabled = true;
  $('#modo-teste').disabled = false;
  sairModoNoite();

  const s = estado.sessao;
  $('#estado-texto').textContent = 'Parado';
  $('#estado-detalhe').textContent =
    `Última vigília: ${s.episodios.length} lambida(s), ${s.alarmes.length} alarme(s).`;
  $('.estado').classList.remove('vigiando', 'lambendo');
  atualizarStatus();
  renderHistorico();
}

function aoAlarmar(t) {
  estado.sessao.alarmes.push(iso(t));
  if (!estado.modoTeste) alarme.tocar();
  salvarSessao();
}

function aoFimEpisodio(ep) {
  estado.sessao.episodios.push({ inicio: iso(ep.inicio), fim: iso(ep.fim), alarmes: ep.alarmes });
  salvarSessao();
}

function tempoLambendoSessao(agora = Date.now()) {
  const fechados = estado.sessao.episodios
    .reduce((soma, ep) => soma + (new Date(ep.fim) - new Date(ep.inicio)), 0);
  const aberto = estado.vigia?.episodio ? agora - estado.vigia.episodio.inicio : 0;
  return fechados + aberto;
}

// ---------------------------------------------------------------- modo noite

let ultimoToqueNoite = 0;

function entrarModoNoite() {
  $('#modo-noite').hidden = false;
}

function sairModoNoite() {
  $('#modo-noite').hidden = true;
}

function toqueModoNoite() {
  const agora = Date.now();
  if (agora - ultimoToqueNoite < 450) sairModoNoite();
  ultimoToqueNoite = agora;
}

// ---------------------------------------------------------------- voz

async function carregarVoz() {
  const salva = await db.carregar('voz');
  if (!salva) return;
  try {
    await alarme.definirVoz(salva.dados);
    atualizarBotoesVoz(`✅ Voz gravada em ${new Date(salva.gravadaEm).toLocaleString('pt-BR')}.`);
  } catch (_) {
    atualizarBotoesVoz('Não consegui ler a gravação salva. Grave de novo.');
  }
}

function atualizarBotoesVoz(texto) {
  $('#btn-ouvir-voz').disabled = false;
  $('#btn-apagar-voz').disabled = !alarme.temVoz;
  if (texto) $('#status-voz').textContent = texto;
}

async function gravarVoz() {
  const botao = $('#btn-gravar-voz');
  const status = $('#status-voz');

  if (estado.gravadorVoz) {
    estado.gravadorVoz.stop();
    return;
  }
  if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
    status.textContent = 'Este navegador não grava áudio. O alarme vai usar bipes + voz sintetizada.';
    return;
  }

  let microfone;
  try {
    microfone = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    status.textContent = `Erro no microfone (${e.name || e.message}): Verifique as permissões de microfone do navegador.`;
    return;
  }

  // Descobre formatos compatíveis com o navegador (iOS Safari prefere audio/mp4, Android prefere webm)
  const formatosCandidatos = [
    'audio/mp4',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg',
    'audio/wav'
  ];
  let tipoSuportado = '';
  if (typeof MediaRecorder.isTypeSupported === 'function') {
    tipoSuportado = formatosCandidatos.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  let gravador;
  try {
    gravador = tipoSuportado ? new MediaRecorder(microfone, { mimeType: tipoSuportado }) : new MediaRecorder(microfone);
  } catch (errGravador) {
    try {
      gravador = new MediaRecorder(microfone);
    } catch (e2) {
      status.textContent = `Erro ao iniciar gravador: ${e2.message}`;
      microfone.getTracks().forEach((t) => t.stop());
      return;
    }
  }

  const pedacos = [];
  let limite = null;

  gravador.ondataavailable = (e) => { if (e.data && e.data.size > 0) pedacos.push(e.data); };
  gravador.onstop = async () => {
    clearTimeout(limite);
    microfone.getTracks().forEach((t) => t.stop());
    estado.gravadorVoz = null;
    botao.classList.remove('gravando');
    botao.textContent = '🎙️ Gravar de novo';

    try {
      const mimeFinal = gravador.mimeType || tipoSuportado || 'audio/mp4';
      const blob = new Blob(pedacos, { type: mimeFinal });
      const dados = await blob.arrayBuffer();
      await alarme.definirVoz(dados);
      await db.salvar('voz', { dados, tipo: mimeFinal, gravadaEm: iso() });
      atualizarBotoesVoz('✅ Voz salva com sucesso! Toque em “Ouvir” para testar.');
    } catch (errDecodificacao) {
      console.error(errDecodificacao);
      status.textContent = `Erro ao salvar áudio: ${errDecodificacao.message || 'formato incompatível'}. Tente gravar novamente.`;
    }
  };

  try {
    // Grava emitindo pedaços a cada 200ms para compatibilidade máxima
    gravador.start(200);
  } catch (_) {
    gravador.start();
  }
  estado.gravadorVoz = gravador;
  botao.classList.add('gravando');
  botao.textContent = '⏹ Parar gravação (máx. 5 s)';
  status.textContent = `Fale agora: “${NOME_CACHORRO}! Não!”`;
  limite = setTimeout(() => { if (gravador.state === 'recording') gravador.stop(); }, DURACAO_MAX_VOZ_MS);
}

async function ouvirVoz(indice = null) {
  const liberado = alarme.desbloquear();
  try { await liberado; } catch (_) { /* tenta tocar mesmo assim */ }
  alarme.tocar(1, indice);
}

async function apagarVoz() {
  if (!confirm('Apagar sua gravação extra?')) return;
  alarme.removerVoz();
  await db.apagar('voz');
  $('#btn-apagar-voz').disabled = true;
  $('#status-voz').textContent = 'Gravação extra apagada. Os 3 áudios embutidos continuam ativos.';
}

// ---------------------------------------------------------------- histórico

function resumoSessao(s) {
  const tempoLambendo = s.episodios.reduce((soma, ep) => soma + (new Date(ep.fim) - new Date(ep.inicio)), 0);
  return {
    duracao: new Date(s.fim) - new Date(s.inicio),
    tempoLambendo,
    episodios: s.episodios.length,
    alarmes: s.alarmes.length,
  };
}

async function renderHistorico() {
  const lista = $('#lista-historico');
  const sessoes = (await db.listarSessoes()).sort((a, b) => b.inicio.localeCompare(a.inicio));
  lista.replaceChildren();

  if (!sessoes.length) {
    const vazio = document.createElement('p');
    vazio.className = 'sub';
    vazio.textContent = 'Nenhuma vigília registrada ainda.';
    lista.append(vazio);
    return;
  }

  for (const s of sessoes) {
    const r = resumoSessao(s);
    const card = document.createElement('div');
    card.className = 'card sessao';

    const titulo = document.createElement('h3');
    titulo.textContent = `${fmtData(s.inicio)} · ${fmtHora(s.inicio)} → ${fmtHora(s.fim)}`;
    if (s.modoTeste) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = ' (teste)';
      titulo.append(tag);
    }

    const linha = document.createElement('div');
    linha.className = 'linha';
    for (const texto of [
      `⏱ ${fmtDuracao(r.duracao)} vigiando`,
      `👅 ${r.episodios} lambida(s)`,
      `🔊 ${r.alarmes} alarme(s)`,
      `⌛ ${fmtDuracao(r.tempoLambendo)} lambendo`,
    ]) {
      const item = document.createElement('span');
      item.textContent = texto;
      linha.append(item);
    }
    card.append(titulo, linha);
    lista.append(card);
  }
}

async function exportarHistorico() {
  const sessoes = await db.listarSessoes();
  const dados = {
    app: 'vigia-thor',
    versao: 1,
    cachorro: NOME_CACHORRO,
    exportadoEm: iso(),
    sessoes,
  };
  const nome = `vigia-thor-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(dados, null, 2)], { type: 'application/json' });
  const arquivo = new File([blob], nome, { type: 'application/json' });

  // No celular abre o menu de compartilhar (AirDrop, WhatsApp, e-mail…).
  if (navigator.canShare?.({ files: [arquivo] })) {
    try {
      await navigator.share({ files: [arquivo], title: `Histórico do ${NOME_CACHORRO}` });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = nome;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

async function apagarHistorico() {
  if (!confirm('Apagar todo o histórico de vigílias?')) return;
  await db.apagarSessoes();
  renderHistorico();
}

// ---------------------------------------------------------------- ajustes

function aplicarAjustes() {
  alarme.volume = estado.ajustes.volume / 100;
  alarme.repeticoes = estado.ajustes.repeticoes;
  $('#medidor-limiar').style.left = `${estado.ajustes.limiar}%`;
  if (estado.vigia) estado.vigia.config = { ...estado.vigia.config, ...configVigia() };
}

function renderAjustes() {
  const container = $('#campos-ajustes');
  container.replaceChildren();
  for (const campo of CAMPOS_AJUSTES) {
    const div = document.createElement('div');
    div.className = 'campo';
    const id = `aj-${campo.chave}`;
    const valor = estado.ajustes[campo.chave];

    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = campo.rotulo;
    const saida = document.createElement('output');
    saida.textContent = `${valor}${campo.sufixo}`;
    label.append(saida);

    const input = document.createElement('input');
    Object.assign(input, { type: 'range', id, min: campo.min, max: campo.max, step: campo.passo, value: valor });
    input.addEventListener('input', () => {
      estado.ajustes[campo.chave] = Number(input.value);
      saida.textContent = `${input.value}${campo.sufixo}`;
      aplicarAjustes();
    });
    input.addEventListener('change', () => db.salvar('ajustes', estado.ajustes));

    div.append(label, input);
    if (campo.ajuda) {
      const ajuda = document.createElement('p');
      ajuda.className = 'sub';
      ajuda.textContent = campo.ajuda;
      div.append(ajuda);
    }
    container.append(div);
  }
  $('#aj-camera').value = estado.ajustes.camera;
}

async function restaurarAjustes() {
  estado.ajustes = { ...AJUSTES_PADRAO };
  await db.salvar('ajustes', estado.ajustes);
  renderAjustes();
  aplicarAjustes();
}

// ---------------------------------------------------------------- interface

function trocarAba(nome) {
  document.querySelectorAll('.abas button').forEach((b) => b.classList.toggle('ativa', b.dataset.aba === nome));
  document.querySelectorAll('.aba').forEach((s) => s.classList.toggle('ativa', s.id === `aba-${nome}`));
  if (nome === 'historico') renderHistorico();
}

function atualizarStatus() {
  const pill = $('#status-modelo');
  pill.className = 'pill';
  if (estado.erroModelo) {
    pill.textContent = 'Erro na IA';
    pill.classList.add('erro');
    mostrarAviso($('#aviso-vigiar'), estado.erroModelo);
  } else if (!estado.modeloCarregado) {
    pill.textContent = 'Carregando IA…';
  } else if (!detector.pronto()) {
    pill.textContent = 'Precisa treinar';
    pill.classList.add('aviso');
  } else if (estado.vigiando) {
    pill.textContent = estado.modoTeste ? 'Vigiando (teste)' : 'Vigiando 👁';
    pill.classList.add('ok');
  } else {
    pill.textContent = 'Pronto ✅';
    pill.classList.add('ok');
  }
}

function atualizarContagens() {
  const c = detector.contagem();
  $('#cont-lambendo').textContent = c[CLASSES.LAMBENDO];
  $('#cont-normal').textContent = c[CLASSES.NORMAL];
  const faltam = [CLASSES.LAMBENDO, CLASSES.NORMAL]
    .filter((k) => c[k] < MIN_EXEMPLOS)
    .map((k) => `${MIN_EXEMPLOS - c[k]} de “${k}”`);
  if (!estado.gravandoClasse && estado.modeloCarregado) {
    $('#status-treino').hidden = false;
    $('#status-treino').textContent = faltam.length
      ? `Faltam pelo menos ${faltam.join(' e ')}.`
      : '✅ Treino suficiente para começar. Mais exemplos = mais precisão.';
  }
}

function atualizarMedidor(p) {
  const barra = $('#medidor-barra');
  const pct = p === null ? 0 : Math.round(p * 100);
  barra.style.width = `${pct}%`;
  barra.classList.toggle('alto', pct >= estado.ajustes.limiar);
}

function atualizarPainel(r) {
  atualizarMedidor(r.media);
  const card = $('.estado');
  card.classList.add('vigiando');
  card.classList.toggle('lambendo', r.lambendo);

  const s = estado.sessao;
  const episodios = s.episodios.length + (estado.vigia.episodio ? 1 : 0);
  $('#num-episodios').textContent = episodios;
  $('#num-alarmes').textContent = s.alarmes.length;
  $('#num-tempo').textContent = fmtDuracao(tempoLambendoSessao());

  if (r.lambendo) {
    $('#estado-texto').textContent = `👅 Lambendo há ${Math.round(r.segundosLambendo)}s`;
    $('#estado-detalhe').textContent = estado.modoTeste
      ? 'Modo teste: o alarme não toca.'
      : `O alarme toca após ${estado.ajustes.segundosParaAlarme}s seguidos.`;
  } else {
    $('#estado-texto').textContent = '😴 Tranquilo';
    $('#estado-detalhe').textContent = `Vigiando desde ${fmtHora(s.inicio)}.`;
  }

  const noite = $('#modo-noite');
  noite.classList.toggle('lambendo', r.lambendo);
  $('#noite-texto').textContent = `${r.lambendo ? 'Lambendo' : 'Vigiando'} · ${s.alarmes.length} alarme(s)`;
}

function ligarEventos() {
  document.querySelectorAll('.abas button').forEach((b) => b.addEventListener('click', () => trocarAba(b.dataset.aba)));

  $('#btn-camera').addEventListener('click', ligarCamera);
  $('#btn-iniciar').addEventListener('click', iniciarVigilia);
  $('#btn-parar').addEventListener('click', pararVigilia);
  $('#btn-noite').addEventListener('click', entrarModoNoite);
  $('#modo-noite').addEventListener('click', toqueModoNoite);
  $('#btn-testar-alarme').addEventListener('click', ouvirVoz);

  document.querySelectorAll('[data-classe]').forEach((b) =>
    b.addEventListener('click', () => alternarGravacaoClasse(b.dataset.classe)));
  document.querySelectorAll('[data-limpar]').forEach((b) =>
    b.addEventListener('click', () => limparClasse(b.dataset.limpar)));
  $('#testar-deteccao').addEventListener('change', (e) => {
    estado.previa = e.target.checked;
    garantirLoop();
  });

  $('#btn-gravar-voz').addEventListener('click', gravarVoz);
  $('#btn-ouvir-voz').addEventListener('click', () => ouvirVoz());
  $('#btn-apagar-voz').addEventListener('click', apagarVoz);

  $('#btn-teste-para')?.addEventListener('click', () => ouvirVoz(0));
  $('#btn-teste-chega')?.addEventListener('click', () => ouvirVoz(1));
  $('#btn-teste-shh')?.addEventListener('click', () => ouvirVoz(2));

  $('#btn-exportar').addEventListener('click', exportarHistorico);
  $('#btn-apagar-historico').addEventListener('click', apagarHistorico);

  $('#aj-camera').addEventListener('change', async (e) => {
    estado.ajustes.camera = e.target.value;
    await db.salvar('ajustes', estado.ajustes);
    if (estado.stream) ligarCamera();
  });
  $('#btn-restaurar-ajustes').addEventListener('click', restaurarAjustes);

  // Se o app for para segundo plano, a câmera para: registra a interrupção e retoma ao voltar.
  document.addEventListener('visibilitychange', async () => {
    if (!estado.vigiando) return;
    const interrupcoes = estado.sessao.interrupcoes;
    if (document.visibilityState === 'hidden') {
      interrupcoes.push({ inicio: iso() });
      salvarSessao();
      return;
    }
    const ultima = interrupcoes[interrupcoes.length - 1];
    if (ultima && !ultima.fim) ultima.fim = iso();
    await manterTelaLigada();
    if (!cameraOk()) await ligarCamera();
    salvarSessao();
    garantirLoop();
  });

  window.addEventListener('beforeunload', (e) => {
    if (!estado.vigiando) return;
    estado.sessao.fim = iso();
    salvarSessao();
    e.preventDefault();
    e.returnValue = '';
  });
}

async function iniciar() {
  ligarEventos();
  iniciarTransmissorWebRTC();
  const ajustesSalvos = await db.carregar('ajustes');
  estado.ajustes = { ...AJUSTES_PADRAO, ...(ajustesSalvos || {}) };
  renderAjustes();
  aplicarAjustes();
  atualizarStatus();
  await alarme.carregarAudiosPadrao();
  carregarVoz();
  renderHistorico();
  carregarModelo();
}

iniciar();
