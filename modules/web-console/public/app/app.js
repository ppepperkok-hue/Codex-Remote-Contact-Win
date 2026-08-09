const $ = (id) => document.getElementById(id);
const servicesEl = $("services");
const statusChip = $("status-chip");
const hostLabel = $("host-label");
const macList = $("mac-list");
const qqStatus = $("qq-status");
const remoteRow = $("remote-row");
const remoteLink = $("remote-link");

let toastTimer = null;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isLoopback() {
  const h = location.hostname;
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

function hostText() {
  const h = location.hostname;
  if (isLoopback()) return `本机 · ${location.port || 3789}`;
  return `${h} · ${location.port || 3789}`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  if (res.status === 401) {
    toast("访问密码已失效，请重新输入");
    setTimeout(() => location.reload(), 1200);
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function serviceCard(svc) {
  const state = svc.running ? "on" : "off";
  const actions = [];
  if (svc.webui) {
    actions.push(`<a class="btn ghost small" href="${escapeHtml(svc.webui)}" target="_blank" rel="noopener">WebUI</a>`);
  }
  if (svc.self) {
    // hub 自身：只给链接
  } else if (svc.running) {
    actions.push(`<button class="btn danger small" data-action="stop" data-id="${escapeHtml(svc.id)}">停止</button>`);
  } else {
    actions.push(`<button class="btn small" data-action="start" data-id="${escapeHtml(svc.id)}">启动</button>`);
  }
  return `
    <div class="card service">
      <span class="dot ${state}"></span>
      <div class="info">
        <div class="name">${escapeHtml(svc.label)}</div>
        <div class="role">${escapeHtml(svc.role || "")}</div>
      </div>
      <div class="actions">${actions.join("")}</div>
    </div>`;
}

async function refresh() {
  try {
    const [servicesData, stateData, wakeData, remoteData] = await Promise.all([
      api("/api/services"),
      api("/api/state"),
      api("/api/wake/info").catch(() => null),
      api("/api/remote-url").catch(() => null)
    ]);
    const anyUp = servicesData.services.some((s) => s.running);
    statusChip.textContent = anyUp ? "在线" : "离线";
    statusChip.className = "chip " + (anyUp ? "on" : "off");
    servicesEl.innerHTML = servicesData.services.map(serviceCard).join("");
    if (stateData.qq) {
      qqStatus.textContent = stateData.channels?.qq ? "已开启" : "已关闭";
    }
    if (wakeData) {
      macList.textContent = wakeData.macs?.length
        ? wakeData.macs.join("  /  ")
        : "未配置（data/wake.json）";
    } else {
      macList.textContent = "—";
    }
    if (remoteData?.url) {
      remoteRow.style.display = "flex";
      remoteLink.href = remoteData.url;
    } else {
      remoteRow.style.display = "none";
    }
  } catch (error) {
    if (error.message === "unauthorized") return;
    statusChip.textContent = "离线";
    statusChip.className = "chip off";
    servicesEl.innerHTML = `<div class="skeleton">无法连接服务：${escapeHtml(error.message)}</div>`;
  }
}

servicesEl.addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;
  btn.disabled = true;
  try {
    const result = await api("/api/services/" + action, {
      method: "POST",
      body: JSON.stringify({ service: id })
    });
    toast(result.ok ? (action === "start" ? "已发送启动指令" : "已发送停止指令") : (result.error || "操作失败"));
  } catch (error) {
    toast(error.message === "unauthorized" ? "" : "操作失败：" + error.message);
  } finally {
    btn.disabled = false;
    refresh();
  }
});

$("wake-btn").addEventListener("click", async (event) => {
  const btn = event.currentTarget;
  btn.disabled = true;
  try {
    const result = await api("/api/wake", { method: "POST", body: "{}" });
    if (result.ok) toast("唤醒包已发送：" + result.sent.join(" / "));
    else toast(result.error || "唤醒包发送失败");
  } catch (error) {
    toast(error.message === "unauthorized" ? "" : "唤醒失败：" + error.message);
  } finally {
    btn.disabled = false;
  }
});

hostLabel.textContent = hostText();
refresh();
setInterval(refresh, 8000);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/app/sw.js").catch(() => {});
}
