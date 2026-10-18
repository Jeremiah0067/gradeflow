// Keeps photos that are waiting to be uploaded on the phone itself (IndexedDB),
// so a refresh, a closed tab or a phone restart does not lose a batch of scripts.
// Everything here is best effort: if the phone refuses to store them, the page still works.

const DB_NAME = 'gradeflow-drafts';
const STORE = 'drafts';

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('This browser cannot save photos on the device.'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('examId', 'examId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function runTx(db, mode, work) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Saving was cancelled.'));
    result = work(t.objectStore(STORE), (v) => (result = v));
  });
}

// Replaces what is saved for this marking job with the current drafts (scripts that have photos).
export async function saveDrafts(examId, drafts) {
  const db = await open();
  try {
    const keep = new Set(drafts.map((d) => `${examId}:${d.key}`));
    await runTx(db, 'readwrite', (store) => {
      const req = store.index('examId').getAllKeys(examId);
      req.onsuccess = () => {
        req.result.forEach((k) => {
          if (!keep.has(k)) store.delete(k);
        });
        drafts.forEach((d) =>
          store.put({
            id: `${examId}:${d.key}`,
            examId,
            key: d.key,
            studentId: d.studentId || '',
            paperId: d.paperId || '',
            doneIds: d.doneIds || [],
            pages: d.pages.map((p) => ({ id: p.id, blob: p.blob })),
            savedAt: Date.now(),
          })
        );
      };
    });
  } finally {
    db.close();
  }
}

export async function loadDrafts(examId) {
  const db = await open();
  try {
    const rows = await runTx(db, 'readonly', (store, set) => {
      const req = store.index('examId').getAll(examId);
      req.onsuccess = () => set(req.result);
    });
    return (rows || [])
      .sort((a, b) => a.savedAt - b.savedAt)
      .map((r) => ({ studentId: r.studentId, paperId: r.paperId, doneIds: r.doneIds || [], pages: r.pages || [] }))
      .filter((r) => r.pages.length > 0);
  } finally {
    db.close();
  }
}

export async function clearDrafts(examId) {
  await saveDrafts(examId, []);
}
