/* Løfteudstyr – service worker
 *
 * To opgaver:
 *   1. Cache skallen, så appen starter uden net.
 *   2. Køre køen af ikke-sendte svar, når nettet kommer tilbage.
 *
 * Selve køen ligger i IndexedDB og skrives af index.html. Denne fil
 * tømmer den — både ved Background Sync og ved almindelig 'online'.
 */

const VERSION = 'loefteudstyr-v1.0.0';
const SHELL = VERSION + '-shell';
const DATA = VERSION + '-data';

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './favicon-32.png'
];

// pdf-lib.min.js er ~500 KB og hentes først, når manualen skal læses
// hele vejen igennem. Den caches ved første brug, ikke ved installation.

/* ------------------------------------------------------------------ */
/* Installation                                                        */
/* ------------------------------------------------------------------ */

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => c.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ------------------------------------------------------------------ */
/* Hentning                                                            */
/* ------------------------------------------------------------------ */

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // API-kald må aldrig caches. Et gammelt eftersyn i cachen er
  // farligere end ingen data.
  if (url.hostname.endsWith('script.google.com') ||
      url.hostname.endsWith('googleusercontent.com')) {
    return;
  }

  if (e.request.method !== 'GET') return;

  // Skallen: cache først, så appen åbner øjeblikkeligt og uden net.
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) {
        // Opdatér stille i baggrunden til næste gang.
        fetch(e.request)
          .then((res) => {
            if (res && res.ok) caches.open(SHELL).then((c) => c.put(e.request, res));
          })
          .catch(() => {});
        return hit;
      }
      return fetch(e.request)
        .then((res) => {
          if (res && res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(DATA).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});

/* ------------------------------------------------------------------ */
/* Kø i IndexedDB                                                      */
/* ------------------------------------------------------------------ */

const DB_NAME = 'loefteudstyr';
const DB_VERSION = 1;
const STORE = 'kø';

function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('config')) {
        db.createObjectStore('config', { keyPath: 'key' });
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function getAll(db, store) {
  return new Promise((res, rej) => {
    const r = tx(db, store, 'readonly').getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}

function del(db, store, key) {
  return new Promise((res, rej) => {
    const r = tx(db, store, 'readwrite').delete(key);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}

function put(db, store, val) {
  return new Promise((res, rej) => {
    const r = tx(db, store, 'readwrite').put(val);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function getConfig(db, key) {
  return new Promise((res) => {
    const r = tx(db, 'config', 'readonly').get(key);
    r.onsuccess = () => res(r.result ? r.result.value : null);
    r.onerror = () => res(null);
  });
}

/* ------------------------------------------------------------------ */
/* Tømning af køen                                                     */
/* ------------------------------------------------------------------ */

let kørerNu = false;

async function tømKø() {
  if (kørerNu) return { sendt: 0, tilbage: 0, låst: true };
  kørerNu = true;

  let sendt = 0, fejlet = 0;
  try {
    const db = await openDb();
    const endpoint = await getConfig(db, 'endpoint');
    const idToken = await getConfig(db, 'idToken');
    const sessionToken = await getConfig(db, 'sessionToken');

    if (!endpoint || (!idToken && !sessionToken)) {
      // Ikke logget ind endnu. Køen bliver stående — intet tabes.
      return { sendt: 0, tilbage: (await getAll(db, STORE)).length, ingenLogin: true };
    }

    // Rækkefølge betyder noget: svar skal lande i den orden de blev givet.
    const poster = (await getAll(db, STORE)).sort((a, b) => a.id - b.id);

    for (const p of poster) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          // text/plain undgår preflight. Apps Script kan ikke svare på OPTIONS.
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ idToken, sessionToken, action: p.action, args: p.args })
        });
        const svar = await res.json();

        if (svar.ok) {
          await del(db, STORE, p.id);
          sendt++;
        } else if (/logget ind|udløbet|token/i.test(svar.error || '')) {
          // Login udløbet: stop og behold resten. Brugeren logger ind igen.
          break;
        } else {
          // Serveren afviste indholdet. Retry hjælper ikke — markér den,
          // så brugeren kan se hvad der gik galt i stedet for at
          // appen prøver i det uendelige.
          p.fejl = svar.error;
          p.fejletDato = new Date().toISOString();
          await put(db, STORE, p);
          fejlet++;
        }
      } catch (err) {
        // Netværket faldt ud igen. Behold resten af køen.
        break;
      }
    }

    const tilbage = (await getAll(db, STORE)).length;
    const klienter = await self.clients.matchAll();
    klienter.forEach((c) => c.postMessage({
      type: 'KØ_OPDATERET', sendt, fejlet, tilbage
    }));
    return { sendt, fejlet, tilbage };
  } finally {
    kørerNu = false;
  }
}

self.addEventListener('sync', (e) => {
  if (e.tag === 'send-kø') e.waitUntil(tømKø());
});

self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'send-kø') e.waitUntil(tømKø());
});

self.addEventListener('message', (e) => {
  if (!e.data) return;
  if (e.data.type === 'TØM_KØ') e.waitUntil ? e.waitUntil(tømKø()) : tømKø();
  if (e.data.type === 'SPRING_VENTETID') self.skipWaiting();
});
