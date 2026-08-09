const root = document.documentElement;
const THEME_KEY = "app-shell-theme";

function applyTheme(theme) {
  root.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // storage unavailable; attribute is enough
  }
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    saved = null;
  }
  if (saved === "light" || saved === "dark") {
    applyTheme(saved);
  } else {
    applyTheme(matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }
}

const els = {
  themeToggle: document.querySelector("[data-theme-toggle]"),
  navItems: document.querySelectorAll(".nav-item[data-view]"),
  views: document.querySelectorAll(".view"),
  statsRow: document.querySelector("#statsRow"),
  serviceGrid: document.querySelector("#serviceGrid"),
  eventsList: document.querySelector("#eventsList"),
  eventsFull: document.querySelector("#eventsFull"),
  healthList: document.querySelector("#healthList"),
  overallPill: document.querySelector("#overallPill"),
  checkedAt: document.querySelector("#checkedAt"),
  hubDot: document.querySelector("#hubDot"),
  hubMini: document.querySelector("#hubMini"),
  refreshBtn: document.querySelector("#refreshBtn")
};

let serviceCache = null;
let maintenanceCache = null;
let polling = true;
const pending = new Set();
const pendingTimers = new Map();

const icons = {
  bot: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2"></rect><path d="M12 4v4"></path><circle cx="12" cy="2.5" r="0.5"></circle><path d="M9 13h.01M15 13h.01M9 17h6"></path></svg>',
  message: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>',
  server: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"></rect><rect x="2" y="14" width="20" height="8" rx="2"></rect><path d="M6 6h.01M6 18h.01"></path></svg>',
  activity: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>',
  power: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><path d="M12 2v10"></path></svg>',
  external: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path></svg>',
  shield: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>'
};

function serviceIcon(id) {
  if (id.startsWith("napcat")) return icons.message;
  if (id === "hub") return icons.activity;
  return icons.bot;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function formatTime(value) {
  if (!value) return "--:--:--";
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function renderStats(services) {
  const total = services.length;
  const running = services.filter((s) => s.running).length;
  const qqs = services.filter((s) => s.qq).filter((s) => s.running).length;
  const napcats = services.filter((s) => s.id.startsWith("napcat")).length;
  const hub = services.find((s) => s.id === "hub");

  const cards = [
    { label: "运行中服务", value: `${running} / ${total}`, icon: icons.activity },
    { label: "QQ 在线", value: `${qqs} / ${napcats}`, icon: icons.message },
    {
      label: "Hub",
      value: hub?.running ? "在线" : "离线",
      icon: icons.server,
      tone: hub?.running ? "ok" : "bad"
    },
    {
      label: "OneBot 连接",
      value: maintenanceCache?.oneBotWs?.connected ? "已连接" : "未连接",
      icon: icons.shield,
      tone: maintenanceCache?.oneBotWs?.connected ? "ok" : "warn"
    }
  ];

  els.statsRow.innerHTML = cards
    .map((card) => `
      <article class="stat-card">
        <div class="icon-plate">${card.icon}</div>
        <div class="stat-body">
          <span class="label">${card.label}</span>
          <span class="value" style="${card.tone === "bad" ? "color:var(--text-danger)" : card.tone === "warn" ? "color:var(--text-warning)" : ""}">${escapeHtml(card.value)}</span>
        </div>
      </article>
    `)
    .join("");
}

function renderServices(services) {
  els.serviceGrid.innerHTML = services
    .map((svc) => {
      const starting = pending.has(svc.id) && !svc.running;
      const statusText = svc.running ? "运行中" : starting ? "启动中" : "已停止";
      const statusTone = svc.running ? "ok" : starting ? "warn" : "bad";
      const statusClass = statusTone;
      const ports = [
        ...svc.http.map((p) => ({ k: "HTTP", v: p.port, up: p.up })),
        ...svc.ws.map((p) => ({ k: "WS", v: p.port, up: p.up }))
      ];
      const loginHint = svc.id.startsWith("napcat")
        ? `<div class="login-hint">启动后会自动快速登录；若登录态失效，需扫码登录一次。</div>`
        : "";
      const startBtn = svc.startable
        ? `<button type="button" class="btn primary small" data-action="start" data-service="${svc.id}" ${svc.running || starting ? "disabled" : ""}>
            ${icons.power} ${starting ? "启动中…" : "启动"}
          </button>`
        : "";
      const stopBtn = svc.stoppable
        ? `<button type="button" class="btn ghost small danger" data-action="stop" data-service="${svc.id}" ${svc.running ? "" : "disabled"}>
            停止
          </button>`
        : "";
      const webBtn = svc.webui
        ? `<a class="btn ghost small" href="${escapeHtml(svc.webui)}" target="_blank" rel="noopener">
            ${icons.external} WebUI
          </a>`
        : "";
      return `
        <article class="service-card" data-service="${svc.id}">
          <div class="card-top">
            <div class="icon-plate">${serviceIcon(svc.id)}</div>
            <div class="card-title">
              <h3>${escapeHtml(svc.label)}</h3>
              <span>${escapeHtml(svc.role || (svc.qq ? `QQ ${svc.qq}` : ""))}</span>
            </div>
            <span class="pill ${statusClass}">${statusText}</span>
          </div>
          <div class="card-ports">
            ${ports
              .map((p) => `
                <div class="port-row">
                  <span class="k">${p.k}</span>
                  <span class="v ${p.up ? "ok" : "bad"}">${p.v} · ${p.up ? "可达" : "不可达"}</span>
                </div>
              `)
              .join("")}
            ${loginHint}
          </div>
          <div class="card-actions">
            ${webBtn}
            ${startBtn}
            ${stopBtn}
          </div>
        </article>
      `;
    })
    .join("");
}

function renderEvents(events) {
  const rows = events.length
    ? events
        .map((record) => {
          const sender = record.userName || record.userId || "未知群友";
          const decided = record.decision?.ok ? "回复" : "忽略";
          const tone = record.decision?.ok ? "ok" : "quiet";
          return `
            <div class="event-item">
              <div class="event-meta">
                <span>${formatTime(record.receivedAt)} · <span class="pill ${tone}">${decided}</span></span>
                <span>${escapeHtml(record.groupId || "")}</span>
              </div>
              <div class="event-text">
                <strong>${escapeHtml(sender)}：</strong>${escapeHtml(record.text || "")}
              </div>
            </div>
          `;
        })
        .join("")
    : '<div class="event-empty">还没有消息事件。在群里 @ 机器人试试，desuno。</div>';

  els.eventsList.innerHTML = rows;
  els.eventsFull.innerHTML = rows;
}

function renderHealth(maintenance) {
  const rows = [
    {
      name: "OneBot WS",
      ok: Boolean(maintenance?.oneBotWs?.connected),
      detail: maintenance?.oneBotWs?.url ? `${maintenance.oneBotWs.url.replace("ws://", "")}` : "未连接",
      tone: "bad"
    },
    {
      name: "QQ 登录",
      ok: Boolean(maintenance?.oneBot?.ok),
      detail: maintenance?.oneBot?.nickname
        ? `${maintenance.oneBot.nickname}`
        : maintenance?.oneBot?.lastError || "未登录",
      tone: "bad"
    },
    {
      name: "Codex CLI",
      ok: Boolean(maintenance?.codex?.pathExists),
      detail: maintenance?.codex?.pathExists ? "可用" : "缺失",
      tone: "warn"
    },
    {
      name: "远程执行",
      ok: Boolean(maintenance?.remoteExecution?.enabled),
      detail: maintenance?.remoteExecution?.enabled
        ? `${maintenance.remoteExecution.reasoningEffort} · ${maintenance.remoteExecution.model || ""}`
        : "已关闭",
      tone: "off"
    }
  ];

  els.healthList.innerHTML = rows
    .map((row) => `
      <div class="health-row">
        <span class="name">${row.name}</span>
        <span class="state ${row.ok ? "" : row.tone === "warn" ? "warn" : row.tone === "off" ? "off" : "bad"}">
          <span class="dot"></span>${escapeHtml(row.detail || (row.ok ? "正常" : "异常"))}
        </span>
      </div>
    `)
    .join("");
}

function updateChrome(services) {
  const running = services.filter((s) => s.running).length;
  const total = services.length;
  const hub = services.find((s) => s.id === "hub");
  els.overallPill.textContent = running === total ? "全部在线" : `${running} / ${total} 在线`;
  els.overallPill.className = `pill ${running === total ? "ok" : running > 0 ? "warn" : "bad"}`;
  els.hubDot.className = `mini-dot ${hub?.running ? "ok" : "bad"}`;
  els.hubMini.textContent = hub?.running ? "Hub 在线" : "Hub 离线";
}

async function refresh() {
  try {
    const [servicesRes, maintenanceRes, stateRes] = await Promise.all([
      api("/api/services"),
      api("/api/maintenance"),
      api("/api/state")
    ]);
    serviceCache = servicesRes;
    maintenanceCache = maintenanceRes;
    renderStats(servicesRes.services);
    renderServices(servicesRes.services);
    renderEvents(stateRes.qq?.recentEvents || []);
    renderHealth(maintenanceRes);
    updateChrome(servicesRes.services);
    els.checkedAt.textContent = `${formatTime(servicesRes.checkedAt)} 更新`;
  } catch (error) {
    els.overallPill.textContent = "连接失败";
    els.overallPill.className = "pill bad";
    els.eventsList.innerHTML = `<div class="event-empty">无法连接 Hub：${escapeHtml(error.message)}</div>`;
    els.eventsFull.innerHTML = els.eventsList.innerHTML;
  }
}

async function startService(id) {
  const btn = document.querySelector(`[data-service="${id}"][data-action="start"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = "启动中";
  }
  pending.add(id);
  const timer = setTimeout(() => {
    pending.delete(id);
    pendingTimers.delete(id);
    refresh();
  }, 90000);
  pendingTimers.set(id, timer);
  refresh();
  try {
    const result = await api("/api/services/start", {
      method: "POST",
      body: JSON.stringify({ service: id })
    });
    if (!result.ok) throw new Error(result.error || "启动失败");
    pending.delete(id);
    clearTimeout(pendingTimers.get(id));
    pendingTimers.delete(id);
    setTimeout(refresh, 2500);
  } catch (error) {
    alert(`启动失败：${error.message}`);
    if (btn) btn.disabled = false;
    pending.delete(id);
    clearTimeout(pendingTimers.get(id));
    pendingTimers.delete(id);
    refresh();
  }
}

async function stopService(id) {
  const svc = serviceCache?.services?.find((s) => s.id === id);
  const hint = svc?.stopHint ? `\n\n${svc.stopHint}` : "";
  if (!window.confirm(`确定停止「${svc?.label || id}」？${hint}\n\n停止后服务需要手动或从这里重新启动。`)) return;

  const btn = document.querySelector(`[data-service="${id}"][data-action="stop"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = "停止中";
  }
  try {
    const result = await api("/api/services/stop", {
      method: "POST",
      body: JSON.stringify({ service: id })
    });
    if (!result.ok) throw new Error(result.error || "停止失败");
    setTimeout(refresh, 1500);
  } catch (error) {
    alert(`停止失败：${error.message}`);
    if (btn) btn.disabled = false;
  }
}

els.themeToggle.addEventListener("click", () => {
  applyTheme(root.getAttribute("data-theme") === "dark" ? "light" : "dark");
});

els.navItems.forEach((item) => {
  item.addEventListener("click", (event) => {
    event.preventDefault();
    els.navItems.forEach((n) => n.classList.toggle("active", n === item));
    const view = item.dataset.view;
    els.views.forEach((v) => v.classList.toggle("active", v.dataset.view === view));
  });
});

els.serviceGrid.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-action]");
  if (!btn) return;
  const { action, service } = btn.dataset;
  if (action === "start") startService(service);
  if (action === "stop") stopService(service);
});

els.refreshBtn.addEventListener("click", refresh);

initTheme();
refresh();
setInterval(() => {
  if (polling) refresh();
}, 8000);

document.addEventListener("visibilitychange", () => {
  polling = !document.hidden;
  if (polling) refresh();
});
