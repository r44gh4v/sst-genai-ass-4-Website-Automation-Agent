// ── Constants ──────────────────────────────────────────────────────────
const EXAMPLES = [
    "Open https://ui.shadcn.com/docs/forms/react-hook-form and fill the Bug Title with 'Test bug' and Description with 'Filed by the automation agent'",
    "Go to wikipedia.org and search for 'quantum computing', then summarise the first paragraph",
    "Go to news.ycombinator.com and list the titles of the top 5 posts",
    "Open example.com and take a screenshot",
];

const TOOL_ICONS = {
    open_browser: "🚀", navigate_to_url: "🌐", go_back: "◀", go_forward: "▶",
    reload_page: "🔄", close_browser: "🚪", get_page_snapshot: "🧭",
    read_page_text: "📖", get_page_info: "ℹ️", take_screenshot: "📸",
    analyze_screen: "👁️", click: "🖱️", double_click_element: "🖱️", hover: "🎯",
    fill: "⌨️", clear_field: "🧹", select_option: "🔽", set_checkbox: "☑️",
    scroll_to: "📍", upload_file: "📎", drag_and_drop: "🤚", find_element: "🔎",
    fill_element: "⌨️", click_on_screen: "🖱️", drag_on_screen: "✏️", double_click: "🖱️",
    send_keys: "⌨️", press_key: "⏎", scroll: "🖲️", wait_for: "⏳",
    new_tab: "➕", list_tabs: "🗂️", switch_tab: "🔀", close_tab: "✖",
    evaluate_js: "⚙️", handle_dialog: "💬",
};

// ── DOM refs ───────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const feed        = $("feed");
const feedBody    = feed.parentElement; // .card-body - used for scroll-to-bottom
const shots       = $("shots");
const dot         = $("dot");
const statusText  = $("statusText");
const iterEl      = $("iter");
const runBtn      = $("run");
const stopBtn     = $("stop");
const promptEl    = $("prompt");
const feedCountEl = $("feedCount");
const shotCountEl = $("shotCount");

let feedCount = 0;
let shotCount = 0;

// ── Example chips ──────────────────────────────────────────────────────
const examplesWrap = $("examples");
EXAMPLES.forEach((ex) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = ex;
    chip.title = ex;
    chip.onclick = () => { promptEl.value = ex; promptEl.focus(); };
    examplesWrap.appendChild(chip);
});

// ── Feed helpers ───────────────────────────────────────────────────────
function clearFeed() {
    feed.innerHTML = "";
    feedCount = 0;
    feedCountEl.textContent = "";
}

function clearAll() {
    clearFeed();
    shots.innerHTML = '<span class="empty">Screenshots appear here.</span>';
    shotCount = 0;
    shotCountEl.textContent = "";
}

function bumpFeed() {
    feedCount++;
    feedCountEl.textContent = feedCount;
}

function addEvent(cls, tag, body, pre) {
    const div = document.createElement("div");
    div.className = "event " + cls;

    const tagEl = document.createElement("span");
    tagEl.className = "tag";
    tagEl.textContent = tag;
    div.appendChild(tagEl);

    if (body) div.appendChild(document.createTextNode(body));

    if (pre) {
        const preEl = document.createElement("pre");
        preEl.textContent = pre;
        div.appendChild(preEl);
    }

    const atBottom = feedBody.scrollHeight - feedBody.scrollTop - feedBody.clientHeight < 60;
    feed.appendChild(div);
    bumpFeed();
    if (atBottom) feedBody.scrollTop = feedBody.scrollHeight;
}

// ── Status helpers ─────────────────────────────────────────────────────
function setStatus(state, text) {
    if (dot) dot.className = "dot " + state;
    statusText.textContent = text;
}

function setRunning(isRunning) {
    runBtn.disabled = isRunning;
    stopBtn.hidden = !isRunning;
}

// ── Argument formatter for tool calls ─────────────────────────────────
function fmtArgs(args) {
    if (!args || typeof args !== "object") return "";
    const parts = Object.entries(args).map(
        ([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`
    );
    const s = parts.join("  ");
    return s.length > 220 ? s.slice(0, 217) + "…" : s;
}

// ── Screenshot renderer ────────────────────────────────────────────────
function addScreenshot(name, dataUrl) {
    if (shotCount === 0) shots.innerHTML = ""; // clear placeholder

    const fig = document.createElement("figure");

    const img = document.createElement("img");
    img.src = dataUrl;
    img.alt = name;
    img.loading = "lazy";
    img.onclick = () => {
        $("lightboxImg").src = dataUrl;
        $("lightbox").style.display = "flex";
    };

    const cap = document.createElement("figcaption");
    cap.textContent = name;

    fig.appendChild(img);
    fig.appendChild(cap);
    shots.appendChild(fig);

    shotCount++;
    shotCountEl.textContent = shotCount;
}

$("lightbox").onclick = () => { $("lightbox").style.display = "none"; };

// ── SSE event stream ───────────────────────────────────────────────────
const es = new EventSource("/events");

es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }

    switch (ev.type) {
        case "status":
            if (ev.state === "running") {
                setStatus("running", ev.message);
                setRunning(true);
            } else if (ev.state === "done") {
                setStatus("done", "Done");
                if (ev.message) addEvent("ev-done", "✅ Done", ev.message);
                setRunning(false);
            } else if (ev.state === "error") {
                setStatus("error", "Error");
                addEvent("ev-error", "✗ Error", ev.message);
                setRunning(false);
            }
            break;

        case "iteration":
            iterEl.textContent = `step ${ev.current}/${ev.max}`;
            break;

        case "log":
            addEvent("ev-log", ev.level, ev.message, ev.data);
            break;

        case "tool-call": {
            const icon = TOOL_ICONS[ev.name] || "•";
            const cls  = ev.name === "analyze_screen" ? "ev-vision" : "ev-tool-call";
            addEvent(cls, `${icon} ${ev.name}`, "", fmtArgs(ev.args));
            break;
        }

        case "tool-result": {
            const ok = ev.success;
            const isVision = ev.name === "analyze_screen";
            const cls = isVision && ok
                ? "ev-vision"
                : "ev-tool-result" + (ok ? "" : " fail");
            const result = typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result);
            addEvent(cls, `${ok ? "✓" : "✗"} ${ev.name}`, "", result);
            break;
        }

        case "assistant":
            addEvent("ev-assistant", "🤖 Agent", ev.content);
            break;

        case "screenshot":
            addScreenshot(ev.name, ev.dataUrl);
            break;
    }
};

// Sync UI state with server on (re)connect and load model badges
es.onopen = async () => {
    try {
        const h = await fetch("/health").then((r) => r.json());
        if (h.busy) {
            setRunning(true);
            if (!dot?.className.includes("running")) setStatus("running", "Run in progress…");
        } else {
            setRunning(false);
            if (!dot?.className.includes("done")) setStatus("", "Idle");
        }
    } catch { /* /health unreachable; leave UI as-is */ }
};

es.onerror = () => setStatus("error", "Reconnecting…");

// ── Run & Stop ─────────────────────────────────────────────────────────
async function run() {
    const prompt = promptEl.value.trim();
    if (!prompt) { promptEl.focus(); return; }
    clearAll();
    setRunning(true);
    iterEl.textContent = "";
    setStatus("running", "Starting…");
    try {
        const res = await fetch("/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            const msg = err.error || "Request failed";
            setStatus("error", msg);
            addEvent("ev-error", "✗ Error", msg);
            setRunning(false);
        }
    } catch (e) {
        const msg = String(e);
        setStatus("error", msg);
        addEvent("ev-error", "✗ Error", msg);
        setRunning(false);
    }
}

async function stop() {
    stopBtn.disabled = true;
    setStatus("running", "Stopping…");
    try { await fetch("/stop", { method: "POST" }); } catch { /* ignore */ }
    setTimeout(() => { stopBtn.disabled = false; }, 1500);
}

runBtn.onclick = run;
stopBtn.onclick = stop;
promptEl.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run();
});

$("clearFeed").onclick = clearFeed;

// ── Mobile tab switching ───────────────────────────────────────────────
document.body.dataset.tab = "activity";
document.querySelectorAll(".tab").forEach((btn) => {
    btn.onclick = () => {
        document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
        document.body.dataset.tab = btn.dataset.tab;
    };
});
