/* global tf, mobilenet, knnClassifier */
/**
 * Detector "lambendo x normal".
 *
 * Usa a MobileNet (rede pré-treinada) só para extrair características de cada
 * quadro da câmera, e um classificador KNN que aprende com os exemplos que você
 * grava do próprio Thor. Tudo roda no celular; nenhuma imagem sai do aparelho.
 */

export const CLASSES = { LAMBENDO: 'lambendo', NORMAL: 'normal' };
/** Mínimo de exemplos de cada classe para começar a detectar. */
export const MIN_EXEMPLOS = 20;
/** Limite por classe, para não pesar demais em celular antigo. */
export const MAX_EXEMPLOS = 500;

/** Versão leve da MobileNet: boa o bastante e roda bem em aparelho antigo. */
const MODELO = { version: 2, alpha: 0.5 };
/** Quantos vizinhos o KNN consulta para decidir. */
const K = 10;

export class Detector {
  constructor() {
    this.modelo = null;
    this.classificador = null;
  }

  get carregado() {
    return this.modelo !== null;
  }

  async carregar() {
    await tf.ready();
    this.modelo = await mobilenet.load(MODELO);
    this.classificador = knnClassifier.create();
  }

  contagem() {
    const c = this.classificador ? this.classificador.getClassExampleCount() : {};
    return {
      [CLASSES.LAMBENDO]: c[CLASSES.LAMBENDO] || 0,
      [CLASSES.NORMAL]: c[CLASSES.NORMAL] || 0,
    };
  }

  /**
   * Pronto para vigiar:
   * - Ou tem >= 20 exemplos de ambas as classes (modo supervisionado clássico)
   * - Ou tem >= 20 exemplos só de "normal" (modo detecção de anomalia: qualquer postura muito diferente do normal acusa lambida!)
   */
  pronto() {
    if (!this.carregado) return false;
    const c = this.contagem();
    return c[CLASSES.NORMAL] >= MIN_EXEMPLOS;
  }

  /** Adiciona o quadro atual do vídeo como exemplo da classe. Retorna false se atingiu o limite. */
  adicionarExemplo(video, classe) {
    if (this.contagem()[classe] >= MAX_EXEMPLOS) return false;
    const embedding = this._embedding(video);
    this.classificador.addExample(embedding, classe);
    embedding.dispose();
    return true;
  }

  /**
   * Probabilidade (0–1) de o quadro atual ser "lambendo".
   * Se só houver exemplos de "normal" gravados, calcula a distância de cosseno para os exemplos normais
   * (quanto mais diferente da postura normal de descanso, maior a probabilidade!).
   */
  async probabilidadeLambendo(video) {
    const c = this.contagem();
    const embedding = this._embedding(video);
    try {
      // Caso 1: Tem exemplos de "lambendo" e de "normal" -> KNN tradicional
      if (c[CLASSES.LAMBENDO] > 0 && c[CLASSES.NORMAL] > 0) {
        const resultado = await this.classificador.predictClass(embedding, K);
        return resultado.confidences[CLASSES.LAMBENDO] ?? 0;
      }

      // Caso 2: Só tem exemplos de "normal" -> Detecção de Anomalia por similaridade de cosseno
      const dataset = this.classificador.getClassifierDataset();
      const normais = dataset[CLASSES.NORMAL];
      if (!normais) return 0;

      return tf.tidy(() => {
        const embFlat = embedding.reshape([1, -1]);
        const embNorm = tf.div(embFlat, tf.norm(embFlat, 'euclidean', 1, true));
        const normaisNorm = tf.div(normais, tf.norm(normais, 'euclidean', 1, true));
        // Similaridades com todos os quadros normais salvos (-1 a 1)
        const similaridades = tf.matMul(embNorm, normaisNorm, false, true).squeeze();
        // Pega a maior similaridade com qualquer postura normal conhecida
        const maxSim = similaridades.rank === 0 ? similaridades.dataSync()[0] : tf.max(similaridades).dataSync()[0];
        // Normalmente quadros parecidos têm similaridade >= 0.82.
        // Quando ele muda de postura (ex: curva para lamber), a similaridade cai (< 0.72).
        const desvio = Math.max(0, (0.88 - maxSim) / 0.22);
        return Math.min(1, desvio);
      });
    } finally {
      embedding.dispose();
    }
  }

  limparClasse(classe) {
    if (this.contagem()[classe] > 0) this.classificador.clearClass(classe);
  }

  /** Converte o treino para um objeto que pode ser salvo no IndexedDB. */
  exportar() {
    const dataset = this.classificador.getClassifierDataset();
    const classes = {};
    for (const [rotulo, tensor] of Object.entries(dataset)) {
      classes[rotulo] = { shape: tensor.shape, dados: tensor.dataSync().slice() };
    }
    return { modelo: MODELO, classes };
  }

  /** Restaura um treino salvo. Retorna false se ele foi feito com outro modelo. */
  importar(salvo) {
    if (!salvo || salvo.modelo?.version !== MODELO.version || salvo.modelo?.alpha !== MODELO.alpha) {
      return false;
    }
    const dataset = {};
    for (const [rotulo, { shape, dados }] of Object.entries(salvo.classes)) {
      dataset[rotulo] = tf.tensor2d(dados, shape);
    }
    this.classificador.setClassifierDataset(dataset);
    return true;
  }

  _embedding(video) {
    return tf.tidy(() => this.modelo.infer(video, true));
  }
}
