// WhereMyFile 분석 로직 — 1주차 C++(duplicate.cpp, main.cpp)의 절차를 그대로 옮김
// 크기별 분류 → 같은 크기만 청크 단위 스트리밍 바이트 비교 → 정확 중복 그룹 → 낭비 용량순 정렬 → 남길 파일 기준 적용
// 브라우저(<script>)와 Node(require) 양쪽에서 쓸 수 있게 전역 WMF로 내보냄
(function (root) {
  "use strict";

  const KB = 1024, MB = 1024 * KB;
  const DEFAULT_CHUNK = 1 * MB;

  // 바이트 수를 B/KB/MB/GB 문자열로 (C++ formatSize와 같은 규칙: 1024 단위, 소수 둘째 자리)
  function formatSize(bytes) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let v = bytes, u = 0;
    while (v >= 1024 && u < 4) { v /= 1024; u++; }
    return u === 0 ? `${bytes} B` : `${v.toFixed(2)} ${units[u]}`;
  }

  // 파일의 표시 경로: 폴더 선택이면 "폴더/하위/이름", 파일 선택이면 이름만
  function pathOf(file) { return file.webkitRelativePath || file.relPath || file.name; }

  function wasted(g) { return g[0].size * (g.length - 1); }

  // 두 파일을 chunk 크기씩 잘라 읽어 바이트 비교 (파일 전체를 메모리에 올리지 않음)
  // 반환: true(같음) / false(다름). 읽기 실패는 예외로 던짐.
  async function filesEqual(a, b, chunk, stats, isCancelled) {
    if (a.size !== b.size) return false;
    for (let off = 0; off < a.size; off += chunk) {
      if (isCancelled && isCancelled()) throw new Error("취소됨");
      const end = Math.min(off + chunk, a.size);
      const [x, y] = await Promise.all([a.slice(off, end).arrayBuffer(), b.slice(off, end).arrayBuffer()]);
      stats.bytesRead += x.byteLength + y.byteLength;
      if (x.byteLength !== y.byteLength) return false;
      const ua = new Uint8Array(x), ub = new Uint8Array(y);
      for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
      if (stats.onProgress) stats.onProgress(x.byteLength);
    }
    return true; // 빈 파일끼리도 같음
  }

  // 남길 파일 기준 (C++ kKeepRules와 같은 순서)
  const KEEP_RULES = [
    { id: "shortest", label: "이름이 가장 짧은 파일", hint: "\"복사본\", \"(1)\" 같은 게 안 붙은 원본을 남김" },
    { id: "oldest", label: "가장 오래된 파일", hint: "수정한 날짜가 가장 이른 것" },
    { id: "newest", label: "가장 최근 파일", hint: "수정한 날짜가 가장 늦은 것" },
    { id: "path", label: "경로 순서", hint: "폴더·이름 가나다순으로 첫 번째" },
  ];

  const cmpPath = (a, b) => (pathOf(a) < pathOf(b) ? -1 : pathOf(a) > pathOf(b) ? 1 : 0);

  // 각 그룹의 파일 순서를 기준에 맞게 정렬 (맨 앞 = 남길 파일). 안정 정렬(Array.sort는 ES2019부터 안정)
  function applyKeepRule(groups, rule) {
    for (const g of groups) {
      g.sort((a, b) => {
        switch (rule) {
          case "shortest": return a.name.length - b.name.length || cmpPath(a, b);
          case "oldest": return a.lastModified - b.lastModified;
          case "newest": return b.lastModified - a.lastModified;
          default: return cmpPath(a, b);
        }
      });
    }
  }

  // 숨김·시스템 파일 제외 (C++는 파일 속성으로 거르지만 브라우저는 속성을 못 읽어 이름으로 거름)
  // shortcut: 이름 규칙만 봄, 속성으로 숨김 처리된 일반 이름 파일은 못 거름
  function isHiddenName(file) {
    const parts = pathOf(file).split("/");
    return parts.some((p) => p.startsWith(".")) || /^(desktop\.ini|thumbs\.db)$/i.test(file.name);
  }

  // 본 분석. files: File 배열. opts: { chunk, keepRule, recursive, onProgress(done,total), isCancelled }
  async function analyze(files, opts = {}) {
    const chunk = opts.chunk || DEFAULT_CHUNK;
    const t0 = Date.now();
    const result = { groups: [], warnings: [], errors: [], excludedHidden: 0, excludedSub: 0 };

    let list = files.filter((f) => {
      if (isHiddenName(f)) { result.excludedHidden++; return false; }
      // 하위 폴더 끔: "선택폴더/파일" 깊이(2단계)까지만
      if (opts.recursive === false && pathOf(f).split("/").length > 2) { result.excludedSub++; return false; }
      return true;
    });

    const bySize = new Map();
    for (const f of list) {
      if (!bySize.has(f.size)) bySize.set(f.size, []);
      bySize.get(f.size).push(f);
    }

    // 진행률: 같은 크기 후보들을 대표와 한 번씩 비교한다고 보고 총량 추정
    let total = 0, done = 0;
    for (const [size, g] of bySize) if (g.length > 1) total += size * (g.length - 1);
    const stats = {
      bytesRead: 0,
      onProgress: (n) => { done += n; if (opts.onProgress) opts.onProgress(Math.min(done, total), total); },
    };

    let candidate = 0;
    const sizes = [...bySize.keys()].sort((a, b) => a - b);
    for (const size of sizes) {
      const same = bySize.get(size);
      if (same.length < 2) continue; // 크기가 유일하면 비교 제외
      candidate += same.length;
      const classes = []; // 각 그룹의 [0]이 대표
      for (const f of same) {
        // 읽을 수 없는 파일이 대표가 되지 않게 먼저 확인 (C++와 같은 처리. 선택 뒤 바뀐 파일도 여기서 걸림)
        try { if (size > 0) await f.slice(0, 1).arrayBuffer(); }
        catch { result.errors.push(`읽기 실패(선택 후 바뀌었거나 접근 불가): ${pathOf(f)}`); continue; }
        let placed = false, failed = false;
        for (const c of classes) {
          try {
            if (await filesEqual(c[0], f, chunk, stats, opts.isCancelled)) { c.push(f); placed = true; break; }
          } catch (e) {
            if (opts.isCancelled && opts.isCancelled()) throw e;
            failed = true; // 다른 그룹과는 계속 비교
            result.errors.push(`비교 중 읽기 실패: ${pathOf(c[0])} / ${pathOf(f)}`);
          }
        }
        if (!placed && !failed) classes.push([f]);
      }
      for (const c of classes) if (c.length >= 2) result.groups.push(c);
    }

    // 낭비 용량 큰 그룹부터 (안정 정렬)
    result.groups.sort((a, b) => wasted(b) - wasted(a));
    applyKeepRule(result.groups, opts.keepRule || "shortest");

    result.stats = {
      totalFiles: list.length,
      candidateFiles: candidate,
      groups: result.groups.length,
      copies: result.groups.reduce((s, g) => s + g.length - 1, 0),
      saved: result.groups.reduce((s, g) => s + wasted(g), 0),
      bytesRead: stats.bytesRead,
      chunk,
      seconds: (Date.now() - t0) / 1000,
    };
    return result;
  }

  const api = { analyze, filesEqual, applyKeepRule, formatSize, pathOf, wasted, KEEP_RULES, DEFAULT_CHUNK, KB, MB };
  root.WMF = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
