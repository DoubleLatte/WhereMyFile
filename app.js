// WhereMyFile 화면 처리 (index.html의 #tool 창): 파일 고르기, 설정, 검사 실행, 결과 표시, 정리 목록 저장
(function () {
  "use strict";
  const { analyze, applyKeepRule, formatSize, pathOf, wasted, KEEP_RULES, KB, MB } = window.WMF;
  const $ = (id) => document.getElementById(id);

  let files = [];      // 고른 File 목록
  let result = null;   // 마지막 검사 결과
  let cancelled = false;

  // DOM 요소 만들기. 파일 이름은 textContent로만 넣음 (이름에 <script> 같은 글자가 있어도 안전)
  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const k of kids) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return n;
  }
  const sizeSpan = (b) => el("span", { class: "size" }, formatSize(b));

  // ----- 테마 선택: 그레이&골드 / 화이트&골드. 고른 값은 다음 방문에도 유지 -----
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    document.querySelectorAll("[data-theme-pick]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themePick === t)));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = t === "white" ? "#faf8f2" : "#1e1f22";
    try { localStorage.setItem("wmf-theme", t); } catch (e) { /* 저장소를 못 써도 화면은 바뀜 */ }
  }
  document.querySelectorAll("[data-theme-pick]").forEach((b) => b.addEventListener("click", () => applyTheme(b.dataset.themePick)));
  applyTheme(document.documentElement.getAttribute("data-theme") === "white" ? "white" : "gray");

  // ----- 설정 메뉴 채우기 -----
  for (const r of KEEP_RULES) $("keepRule").append(el("option", { value: r.id }, `${r.label} — ${r.hint}`));
  const CHUNKS = [16 * KB, 64 * KB, 256 * KB, 1 * MB, 4 * MB, 16 * MB, 64 * MB];
  for (const c of CHUNKS) {
    const o = el("option", { value: c }, formatSize(c) + (c === 1 * MB ? " (기본)" : ""));
    if (c === 1 * MB) o.selected = true;
    $("chunk").append(o);
  }

  // 실제 버튼으로 파일 선택기를 열어 키보드와 터치 모두 지원.
  document.querySelectorAll("[data-picker]").forEach((button) => {
    button.addEventListener("click", () => $(button.dataset.picker).click());
  });

  // ----- 파일 고르기 -----
  function setFiles(list) {
    files = list;
    result = null;
    $("result").hidden = true;
    $("empty").hidden = false;
    const total = files.reduce((s, f) => s + f.size, 0);
    $("picked").textContent = files.length
      ? `파일 ${files.length.toLocaleString()}개 (${formatSize(total)}) 를 골랐습니다.`
      : "아직 고른 파일이 없습니다.";
    $("start").disabled = files.length === 0;
  }
  $("pickDir").addEventListener("change", (e) => setFiles([...e.target.files]));
  $("pickFiles").addEventListener("change", (e) => setFiles([...e.target.files]));

  // 끌어다 놓기: 폴더를 놓으면 안쪽 파일까지 모두 읽음
  async function entryFiles(entry) {
    if (entry.isFile) {
      const f = await new Promise((ok, no) => entry.file(ok, no));
      f.relPath = entry.fullPath.replace(/^\//, ""); // webkitRelativePath처럼 "폴더/하위/이름"
      return [f];
    }
    const reader = entry.createReader(), out = [];
    for (;;) { // readEntries는 한 번에 최대 100개씩 주므로 빌 때까지 반복
      const batch = await new Promise((ok, no) => reader.readEntries(ok, no));
      if (!batch.length) break;
      for (const e of batch) out.push(...(await entryFiles(e)));
    }
    return out;
  }
  // 페이지 어디에 놓아도 받음: 끄는 동안 화면 전체에 안내를 띄우고, 놓으면 검사 도구로 이동해 바로 검사
  const overlay = el("div", { class: "drop-overlay", "aria-hidden": "true" },
    el("p", { class: "drop-overlay__text" }, "여기에 놓으면 바로 검사합니다"));
  overlay.hidden = true;
  document.body.append(overlay);
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  let depth = 0; // dragenter/leave가 자식 요소마다 오가므로 깊이로 셈
  const hideOverlay = () => { depth = 0; overlay.hidden = true; $("drop").classList.remove("over"); };
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.hidden = false;
    $("drop").classList.add("over");
  });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); }); // 막지 않으면 브라우저가 파일을 새 탭에서 엶
  window.addEventListener("dragleave", (e) => { if (hasFiles(e) && --depth <= 0) hideOverlay(); });
  window.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hideOverlay();
    if (running) { $("picked").textContent = "검사 중에는 새 파일을 받을 수 없습니다. 끝난 뒤 다시 놓아 주세요."; return; }
    $("app").scrollIntoView({ behavior: "smooth", block: "start" });
    const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    let list;
    if (entries.length) {
      $("picked").textContent = "파일 목록을 읽는 중...";
      list = [];
      for (const en of entries) list.push(...(await entryFiles(en)));
    } else {
      list = [...e.dataTransfer.files];
    }
    setFiles(list);
    if (files.length) $("start").click(); // 무심코 끌어다 놓는 사용자를 위해 바로 검사 (파일은 읽기만 함)
  });

  // ----- 검사 -----
  let running = false;
  $("start").addEventListener("click", async () => {
    if (running) return;
    running = true;
    cancelled = false;
    $("start").disabled = true;
    $("cancel").hidden = false;
    $("progressWrap").hidden = false;
    const startedAt = new Date();
    try {
      result = await analyze(files, {
        chunk: Number($("chunk").value),
        keepRule: $("keepRule").value,
        recursive: $("recursive").checked,
        isCancelled: () => cancelled,
        onProgress: (done, total) => {
          const p = total ? Math.round((done / total) * 100) : 100;
          $("progress").value = p;
          $("progressText").textContent = `${p}% (${formatSize(done)} / ${formatSize(total)})`;
        },
      });
      const p2 = (n) => String(n).padStart(2, "0"); // C++판과 같은 "2026-11-14 14:00:36" 형식
      result.scannedAt = `${startedAt.getFullYear()}-${p2(startedAt.getMonth() + 1)}-${p2(startedAt.getDate())} ${p2(startedAt.getHours())}:${p2(startedAt.getMinutes())}:${p2(startedAt.getSeconds())}`;
      render();
    } catch (err) {
      $("progressText").textContent = cancelled ? "검사를 취소했습니다." : `오류: ${err.message}`;
    } finally {
      running = false;
      $("start").disabled = files.length === 0;
      $("cancel").hidden = true;
      if (!cancelled) $("progressWrap").hidden = true;
    }
  });
  $("cancel").addEventListener("click", () => { cancelled = true; });

  // 남길 파일 기준은 다시 검사하지 않고 지금 결과에 바로 적용 (C++과 같음)
  $("keepRule").addEventListener("change", () => {
    if (!result) return;
    applyKeepRule(result.groups, $("keepRule").value);
    render();
  });

  // ----- 결과 표시 -----
  function render() {
    const s = result.stats;
    $("empty").hidden = true;
    $("result").hidden = false;
    $("headline").replaceChildren(
      s.groups
        ? el("span", {}, `똑같은 파일 묶음 ${s.groups}개, 정리하면 `, sizeSpan(s.saved), " 확보")
        : "똑같은 파일이 없습니다."
    );

    const stat = (k, v) => el("div", {}, el("dt", {}, k), el("dd", {}, v));
    $("stats").replaceChildren(
      stat("검사 일시", result.scannedAt),
      stat("총 파일 수", s.totalFiles.toLocaleString()),
      stat("내용 비교한 파일 수", s.candidateFiles.toLocaleString()),
      stat("중복 그룹", s.groups.toLocaleString()),
      stat("중복 사본 수", s.copies.toLocaleString()),
      stat("잠재 절약 용량", el("span", {}, sizeSpan(s.saved), el("span", { class: "stats__sub" }, ` (${s.saved.toLocaleString()} 바이트)`))),
      stat("청크(버퍼) 크기", sizeSpan(s.chunk)),
      stat("실제 읽은 양", sizeSpan(s.bytesRead)),
      stat("검사 시간", `${s.seconds.toFixed(3)}초`)
    );

    // 경고·오류
    const items = [
      ...result.errors.map((m) => el("li", { class: "err" }, `[오류] ${m}`)),
      ...result.warnings.map((m) => el("li", { class: "warn" }, `[경고] ${m}`)),
    ];
    if (result.excludedHidden) items.push(el("li", {}, `숨김·시스템 파일 ${result.excludedHidden}개는 검사에서 뺐습니다.`));
    if (result.excludedSub) items.push(el("li", {}, `하위 폴더 파일 ${result.excludedSub}개는 검사에서 뺐습니다.`));
    $("issues").replaceChildren(items.length ? el("div", { class: "issues" }, el("strong", {}, "알림"), el("ul", {}, ...items)) : "");

    $("groups").replaceChildren(...result.groups.map(groupView));
  }

  function groupView(g, gi) {
    const name = `keep-${gi}`;
    const list = el("ul", { class: "files" }, ...g.map((f, i) => {
      const radio = el("input", { type: "radio", name });
      radio.checked = i === 0;
      radio.addEventListener("change", () => { // 고른 파일을 맨 앞(남길 파일)으로
        g.unshift(...g.splice(i, 1));
        $("groups").children[gi].replaceWith(groupView(g, gi));
        $("groups").children[gi].open = true;
      });
      // 줄 전체가 label이라 휴대폰에서 작은 동그라미가 아니라 줄 어디를 눌러도 선택됨
      return el("li", { class: i === 0 ? "keep" : "" }, el("label", { class: "files__row" },
        radio,
        el("span", { class: "path" }, el("span", { class: i === 0 ? "tag keep" : "tag copy" }, i === 0 ? "남길 파일" : "사본"), pathOf(f)),
        el("span", { class: "meta" }, new Date(f.lastModified).toLocaleString("ko-KR"))));
    }));
    return el("details", { class: "group" },
      el("summary", {}, el("b", {}, `그룹 ${gi + 1}`), sizeSpan(g[0].size), ` × ${g.length}개 · 낭비 `, sizeSpan(wasted(g)), el("span", { class: "group__name" }, g[0].name)),
      list);
  }

  // ----- 정리 목록 저장: 사본 목록을 텍스트로 내려받음 (브라우저는 파일을 직접 지울 수 없음) -----
  $("save").addEventListener("click", () => {
    const s = result.stats, out = [];
    out.push("WhereMyFile 정리 목록", `검사 일시: ${result.scannedAt}`,
      `중복 그룹: ${s.groups} / 사본: ${s.copies} / 잠재 절약 용량: ${formatSize(s.saved)} (${s.saved} 바이트)`, "");
    result.groups.forEach((g, gi) => {
      out.push(`[그룹 ${gi + 1}] 크기 ${formatSize(g[0].size)}, ${g.length}개`);
      g.forEach((f, i) => out.push(`  ${i === 0 ? "* 남길 파일" : "- 사본    "}  ${pathOf(f)}`));
      out.push("");
    });
    const blob = new Blob(["﻿" + out.join("\r\n")], { type: "text/plain;charset=utf-8" }); // BOM: 메모장 한글 깨짐 방지
    const a = el("a", { href: URL.createObjectURL(blob), download: "WhereMyFile_정리목록.txt" });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
})();
