export const $ = (id) => document.getElementById(id);
export function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
export function toast(message) {
  $("toast").textContent = message;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    $("toast").textContent = "";
  }, 5000);
}
export function connect(onState, onConnection) {
  let ws,
    current,
    ready = false,
    stopped = false,
    attempts = 0,
    timer,
    count;
  const pending = new Map();
  function disconnected() {
    ready = false;
    onConnection(false);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("连接中断"));
    }
    pending.clear();
  }
  function open() {
    const token = sessionStorage.getItem("adminToken");
    ws = new WebSocket(
      (location.protocol === "https:" ? "wss://" : "ws://") +
        location.host +
        (token ? "?token=" + encodeURIComponent(token) : ""),
    );
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.state) {
        current = msg.state;
        ready = true;
        attempts = 0;
        onConnection(true);
        onState(msg);
      }
      if (msg.count !== undefined) count = msg.count;
      if (count !== undefined) {
        const connection = $("connection");
        if (connection) connection.textContent = "在线 " + count;
      }
      const request = pending.get(msg.requestId);
      if (request) {
        clearTimeout(request.timer);
        pending.delete(msg.requestId);
        if (msg.type === "error") request.reject(new Error(msg.message));
        else request.resolve(msg);
      } else if (msg.type === "error") toast(msg.message);
    };
    ws.onclose = () => {
      disconnected();
      if (!stopped)
        timer = setTimeout(open, Math.min(1000 * 2 ** attempts++, 15000));
    };
    ws.onerror = () => ws.close();
  }
  open();
  window.addEventListener("pagehide", () => {
    stopped = true;
    clearTimeout(timer);
    ws.close();
  });
  return {
    send(type, data = {}) {
      if (!ready || ws.readyState !== WebSocket.OPEN)
        return Promise.reject(new Error("连接中断"));
      const requestId = Array.from(
        crypto.getRandomValues(new Uint8Array(16)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          ready = false;
          onConnection(false);
          ws.close();
          reject(new Error("操作超时，正在同步"));
        }, 10000);
        pending.set(requestId, { resolve, reject, timer: timeout });
        ws.send(
          JSON.stringify({
            ...data,
            type,
            requestId,
            revision: current.revision,
            sessionId: current.currentSession,
          }),
        );
      });
    },
  };
}
export function dialog(title, html, acceptLabel) {
  if (document.querySelector("dialog[open]")) return Promise.resolve(false);
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const el = document.createElement("dialog");
    el.innerHTML =
      '<form method="dialog"><h2>' +
      escapeHtml(title) +
      '</h2><div class="dialog-body">' +
      html +
      '</div><div class="actions"><button value="cancel">关闭</button>' +
      (acceptLabel
        ? '<button class="primary" value="accept">' +
          escapeHtml(acceptLabel) +
          "</button>"
        : "") +
      "</div></form>";
    el.addEventListener(
      "close",
      () => {
        resolve(el.returnValue === "accept");
        el.remove();
        previous?.focus();
      },
      { once: true },
    );
    document.body.append(el);
    el.showModal();
  });
}
export async function exportResults(format) {
  const response = await fetch("/api/export?format=" + format);
  if (!response.ok) throw new Error("导出失败");
  const filename = (response.headers.get("Content-Disposition") || "").split(
    "UTF-8''",
  )[1];
  download(
    await response.blob(),
    filename ? decodeURIComponent(filename) : "抽奖结果." + format,
  );
}
export function download(blob, filename) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function bindExports() {
  document.querySelectorAll("[data-export]").forEach((button) =>
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await exportResults(button.dataset.export);
      } catch (error) {
        toast(error.message);
      } finally {
        button.disabled = false;
      }
    }),
  );
}
