/**
 * Alarme sonoro: toca as vozes gravadas do dono (rotacionando ou aleatório).
 * 
 * Inclui:
 * - Amplificação via Web Audio (Ganho de até 300% com compressor de dinâmica para não distorcer)
 * - Múltiplos áudios embutidos ("Pára Thor!", "Chega Thor!", "Shhh Thor!")
 * - Alternância entre os áudios a cada alarme
 */

const PAUSA_ENTRE_REPETICOES_MS = 600;
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

export const AUDIOS_PADRAO = [
  { id: 'para', nome: 'Pára Thor!', url: 'audio/para_thor.mp3' },
  { id: 'chega', nome: 'Chega Thor!', url: 'audio/chega_thor.mp3' },
  { id: 'shh', nome: 'Shhh Thor!', url: 'audio/shh_thor.mp3' }
];

export class Alarme {
  constructor() {
    this.ctx = null;
    this.compressor = null;
    this.ganhoMaster = null;
    this.buffersPadrao = []; // AudioBuffers dos 3 áudios embutidos
    this.vozPersonalizada = null; // Áudio gravado no celular se houver
    this.volume = 2.0; // Padrão turbinado (200%)
    this.repeticoes = 2;
    this.nome = 'Thor';
    this.tocando = false;
    this.indiceAtual = 0;
  }

  get temVoz() {
    return this.buffersPadrao.length > 0 || this.vozPersonalizada !== null;
  }

  /**
   * Inicializa e carrega os 3 áudios embutidos
   */
  async carregarAudiosPadrao() {
    const ctx = this._contexto();
    this.buffersPadrao = [];
    for (const item of AUDIOS_PADRAO) {
      try {
        const resp = await fetch(item.url);
        if (resp.ok) {
          const ab = await resp.arrayBuffer();
          const buffer = await new Promise((ok, err) => ctx.decodeAudioData(ab, ok, err));
          this.buffersPadrao.push(buffer);
        }
      } catch (e) {
        console.warn(`Não foi possível carregar ${item.url}:`, e);
      }
    }
  }

  /**
   * Libera o áudio. PRECISA ser chamado diretamente dentro de um toque/clique
   * do usuário (exigência do iPhone e do Android).
   */
  desbloquear() {
    try {
      // iOS 17+: toca mesmo com a chave de silencioso ligada
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch (_) { /* recurso opcional */ }

    const ctx = this._contexto();
    const silencio = ctx.createBuffer(1, 1, 22050);
    const fonte = ctx.createBufferSource();
    fonte.buffer = silencio;
    fonte.connect(ctx.destination);
    fonte.start(0);
    return ctx.state === 'running' ? Promise.resolve() : ctx.resume();
  }

  /** Define uma voz customizada adicional gravada pelo app */
  async definirVoz(arrayBuffer) {
    const ctx = this._contexto();
    this.vozPersonalizada = await new Promise((ok, erro) => ctx.decodeAudioData(arrayBuffer.slice(0), ok, erro));
  }

  removerVoz() {
    this.vozPersonalizada = null;
  }

  /**
   * Toca um áudio selecionado (se passar indice) ou o próximo da rotação
   */
  async tocar(repeticoes = this.repeticoes, indiceAudio = null) {
    if (this.tocando) return;
    this.tocando = true;
    try {
      const ctx = this._contexto();
      if (ctx.state !== 'running') {
        try { await ctx.resume(); } catch (_) { /* tenta tocar mesmo assim */ }
      }

      // Escolhe qual áudio tocar nesta chamada
      const buffer = this._obterProximoBuffer(indiceAudio);

      for (let i = 0; i < repeticoes; i++) {
        if (buffer) {
          await this._tocarBuffer(buffer);
        } else {
          await this._semVoz();
        }
        await esperar(PAUSA_ENTRE_REPETICOES_MS);
      }
    } finally {
      this.tocando = false;
    }
  }

  _obterProximoBuffer(indiceFixo = null) {
    const lista = [...this.buffersPadrao];
    if (this.vozPersonalizada) lista.push(this.vozPersonalizada);

    if (lista.length === 0) return null;

    if (indiceFixo !== null && lista[indiceFixo]) {
      return lista[indiceFixo];
    }

    const escolhido = lista[this.indiceAtual % lista.length];
    this.indiceAtual = (this.indiceAtual + 1) % lista.length;
    return escolhido;
  }

  _contexto() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();

      // DynamicsCompressor: impede distorção/estouro mesmo com volume acima de 100%
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.setValueAtTime(-14, this.ctx.currentTime);
      this.compressor.knee.setValueAtTime(10, this.ctx.currentTime);
      this.compressor.ratio.setValueAtTime(8, this.ctx.currentTime);
      this.compressor.attack.setValueAtTime(0.003, this.ctx.currentTime);
      this.compressor.release.setValueAtTime(0.15, this.ctx.currentTime);

      this.ganhoMaster = this.ctx.createGain();
      this.ganhoMaster.gain.setValueAtTime(this.volume, this.ctx.currentTime);

      // Conexão: Fonte -> Ganho -> Compressor -> Alto-falante
      this.ganhoMaster.connect(this.compressor);
      this.compressor.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  _tocarBuffer(buffer) {
    return new Promise((ok) => {
      const ctx = this._contexto();
      const fonte = ctx.createBufferSource();
      fonte.buffer = buffer;

      // Atualiza o ganho master com base no ajuste de volume
      this.ganhoMaster.gain.setValueAtTime(this.volume, ctx.currentTime);

      fonte.connect(this.ganhoMaster);
      fonte.onended = ok;
      fonte.start();
      setTimeout(ok, buffer.duration * 1000 + 500);
    });
  }

  async _semVoz() {
    await this._bipe();
    if ('speechSynthesis' in window) await falar(`${this.nome}! Não!`, 1.0);
  }

  _bipe() {
    const ctx = this._contexto();
    const t0 = ctx.currentTime;
    const pico = 0.8;
    for (const atraso of [0, 0.25]) {
      const osc = ctx.createOscillator();
      const ganho = ctx.createGain();
      osc.frequency.value = 950;
      ganho.gain.setValueAtTime(0.0001, t0 + atraso);
      ganho.gain.exponentialRampToValueAtTime(pico, t0 + atraso + 0.02);
      ganho.gain.exponentialRampToValueAtTime(0.0001, t0 + atraso + 0.18);
      osc.connect(ganho);
      ganho.connect(this.ganhoMaster);
      osc.start(t0 + atraso);
      osc.stop(t0 + atraso + 0.2);
    }
    return esperar(500);
  }
}

function falar(texto, volume) {
  return new Promise((ok) => {
    const fala = new SpeechSynthesisUtterance(texto);
    fala.lang = 'pt-BR';
    fala.volume = Math.min(1, volume);
    fala.onend = ok;
    fala.onerror = ok;
    speechSynthesis.cancel();
    speechSynthesis.speak(fala);
    setTimeout(ok, 4000);
  });
}
