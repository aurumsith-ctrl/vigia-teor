/**
 * Armazenamento local no celular (IndexedDB): treino, voz, ajustes e histórico.
 * Nada é enviado para a internet.
 */

const NOME_BANCO = 'vigia-thor';
const VERSAO_BANCO = 1;

let bancoPromise = null;

function abrir() {
  if (!bancoPromise) {
    bancoPromise = new Promise((ok, erro) => {
      const req = indexedDB.open(NOME_BANCO, VERSAO_BANCO);
      req.onupgradeneeded = () => {
        const banco = req.result;
        if (!banco.objectStoreNames.contains('config')) banco.createObjectStore('config');
        if (!banco.objectStoreNames.contains('sessoes')) {
          banco.createObjectStore('sessoes', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => ok(req.result);
      req.onerror = () => erro(req.error);
    });
  }
  return bancoPromise;
}

async function transacao(loja, modo, operacao) {
  const banco = await abrir();
  return new Promise((ok, erro) => {
    const tx = banco.transaction(loja, modo);
    const req = operacao(tx.objectStore(loja));
    tx.oncomplete = () => ok(req ? req.result : undefined);
    tx.onerror = () => erro(tx.error);
    tx.onabort = () => erro(tx.error);
  });
}

export const salvar = (chave, valor) => transacao('config', 'readwrite', (s) => s.put(valor, chave));
export const carregar = (chave) => transacao('config', 'readonly', (s) => s.get(chave));
export const apagar = (chave) => transacao('config', 'readwrite', (s) => s.delete(chave));

export const salvarSessao = (sessao) => transacao('sessoes', 'readwrite', (s) => s.put(sessao));
export const listarSessoes = () => transacao('sessoes', 'readonly', (s) => s.getAll());
export const apagarSessoes = () => transacao('sessoes', 'readwrite', (s) => s.clear());
