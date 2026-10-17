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

  /** Tem exemplos suficientes das duas classes? */
  pronto() {
    if (!this.carregado) return false;
    const c = this.contagem();
    return c[CLASSES.LAMBENDO] >= MIN_EXEMPLOS && c[CLASSES.NORMAL] >= MIN_EXEMPLOS;
  }

  /** Adiciona o quadro atual do vídeo como exemplo da classe. Retorna false se atingiu o limite. */
  adicionarExemplo(video, classe) {
    if (this.contagem()[classe] >= MAX_EXEMPLOS) return false;
    const embedding = this._embedding(video);
    this.classificador.addExample(embedding, classe);
    embedding.dispose();
    return true;
  }

  /** Probabilidade (0–1) de o quadro atual ser "lambendo". */
  async probabilidadeLambendo(video) {
    const embedding = this._embedding(video);
    try {
      const resultado = await this.classificador.predictClass(embedding, K);
      return resultado.confidences[CLASSES.LAMBENDO] ?? 0;
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
