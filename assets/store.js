/* AntionWhat Web — persistencia local (IndexedDB).
 *
 * Los chats y las copias se guardan en este navegador para que no se pierdan
 * al recargar. Los archivos multimedia NO se guardan (pueden ser gigabytes):
 * se ven mientras la carpeta esté cargada en la sesión.
 *
 * Si IndexedDB no está disponible (modo privado estricto, almacenamiento
 * bloqueado), todo sigue funcionando solo en memoria.
 */
(function (root) {
  "use strict";
  const DB_NAME = "antionwhat-web";
  const VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(DB_NAME, VERSION); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("chats")) db.createObjectStore("chats", { keyPath: "id" });
        if (!db.objectStoreNames.contains("sources")) db.createObjectStore("sources", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
    return dbPromise;
  }

  function tx(db, stores, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      const out = fn(t);
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  function getAll(db, store) {
    return new Promise((resolve, reject) => {
      const req = db.transaction(store).objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  const Store = {
    persistent: false,
    async load() {
      const db = await open();
      this.persistent = !!db;
      if (!db) return { chats: [], sources: [] };
      const [chats, sources] = await Promise.all([getAll(db, "chats"), getAll(db, "sources")]);
      return { chats, sources };
    },
    async saveChats(list) {
      const db = await open();
      if (!db) return;
      await tx(db, ["chats"], "readwrite", (t) => { const s = t.objectStore("chats"); list.forEach((c) => s.put(c)); });
    },
    async saveSource(src) {
      const db = await open();
      if (!db) return;
      await tx(db, ["sources"], "readwrite", (t) => t.objectStore("sources").put(src));
    },
    async deleteChat(id) {
      const db = await open();
      if (!db) return;
      await tx(db, ["chats"], "readwrite", (t) => t.objectStore("chats").delete(id));
    },
    async deleteSource(id, touchedChats, removedChatIds) {
      const db = await open();
      if (!db) return;
      await tx(db, ["sources", "chats"], "readwrite", (t) => {
        t.objectStore("sources").delete(id);
        const s = t.objectStore("chats");
        touchedChats.forEach((c) => s.put(c));
        removedChatIds.forEach((cid) => s.delete(cid));
      });
    },
    async clear() {
      const db = await open();
      if (!db) return;
      await tx(db, ["sources", "chats"], "readwrite", (t) => { t.objectStore("sources").clear(); t.objectStore("chats").clear(); });
    },
    async estimate() {
      try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; }
      catch (e) { return null; }
    },
  };
  root.AWStore = Store;
})(window);
