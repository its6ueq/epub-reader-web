let book = null;
let rendition = null;
let currentFontSize = 100;
let lastNavigateAt = 0;
let locationsReady = false;

const NAV_COOLDOWN_MS = 220;

const STORAGE_KEY = "epub-reader-state-v3";
const DB_NAME = "epub-reader-db";
const DB_VERSION = 3;
const FILE_STORE = "files";

const state = {
    theme: "light",
    lastCfi: "",
    lastBookName: "",
    fontSize: 100
};

const fileInput = document.getElementById("epub-file");
const viewer = document.getElementById("viewer");
const prevBtn = document.getElementById("prev-btn");
const nextBtn = document.getElementById("next-btn");
const toggleSidebarBtn = document.getElementById("toggle-sidebar");
const sidebar = document.getElementById("sidebar");
const tocList = document.getElementById("toc-list");
const bookTitle = document.getElementById("book-title");
const toggleThemeBtn = document.getElementById("toggle-theme");
const increaseFontBtn = document.getElementById("increase-font");
const decreaseFontBtn = document.getElementById("decrease-font");
const pageInfo = document.getElementById("page-info");

function canNavigateNow() {
    const now = Date.now();
    if (now - lastNavigateAt < NAV_COOLDOWN_MS) {
        return false;
    }
    lastNavigateAt = now;
    return true;
}

function goPrevPage() {
    if (rendition && canNavigateNow()) {
        rendition.prev();
    }
}

function goNextPage() {
    if (rendition && canNavigateNow()) {
        rendition.next();
    }
}

function shouldIgnoreKeydown(target) {
    if (!target) {
        return false;
    }

    const tag = target.tagName ? target.tagName.toLowerCase() : "";
    return tag === "input" || tag === "textarea" || target.isContentEditable;
}

function handleWheelNavigate(event) {
    if (!rendition) {
        return;
    }

    // Block default wheel scrolling so wheel always means page turn.
    event.preventDefault();

    if (event.deltaY > 0) {
        goNextPage();
    } else if (event.deltaY < 0) {
        goPrevPage();
    }
}

function loadState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
        return;
    }

    try {
        const parsed = JSON.parse(raw);
        Object.assign(state, parsed);
    } catch (error) {
        console.error("Failed to load state:", error);
    }
}

function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function applyStateToUI() {
    currentFontSize = Number(state.fontSize || 100);

    if (state.theme === "dark") {
        document.body.classList.add("dark-mode");
    }
}

function getDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(FILE_STORE)) {
                db.createObjectStore(FILE_STORE);
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function dbPut(storeName, key, value) {
    const db = await getDb();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    db.close();
}

async function dbGet(storeName, key) {
    const db = await getDb();
    const value = await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    db.close();
    return value;
}

async function saveBookBlob(file) {
    await dbPut(FILE_STORE, "last-book", file);
}

async function loadSavedBookBlob() {
    return dbGet(FILE_STORE, "last-book");
}

function renderTOC(toc) {
    tocList.innerHTML = "";

    toc.forEach((chapter) => {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = "#";
        a.textContent = chapter.label;
        a.onclick = async (event) => {
            event.preventDefault();
            if (!rendition) {
                return;
            }
            await rendition.display(chapter.href);
        };

        li.appendChild(a);
        tocList.appendChild(li);
    });
}

function updateThemeInViewer() {
    if (!rendition) {
        return;
    }

    const isDarkMode = document.body.classList.contains("dark-mode");
    const themes = rendition.themes;

    if (isDarkMode) {
        themes.register("dark", {
            body: { background: "#241f19", color: "#f8e8c8" },
            p: { color: "#f8e8c8" }
        });
        themes.select("dark");
    } else {
        themes.register("light", {
            body: { background: "#fffdf7", color: "#2f2a1f" },
            p: { color: "#2f2a1f" }
        });
        themes.select("light");
    }
}

function formatProgress(progressFraction) {
    const safe = Number.isFinite(progressFraction) ? progressFraction : 0;
    const clamped = Math.max(0, Math.min(1, safe));
    const percent = Math.round(clamped * 100);
    return `${percent}% read`;
}

function computeProgress(location) {
    // Prefer stable CFI-based percentage when locations are generated.
    if (book && locationsReady && location?.start?.cfi && book.locations) {
        const byCfi = book.locations.percentageFromCfi(location.start.cfi);
        if (Number.isFinite(byCfi)) {
            return byCfi;
        }
    }

    // Fallback to epub.js reported viewport percentage.
    if (Number.isFinite(location?.start?.percentage)) {
        return location.start.percentage;
    }

    return 0;
}

async function loadEpub(bookData, sourceName, startCfi) {
    if (book) {
        book.destroy();
    }

    viewer.innerHTML = "";
    tocList.innerHTML = "";

    book = ePub(bookData);
    locationsReady = false;

    rendition = book.renderTo("viewer", {
        width: "100%",
        height: "100%",
        spread: "none"
    });

    // Enable wheel navigation when mouse is over epub content iframe.
    rendition.hooks.content.register((contents) => {
        contents.document.addEventListener("wheel", handleWheelNavigate, { passive: false });
    });

    rendition.themes.fontSize(`${currentFontSize}%`);
    updateThemeInViewer();

    await rendition.display(startCfi || undefined);

    book.ready.then(async () => {
        const meta = await book.loaded.metadata;
        bookTitle.innerText = meta.title || sourceName || "Untitled Book";

        const nav = await book.loaded.navigation;
        renderTOC(nav.toc);

        try {
            await book.locations.generate(1600);
            locationsReady = true;
        } catch (error) {
            locationsReady = false;
            console.warn("Could not generate stable reading locations:", error);
        }
    });

    rendition.on("relocated", (location) => {
        const progress = computeProgress(location);
        pageInfo.innerText = formatProgress(progress);

        state.lastCfi = location.start.cfi;
        state.lastBookName = sourceName || state.lastBookName || "";
        saveState();
    });
}

fileInput.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) {
        return;
    }

    state.lastBookName = file.name;
    saveState();
    await saveBookBlob(file);

    const reader = new FileReader();
    reader.onload = async (loadEvent) => {
        const bookData = loadEvent.target.result;
        await loadEpub(bookData, file.name, null);
    };
    reader.readAsArrayBuffer(file);
});

prevBtn.addEventListener("click", () => {
    goPrevPage();
});

nextBtn.addEventListener("click", () => {
    goNextPage();
});

viewer.addEventListener("wheel", handleWheelNavigate, { passive: false });

document.addEventListener("keydown", (event) => {
    if (shouldIgnoreKeydown(event.target)) {
        return;
    }

    if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        goNextPage();
    }

    if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        goPrevPage();
    }
});

toggleSidebarBtn.addEventListener("click", () => {
    sidebar.classList.toggle("hidden");
});

toggleThemeBtn.addEventListener("click", () => {
    document.body.classList.toggle("dark-mode");
    state.theme = document.body.classList.contains("dark-mode") ? "dark" : "light";
    saveState();
    updateThemeInViewer();
});

increaseFontBtn.addEventListener("click", () => {
    currentFontSize = Math.min(currentFontSize + 10, 220);
    state.fontSize = currentFontSize;
    saveState();

    if (rendition) {
        rendition.themes.fontSize(`${currentFontSize}%`);
    }
});

decreaseFontBtn.addEventListener("click", () => {
    currentFontSize = Math.max(currentFontSize - 10, 50);
    state.fontSize = currentFontSize;
    saveState();

    if (rendition) {
        rendition.themes.fontSize(`${currentFontSize}%`);
    }
});

async function boot() {
    loadState();
    applyStateToUI();

    if (state.lastBookName) {
        bookTitle.innerText = `Restoring: ${state.lastBookName}`;
    }

    try {
        const savedBook = await loadSavedBookBlob();
        if (savedBook) {
            const data = await savedBook.arrayBuffer();
            await loadEpub(data, state.lastBookName || savedBook.name || "saved.epub", state.lastCfi || null);
        }
    } catch (error) {
        console.error("Could not restore saved reading data:", error);
    }
}

boot();
