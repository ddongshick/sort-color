'use strict';

// Bump this value and the matching HTML meta tag whenever the offline shell changes.
// A waiting worker activates after all old app tabs close; it never reloads a live session.
const SHELL_VERSION = '2026-10-19-offline-v1';
const SCOPE_URL = new URL(self.registration.scope);
const CACHE_PREFIX = `sort-color-shell:${encodeURIComponent(SCOPE_URL.href)}:`;
const CACHE_NAME = `${CACHE_PREFIX}${SHELL_VERSION}`;
const INDEX_URL = new URL('index.html', SCOPE_URL).href;
const SHELL_FILES = [
    'index.html',
    'vendor/tf-1.3.1.min.js',
    'vendor/teachablemachine-image-0.8.5.min.js'
];
const SHELL_URLS = SHELL_FILES.map(file => new URL(file, SCOPE_URL).href);
const VENDOR_URLS = new Set(SHELL_URLS.slice(1));
const NETWORK_TIMEOUT_MS = 3500;
let repairPromise = null;

async function downloadShell(url) {
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok || response.type === 'opaque') {
        throw new Error(`Offline shell download failed: ${url}`);
    }
    const text = await response.clone().text();
    if (url === INDEX_URL) {
        const marker = `<meta name="offline-shell-version" content="${SHELL_VERSION}">`;
        if (!response.headers.get('content-type')?.includes('text/html') ||
            !text.includes(marker) || !SHELL_FILES.slice(1).every(file => text.includes(file))) {
            throw new Error('The published page does not match this offline version.');
        }
    } else if (text.length < 1000 || /^\s*</.test(text)) {
        throw new Error('An AI library is missing or the server returned an HTML error.');
    }
    return [url, response];
}

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        // Download and validate every file before publishing any cached shell.
        // A failed update leaves the previous version available for the active worker.
        const responses = await Promise.all(SHELL_URLS.map(downloadShell));
        const cache = await caches.open(CACHE_NAME);
        try {
            for (const [url, response] of responses) await cache.put(url, response);
        } catch (error) {
            await caches.delete(CACHE_NAME);
            throw error;
        }
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
            .map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

async function readShellState() {
    const cache = await caches.open(CACHE_NAME);
    const missing = [];
    for (let i = 0; i < SHELL_URLS.length; i++) {
        if (!await cache.match(SHELL_URLS[i])) missing.push(SHELL_FILES[i]);
    }
    return { type: 'OFFLINE_READY', ready: missing.length === 0, version: SHELL_VERSION, missing };
}

async function repairShell() {
    if (repairPromise) return repairPromise;
    repairPromise = (async () => {
        if ((await readShellState()).ready) return;
        // Download the entire same-version shell before touching the retained copy.
        // A newer server page is rejected by downloadShell; closing old app tabs
        // allows that newer worker to activate instead. IndexedDB is never touched.
        const responses = await Promise.all(SHELL_URLS.map(downloadShell));
        const cache = await caches.open(CACHE_NAME);
        for (const [url, response] of responses) await cache.put(url, response);
        // On quota/write failure, preserve every existing valid entry for a retry.
    })();
    try {
        await repairPromise;
    } finally {
        repairPromise = null;
    }
}

self.addEventListener('message', event => {
    const action = event.data?.type;
    if (!['CHECK_READY', 'REPAIR_SHELL'].includes(action) || !event.ports?.[0]) return;
    event.waitUntil((async () => {
        try {
            if (action === 'REPAIR_SHELL') await repairShell();
            event.ports[0].postMessage(await readShellState());
        } catch {
            let status;
            try { status = await readShellState(); } catch {
                status = { type: 'OFFLINE_READY', ready: false,
                    version: SHELL_VERSION, missing: [...SHELL_FILES] };
            }
            event.ports[0].postMessage({ ...status, ready: false, repairFailed: action === 'REPAIR_SHELL' });
        }
    })());
});

async function navigateApp(request) {
    const abort = new AbortController();
    let timer;
    try {
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                abort.abort();
                reject(new Error('Navigation timed out.'));
            }, NETWORK_TIMEOUT_MS);
        });
        const response = await Promise.race([
            fetch(new Request(request, { cache: 'no-store', signal: abort.signal })), timeout
        ]);
        if (response.ok && response.headers.get('content-type')?.includes('text/html')) return response;
    } catch {
        // No internet (or an unusable response): use the complete installed version.
    } finally {
        clearTimeout(timer);
    }
    const cache = await caches.open(CACHE_NAME);
    return await cache.match(INDEX_URL) || new Response(
        '오프라인 실행 파일이 없습니다. 인터넷에 연결한 뒤 이 페이지를 다시 열어 주세요.',
        { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
}

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    // Other apps on the same github.io origin and all remote models pass through untouched.
    if (url.origin !== SCOPE_URL.origin) return;
    const appDocument = url.pathname === SCOPE_URL.pathname ||
        url.pathname === new URL(INDEX_URL).pathname;
    if (request.mode === 'navigate' && appDocument) {
        // Never overwrite the cached HTML here: it belongs to its installed vendor bundle.
        event.respondWith(navigateApp(request));
    } else if (VENDOR_URLS.has(url.href)) {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE_NAME);
            return await cache.match(url.href) || fetch(request);
        })());
    }
});
