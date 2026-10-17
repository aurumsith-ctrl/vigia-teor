/**
 * Alarme sonoro: toca a voz gravada do dono. Se não houver gravação,
 * usa bipes + voz sintetizada ("Thor! Não!").
 *
 * Usa Web Audio porque, depois de "desbloqueado" por um toque na tela,
 * ele consegue tocar sozinho mais tarde (o navegador bloqueia som automático).
 */

const PAUSA_ENTRE_REPETICOES_MS = 700;

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

export class Alarme {
  constructor() {
    this.ctx = null;
    this.voz = null;
    this.volume = 1;
    this.repeticoes = 2;
    this.nome = 'Thor';
    this.tocando = false;
  }

  get temVoz() {
    return this.voz !== null;
  }

  /**
   * Libera o áudio. PRECISA ser chamado diretamente dentro de um toque/clique
   * do usuário (exigência do iPhone e do Android).
   */
  desbloquear() {
    try {
      // iOS 17+: toca mesmo com a chave de silencioso ligada.
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

  /** Define a voz a partir do áudio gravado (ArrayBuffer). */
  async definirVoz(arrayBuffer) {
    const ctx = this._contexto();
    this.voz = await new Promise((ok, erro) => ctx.decodeAudioData(arrayBuffer.slice(0), ok, erro));
  }

  removerVoz() {
    this.voz = null;
  }

  async tocar(repeticoes = this.repeticoes) {
    if (this.tocando) return;
    this.tocando = true;
    try {
      const ctx = this._contexto();
      if (ctx.state !== 'running') {
        try { await ctx.resume(); } catch (_) { /* tenta tocar mesmo assim */ }
      }
      for (let i = 0; i < repeticoes; i++) {
        if (this.voz) await this._tocarBuffer(this.voz);
        else await this._semVoz();
        await esperar(PAUSA_ENTRE_REPETICOES_MS);
      }
    } finally {
      this.tocando = false;
    }
  }

  _contexto() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    return this.ctx;
  }

  _tocarBuffer(buffer) {
    return new Promise((ok) => {
      const fonte = this.ctx.createBufferSource();
      const ganho = this.ctx.createGain();
      fonte.buffer = buffer;
      ganho.gain.value = this.volume;
      fonte.connect(ganho);
      ganho.connect(this.ctx.destination);
      fonte.onended = ok;
      fonte.start();
      setTimeout(ok, buffer.duration * 1000 + 500); // garantia, caso onended não dispare
    });
  }

  async _semVoz() {
    await this._bipe();
    if ('speechSynthesis' in window) await falar(`${this.nome}! Não!`, this.volume);
  }

  _bipe() {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const pico = Math.max(0.001, 0.6 * this.volume);
    for (const atraso of [0, 0.25]) {
      const osc = ctx.createOscillator();
      const ganho = ctx.createGain();
      osc.frequency.value = 880;
      ganho.gain.setValueAtTime(0.0001, t0 + atraso);
      ganho.gain.exponentialRampToValueAtTime(pico, t0 + atraso + 0.02);
      ganho.gain.exponentialRampToValueAtTime(0.0001, t0 + atraso + 0.18);
      osc.connect(ganho);
      ganho.connect(ctx.destination);
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
