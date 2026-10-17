/**
 * Lógica da vigília: transforma a probabilidade de "lambendo" (0 a 1), que chega
 * algumas vezes por segundo, em episódios de lambida e disparos de alarme.
 *
 * Não depende do navegador, então pode ser testada isoladamente.
 */

/** Peso da leitura nova na média móvel (0–1). Maior = reage mais rápido, porém com mais ruído. */
const ALFA_SUAVIZACAO = 0.35;
/** Pausas menores que isso (ex.: ele levanta a cabeça um instante) não zeram a contagem. */
const TOLERANCIA_PAUSA_MS = 3000;
/** Tempo mínimo lambendo para contar como um episódio no histórico. */
const MIN_EPISODIO_MS = 2000;

export const CONFIG_PADRAO = {
  /** Média móvel mínima (0–1) para considerar que ele está lambendo. */
  limiar: 0.75,
  /** Segundos lambendo (quase) sem parar até disparar o alarme. */
  segundosParaAlarme: 5,
  /** Espera mínima entre dois alarmes, em segundos. */
  intervaloEntreAlarmes: 30,
  /** Segundos sem lamber para considerar que o episódio terminou. */
  segundosFimEpisodio: 10,
};

export class Vigia {
  /**
   * @param {Partial<typeof CONFIG_PADRAO>} config
   * @param {{onAlarme?: (t:number)=>void, onEpisodioInicio?: (t:number)=>void,
   *          onEpisodioFim?: (ep:{inicio:number, fim:number, alarmes:number})=>void}} eventos
   */
  constructor(config = {}, eventos = {}) {
    this.config = { ...CONFIG_PADRAO, ...config };
    this.eventos = eventos;
    this.media = null;
    this.inicioLambida = null;
    this.ultimoLambendo = null;
    this.ultimoAlarme = null;
    this.episodio = null;
  }

  /**
   * Recebe uma nova leitura do detector.
   * @param {number} probabilidade chance (0–1) de ele estar lambendo neste quadro
   * @param {number} agora timestamp em ms
   */
  atualizar(probabilidade, agora = Date.now()) {
    this.media = this.media === null
      ? probabilidade
      : this.media + ALFA_SUAVIZACAO * (probabilidade - this.media);

    const lambendo = this.media >= this.config.limiar;
    if (lambendo) this._lambendo(agora);
    else this._parado(agora);

    return {
      media: this.media,
      lambendo,
      segundosLambendo: this.inicioLambida === null ? 0 : (agora - this.inicioLambida) / 1000,
      episodioAtivo: this.episodio !== null,
    };
  }

  /** Encerra a vigília, fechando um episódio que esteja em aberto. */
  finalizar(agora = Date.now()) {
    if (this.episodio) this._fecharEpisodio(this.ultimoLambendo ?? agora);
    this.inicioLambida = null;
  }

  _lambendo(agora) {
    this.ultimoLambendo = agora;
    if (this.inicioLambida === null) this.inicioLambida = agora;

    const duracao = agora - this.inicioLambida;
    if (!this.episodio && duracao >= MIN_EPISODIO_MS) this._abrirEpisodio();

    const podeAlarmar = this.ultimoAlarme === null
      || agora - this.ultimoAlarme >= this.config.intervaloEntreAlarmes * 1000;

    if (duracao >= this.config.segundosParaAlarme * 1000 && podeAlarmar) {
      if (!this.episodio) this._abrirEpisodio();
      this.ultimoAlarme = agora;
      this.episodio.alarmes += 1;
      this.eventos.onAlarme?.(agora);
    }
  }

  _parado(agora) {
    const pausa = this.ultimoLambendo === null ? Infinity : agora - this.ultimoLambendo;
    if (this.inicioLambida !== null && pausa > TOLERANCIA_PAUSA_MS) this.inicioLambida = null;
    if (this.episodio && pausa >= this.config.segundosFimEpisodio * 1000) {
      this._fecharEpisodio(this.ultimoLambendo);
    }
  }

  _abrirEpisodio() {
    this.episodio = { inicio: this.inicioLambida, alarmes: 0 };
    this.eventos.onEpisodioInicio?.(this.episodio.inicio);
  }

  _fecharEpisodio(fim) {
    const episodio = { ...this.episodio, fim };
    this.episodio = null;
    this.eventos.onEpisodioFim?.(episodio);
  }
}
