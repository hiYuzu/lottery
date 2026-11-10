import {
  $,
  escapeHtml as esc,
  toast,
  connect,
  dialog,
  bindExports,
} from "./common.js";
if (!sessionStorage.getItem("adminToken")) location.replace("/login.html");
let state,
  online = false,
  busy = false,
  draft = [],
  dirty = false,
  draftRevision,
  importRows = [],
  previewRevision;
const drafts = new Map();
function remember() {
  if (state && dirty)
    drafts.set(state.currentSession, {
      draft: structuredClone(draft),
      revision: draftRevision,
    });
}
const socket = connect(
  (msg) => {
    if (!msg.admin) {
      sessionStorage.removeItem("adminToken");
      location.replace("/login.html");
      return;
    }
    const changed = state?.currentSession !== msg.state.currentSession;
    if (changed) remember();
    state = msg.state;
    if (changed) {
      const saved = drafts.get(state.currentSession);
      dirty = !!saved;
      draft = saved?.draft || structuredClone(state.session.prizes);
      draftRevision = saved?.revision ?? state.revision;
      $("batch-input").value = "";
      importRows = [];
      $("import-preview").textContent = "";
      $("import").disabled = true;
      renderEditor();
    } else if (!dirty) {
      draft = structuredClone(state.session.prizes);
      draftRevision = state.revision;
      renderEditor();
    }
    if (previewRevision !== state.revision) $("import").disabled = true;
    render();
    if (changed) $("sessions").value = state.currentSession;
  },
  (connected) => {
    online = connected;
    $("connection").textContent = connected ? "在线" : "重连中";
    render();
  },
);
function renderEditor() {
  $("prize-editor").innerHTML = draft
    .map(
      (p, i) =>
        '<div class="prize-row" data-index="' +
        i +
        '"><label>奖项<input data-field="name" value="' +
        esc(p.name) +
        '" required maxlength="80"></label><label>总名额<input data-field="total" type="number" min="1" step="1" value="' +
        p.total +
        '" required></label><label>每轮<input data-field="perDraw" type="number" min="1" step="1" value="' +
        p.perDraw +
        '" required></label><label class="checkbox"><input data-field="isConsolation" type="checkbox" ' +
        (p.isConsolation ? "checked" : "") +
        '>阳光普照</label><div class="actions"><button type="button" draggable="true" data-drag>排序</button><button type="button" data-action="up" ' +
        (i === 0 ? "disabled" : "") +
        '>上移</button><button type="button" data-action="down" ' +
        (i === draft.length - 1 ? "disabled" : "") +
        '>下移</button><button type="button" data-action="delete">删除</button></div></div>',
    )
    .join("");
}
function render() {
  if (!state) return;
  const session = state.session;
  const previous = $("sessions").value;
  $("sessions").innerHTML = state.sessions
    .map(
      (s) =>
        '<option value="' +
        esc(s.key) +
        '">' +
        esc(s.name) +
        " · " +
        (s.mode === "rehearsal" ? "彩排" : "正式") +
        (s.status === "archived" ? " · 已归档" : "") +
        "</option>",
    )
    .join("");
  $("sessions").value = state.sessions.some((s) => s.key === previous)
    ? previous
    : state.currentSession;
  $("draft-status").textContent = dirty
    ? draftRevision === state.revision
      ? "未保存"
      : "未保存 · 状态已更新"
    : "已保存";
  const locked =
    !online || busy || !!session.activeRound || session.status === "archived";
  $("prize-editor").inert = busy;
  $("add-prize").disabled = busy;
  $("discard").disabled = busy;
  $("prize-editor")
    .querySelectorAll("input")
    .forEach((input) => {
      input.disabled = busy;
    });
  for (const key of [
    "save-prizes",
    "import",
    "undo",
    "reset",
    "archive-session",
  ])
    $(key).disabled = locked;
  $("import").disabled ||=
    !importRows.length || previewRevision !== state.revision;
  $("undo").disabled ||= !session.history.some((h) => !h.voidedAt);
  $("create-session").disabled = $("switch-session").disabled =
    !online || busy || !!session.activeRound;
  const selectedDept = $("dept-filter").value;
  $("dept-filter").innerHTML =
    '<option value="">全部</option>' +
    [...new Set(session.people.map((p) => p.dept))]
      .filter(Boolean)
      .map((dept) => "<option>" + esc(dept) + "</option>")
      .join("");
  $("dept-filter").value = selectedDept;
  renderPeople();
}
function renderPeople() {
  if (!state) return;
  const used = new Set(state.session.prizes.flatMap((p) => p.drawnIds));
  const query = $("search").value.trim().toLowerCase();
  const dept = $("dept-filter").value,
    status = $("status-filter").value;
  const people = state.session.people.filter(
    (p) =>
      (!query || (p.name + " " + p.id).toLowerCase().includes(query)) &&
      (!dept || p.dept === dept) &&
      (!status || used.has(p.id) === (status === "drawn")),
  );
  $("people").innerHTML = people
    .map(
      (p) =>
        '<div class="person-row"><span>' +
        esc(p.name) +
        "</span><span>" +
        esc(p.id) +
        "</span><span>" +
        esc(p.dept) +
        "</span><span>" +
        (used.has(p.id) ? "已中奖" : "未中奖") +
        '</span><button data-person="' +
        esc(p.id) +
        '" ' +
        (used.has(p.id) ||
        !online ||
        busy ||
        state.session.status === "archived" ||
        state.session.activeRound
          ? "disabled"
          : "") +
        ">删除</button></div>",
    )
    .join("");
}
async function command(type, data = {}) {
  busy = true;
  render();
  try {
    return await socket.send(type, data);
  } finally {
    busy = false;
    render();
  }
}
function markDirty() {
  dirty = true;
  remember();
  render();
}
let dragIndex = null;
$("prize-editor").addEventListener("dragstart", (event) => {
  if (!event.target.matches("[data-drag]") || busy) return;
  dragIndex = Number(event.target.closest("[data-index]").dataset.index);
  event.dataTransfer.setData("text/plain", String(dragIndex));
  event.dataTransfer.effectAllowed = "move";
});
$("prize-editor").addEventListener("dragover", (event) => {
  if (dragIndex !== null) event.preventDefault();
});
$("prize-editor").addEventListener("drop", (event) => {
  const row = event.target.closest("[data-index]");
  if (dragIndex === null || !row || busy) return;
  event.preventDefault();
  const target = Number(row.dataset.index);
  const [prize] = draft.splice(dragIndex, 1);
  draft.splice(target, 0, prize);
  dragIndex = null;
  markDirty();
  renderEditor();
});
$("prize-editor").addEventListener("dragend", () => {
  dragIndex = null;
});
$("prize-editor").oninput = (event) => {
  const row = event.target.closest("[data-index]"),
    field = event.target.dataset.field;
  if (!row || !field) return;
  draft[Number(row.dataset.index)][field] =
    field === "isConsolation"
      ? event.target.checked
      : ["total", "perDraw"].includes(field)
        ? Number(event.target.value)
        : event.target.value;
  markDirty();
};
$("prize-editor").onclick = (event) => {
  const action = event.target.dataset.action,
    row = event.target.closest("[data-index]");
  if (!action || !row) return;
  const index = Number(row.dataset.index);
  if (action === "delete") {
    if (state.session.history.some((h) => h.prizeId === draft[index].id)) {
      toast("已开奖记录的奖项不可删除");
      return;
    }
    draft.splice(index, 1);
  } else {
    const target = action === "up" ? index - 1 : index + 1;
    [draft[index], draft[target]] = [draft[target], draft[index]];
  }
  markDirty();
  renderEditor();
};
$("add-prize").onclick = () => {
  draft.push({ name: "", total: 1, perDraw: 1, isConsolation: false });
  markDirty();
  renderEditor();
};
$("discard").onclick = async () => {
  if (dirty && !(await dialog("还原配置", "", "确认"))) return;
  dirty = false;
  drafts.delete(state.currentSession);
  draft = structuredClone(state.session.prizes);
  draftRevision = state.revision;
  renderEditor();
  render();
};
$("prize-form").onsubmit = async (event) => {
  event.preventDefault();
  if ($("save-prizes").disabled) return;
  if (draft.some((p) => p.perDraw > p.total)) {
    toast("每轮人数超过总名额");
    return;
  }
  const sessionId = state.currentSession;
  const revision = state.revision;
  if (
    dirty &&
    draftRevision !== revision &&
    !(await dialog("覆盖奖项配置", "", "确认"))
  )
    return;
  if (state.currentSession !== sessionId || state.revision !== revision) {
    toast("状态已更新，请重试");
    return;
  }
  try {
    const result = await command("updatePrizes", { prizes: draft });
    dirty = false;
    drafts.delete(sessionId);
    draft = structuredClone(result.state.session.prizes);
    draftRevision = result.state.revision;
    renderEditor();
    render();
  } catch (error) {
    toast(error.message);
  }
};
$("preview").onclick = () => {
  const seen = new Set(state.session.people.map((p) => p.id));
  const existingNames = new Set(state.session.people.map((p) => p.name));
  importRows = [];
  let duplicate = 0,
    invalid = 0;
  const rows = $("batch-input")
    .value.trim()
    .split(/\r?\n/)
    .filter((line) => line.trim());
  for (const line of rows) {
    const columns = line.split(/[,\t，]/).map((s) => s.trim());
    const [name, dept = "", suppliedId] = columns;
    if (!name || columns.length > 3 || /[<>]/.test(line)) {
      invalid++;
      continue;
    }
    const personId = suppliedId || name;
    if (seen.has(personId) || (!suppliedId && existingNames.has(name))) {
      duplicate++;
      continue;
    }
    seen.add(personId);
    existingNames.add(name);
    importRows.push({ id: personId, name, dept: dept.toUpperCase() });
  }
  previewRevision = state.revision;
  $("import-preview").innerHTML =
    "<p>新增 " +
    importRows.length +
    " · 重复 " +
    duplicate +
    " · 无效 " +
    invalid +
    "</p><table><thead><tr><th>姓名</th><th>地区</th><th>编号</th><th>普通奖</th><th>阳光普照</th></tr></thead><tbody>" +
    importRows
      .map(
        (p) =>
          "<tr><td>" +
          esc(p.name) +
          "</td><td>" +
          esc(p.dept) +
          "</td><td>" +
          esc(p.id) +
          "</td><td>" +
          (p.dept === "CN" ? "排除" : "参与") +
          "</td><td>参与</td></tr>",
      )
      .join("") +
    "</tbody></table>";
  render();
};
$("batch-input").oninput = () => {
  importRows = [];
  $("import").disabled = true;
  $("import-preview").textContent = "";
};
$("import").onclick = async () => {
  if ($("import").disabled) return;
  try {
    await command("updateNames", {
      people: [...state.session.people, ...importRows],
    });
    $("batch-input").value = "";
    $("import-preview").textContent = "";
    importRows = [];
    render();
  } catch (error) {
    toast(error.message);
  }
};
$("people").onclick = async (event) => {
  const personId = event.target.dataset.person;
  if (!personId) return;
  const sessionId = state.currentSession,
    revision = state.revision;
  const person = state.session.people.find((p) => p.id === personId);
  if (!(await dialog("删除人员", esc(person.name), "确认"))) return;
  if (state.currentSession !== sessionId || state.revision !== revision) {
    toast("状态已更新，请重试");
    return;
  }
  try {
    await command("updateNames", {
      people: state.session.people.filter((p) => p.id !== personId),
    });
  } catch (error) {
    toast(error.message);
  }
};
for (const key of ["search", "dept-filter", "status-filter"])
  $(key).addEventListener("input", renderPeople);
$("undo").onclick = async () => {
  const last = state.session.history.findLast((h) => !h.voidedAt);
  if (!last) return;
  const sessionId = state.currentSession;
  if (
    !(await dialog(
      "撤销",
      "<p>" +
        esc(last.prizeName) +
        "</p><p>" +
        last.winners.map(esc).join("、") +
        "</p><time>" +
        esc(last.time) +
        "</time>",
      "确认",
    ))
  )
    return;
  if (state.currentSession !== sessionId) {
    toast("活动已变更");
    return;
  }
  try {
    await command("undo", { historyId: last.id });
  } catch (error) {
    toast(error.message);
  }
};
for (const [button, type] of [
  ["reset", "reset"],
  ["archive-session", "archiveSession"],
])
  $(button).onclick = async () => {
    const sessionId = state.currentSession,
      revision = state.revision;
    if (
      !(await dialog(
        type === "reset" ? "归档并重置" : "归档",
        esc(state.session.name),
        "确认",
      ))
    )
      return;
    if (state.currentSession !== sessionId || state.revision !== revision) {
      toast("状态已更新，请重试");
      return;
    }
    try {
      await command(type);
    } catch (error) {
      toast(error.message);
    }
  };
$("create-session").onclick = async () => {
  try {
    await command("createSession", {
      name: $("session-name").value,
      mode: $("session-mode").value,
    });
    $("sessions").value = state.currentSession;
    $("session-name").value = "";
  } catch (error) {
    toast(error.message);
  }
};
$("switch-session").onclick = async () => {
  try {
    await command("switchSession", { target: $("sessions").value });
    $("sessions").value = state.currentSession;
  } catch (error) {
    toast(error.message);
  }
};
$("logout").onclick = () => {
  sessionStorage.removeItem("adminToken");
  location.href = "/login.html";
};
window.addEventListener("beforeunload", (event) => {
  if (dirty || drafts.size) {
    event.preventDefault();
    event.returnValue = "";
  }
});
bindExports();
