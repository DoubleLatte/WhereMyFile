// 분석 로직 자동 테스트 (Node 20+): node web/test/analyzer.test.js
// 1주차 C++ 테스트 표와 같은 경우를 확인하고, 실제 테스트 폴더가 주어지면 C++ 결과와 숫자를 비교한다.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const WMF = require("../analyzer.js");

const mk = (relPath, data, lastModified = 0) => {
  const f = new File([data], path.basename(relPath), { lastModified });
  f.relPath = relPath; // 브라우저의 webkitRelativePath 대신
  return f;
};
const names = (g) => g.map((f) => f.relPath);

(async () => {
  // 1) 이름 다르고 내용 같음 / 크기 같고 내용 다름 / 빈 파일 2개 / 크기 다름
  let r = await WMF.analyze([
    mk("t/a.txt", "hello"), mk("t/sub/사본.txt", "hello"), mk("t/b.txt", "world"),
    mk("t/c.txt", "different size"), mk("t/e1.bin", ""), mk("t/e2.bin", ""),
  ]);
  assert.strictEqual(r.stats.groups, 2, "그룹 2개(hello, 빈 파일)");
  assert.deepStrictEqual(names(r.groups[0]).sort(), ["t/a.txt", "t/sub/사본.txt"]);
  assert.strictEqual(r.stats.candidateFiles, 5, "크기 5짜리 3개 + 빈 파일 2개");
  assert.strictEqual(r.stats.saved, 5);

  // 2) 여러 청크에 걸친 큰 파일, 마지막 1바이트만 다름, 청크 크기가 달라도 결과 같음
  const big = new Uint8Array(3 * 1024 * 1024 + 123);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7919) & 255;
  const big3 = big.slice(); big3[big3.length - 1] ^= 1;
  for (const chunk of [64 * 1024, 1024 * 1024, 4 * 1024 * 1024]) {
    r = await WMF.analyze([mk("t/big1.bin", big), mk("t/sub/big2.bin", big), mk("t/big3.bin", big3)], { chunk });
    assert.strictEqual(r.stats.groups, 1, `청크 ${chunk}`);
    assert.deepStrictEqual(names(r.groups[0]).sort(), ["t/big1.bin", "t/sub/big2.bin"]);
  }

  // 3) 남길 파일 기준
  const files = [mk("k/고양이 (1) - 복사본.jpg", "meow", 200), mk("k/하위/고양이.jpg", "meow", 100)];
  r = await WMF.analyze(files, { keepRule: "shortest" });
  assert.strictEqual(r.groups[0][0].relPath, "k/하위/고양이.jpg", "이름 짧은 원본이 남김");
  r = await WMF.analyze(files, { keepRule: "path" });
  assert.strictEqual(r.groups[0][0].relPath, "k/고양이 (1) - 복사본.jpg");
  r = await WMF.analyze(files, { keepRule: "newest" });
  assert.strictEqual(r.groups[0][0].lastModified, 200);

  // 4) 하위 폴더 끔, 숨김 이름 제외
  r = await WMF.analyze(files, { recursive: false });
  assert.strictEqual(r.stats.groups, 0); assert.strictEqual(r.excludedSub, 1);
  r = await WMF.analyze([mk("h/desktop.ini", "x"), mk("h/s/desktop.ini", "x"), mk("h/.git/HEAD", "y"), mk("h/s/.git/HEAD", "y")]);
  assert.strictEqual(r.stats.groups, 0); assert.strictEqual(r.excludedHidden, 4);

  // 5) 낭비 용량 큰 그룹이 먼저
  r = await WMF.analyze([mk("s/a", "1"), mk("s/b", "1"), mk("s/c", "333"), mk("s/d", "333"), mk("s/e", "333")]);
  assert.strictEqual(r.groups[0][0].size, 3);

  // 6) formatSize는 C++와 같은 표기
  assert.strictEqual(WMF.formatSize(5), "5 B");
  assert.strictEqual(WMF.formatSize(3145856), "3.00 MB");
  assert.strictEqual(WMF.formatSize(1308134343), "1.22 GB");

  // 7) C++과 같은 테스트 폴더 비교 (인자로 폴더를 주면). C++ 결과: 그룹 3, 절약 3145856 바이트
  const dir = process.argv[2];
  if (dir) {
    const walk = (d, rel) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name), rel + "/" + e.name)
                      : [mk(rel + "/" + e.name, fs.readFileSync(path.join(d, e.name)))]);
    r = await WMF.analyze(walk(dir, path.basename(dir)));
    console.log(`테스트 폴더: 파일 ${r.stats.totalFiles}, 비교 ${r.stats.candidateFiles}, 그룹 ${r.stats.groups}, 사본 ${r.stats.copies}, 절약 ${r.stats.saved} 바이트`);
  }
  console.log("analyzer OK");
})().catch((e) => { console.error(e); process.exit(1); });
