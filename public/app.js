const EXAMPLES = [
    "Open https://ui.shadcn.com/docs/forms/react-hook-form and fill the Bug Title with 'Test bug' and Description with 'Filed by the automation agent'",
    "Go to wikipedia.org and search for 'quantum computing'",
    "Go to duckduckgo.com and search for 'playwright automation'",
    "Open example.com and take a screenshot"
];

const $ = (id) => document.getElementById(id);
const feed = $("feed");
const feedBody = feed.parentElement;
const shots = $("shots");
const dot = $("dot");
const statusText = $("statusText");
const iterEl = $("iter");
const runBtn = $("run");
const promptEl = $("prompt");

// Render example chips
const exWrap = $("examples");
EXAMPLES.forEach((ex) => {
    const c = document.createElement("span");
    c.className = "chip";
    c.textContent = ex;

    c.onclick = () => { promptEl.value = ex; promptEl.focus(); };
    exWrap.appendChild(c);
});

function clearFeed() {
    feed.innerHTML = "";
    shots.innerHTML = "";
    $("summary").textContent = "";
    $("summary").className = "";
}

function addEvent(cls, tag, body, pre) {
    const div = document.createElement("div");
    div.className = "event " + cls;
    const t = document.createElement("span");
    t.className = "tag";
    t.textContent = tag;
    div.appendChild(t);
    div.appendChild(document.createTextNode(body));
    if (pre) {
        const p = document.createElement("pre");
        p.textContent = pre;
        div.appendChild(p);
    }
    feed.appendChild(div);
    feedBody.scrollTop = feedBody.scrollHeight;
}

function setStatus(state, text) {
    dot.className = "dot " + state;
    statusText.textContent = text;
}

function addScreenshot(name, dataUrl) {
    const fig = document.createElement("figure");
    const img = document.createElement("img");
    img.src = dataUrl;
    img.alt = name;
    img.onclick = () => { $("lightboxImg").src = dataUrl; $("lightbox").style.display = "flex"; };
    const cap = document.createElement("figcaption");
    cap.textContent = name;
    fig.appendChild(img);
    fig.appendChild(cap);
    shots.appendChild(fig);
}

$("lightbox").onclick = () => { $("lightbox").style.display = "none"; };

// Single persistent SSE connection for the life of the page.
const es = new EventSource("/events");
es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    switch (ev.type) {
        case "status":
            if (ev.state === "running") { setStatus("running", ev.message); }
            else if (ev.state === "done") {
                setStatus("done", "Done");
                $("summary").textContent = ev.message;
                runBtn.disabled = false;
            } else if (ev.state === "error") {
                setStatus("error", "Error");
                $("summary").textContent = ev.message;
                addEvent("ev-error", "ERROR", ev.message);
                runBtn.disabled = false;
            }
            break;
        case "iteration":
            iterEl.textContent = `step ${ev.current}/${ev.max}`;
            break;
        case "log":
            addEvent("ev-log", ev.level, ev.message, ev.data);
            break;
        case "tool-call":
            addEvent("ev-tool-call", "→ " + ev.name, "", JSON.stringify(ev.args));
            break;
        case "tool-result":
            addEvent("ev-tool-result" + (ev.success ? "" : " fail"), (ev.success ? "✓ " : "✗ ") + ev.name, "",
                typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result));
            break;
        case "assistant":
            addEvent("ev-assistant", "AGENT", ev.content);
            break;
        case "screenshot":
            addScreenshot(ev.name, ev.dataUrl);
            break;
    }
};
// On (re)connect - including the very first connect on page load - reconcile the
// UI with the server's real state via /health. This recovers from any events lost
// during a disconnect gap (including a missed terminal status event) so the Run
// button never gets stuck disabled, and reflects an in-progress run after a reload.
es.onopen = async () => {
    try {
        const h = await fetch("/health").then((r) => r.json());
        if (h.busy) {
            runBtn.disabled = true;
            if (dot.className.indexOf("running") === -1) setStatus("running", "Run in progress...");
        } else {
            runBtn.disabled = false;
            if (dot.className.indexOf("done") === -1) setStatus("", "Idle");
        }
    } catch { /* health unreachable; leave current UI state */ }
};
// EventSource auto-reconnects, so a transient drop is advisory, not terminal.
es.onerror = () => setStatus("error", "Reconnecting…");

async function run() {
    const prompt = promptEl.value.trim();
    if (!prompt) { promptEl.focus(); return; }
    clearFeed();
    runBtn.disabled = true;
    iterEl.textContent = "";
    setStatus("running", "Starting...");
    try {
        const res = await fetch("/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            setStatus("error", err.error || "Request failed");
            $("summary").textContent = err.error || "Request failed";
            runBtn.disabled = false;
        }
    } catch (e) {
        setStatus("error", String(e));
        runBtn.disabled = false;
    }
}

runBtn.onclick = run;
promptEl.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run();
});
