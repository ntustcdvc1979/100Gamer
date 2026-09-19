/* ============================================================
   QR code 產生器（byte mode，錯誤更正等級 M，版本 1–10）

   為什麼自己寫：投影幕上的 QR 是活動能不能開始的關鍵，
   不想在現場依賴任何 CDN 或外部圖片服務。
   60 個字元的網址大約落在版本 5，額度綽綽有餘。

   從 ntustcdvc1979/orientation 的 assets/qrcode.js 搬過來，改成 ESM 匯出。
   ============================================================ */

  "use strict";

  /* ---------- GF(256) ---------- */
  var EXP = new Array(512), LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) { x ^= 0x11D; }
    }
    for (var j = 255; j < 512; j++) { EXP[j] = EXP[j - 255]; }
  })();

  function mul(a, b) { return (a && b) ? EXP[LOG[a] + LOG[b]] : 0; }

  /** 產生器多項式，係數由低次到高次 */
  function genPoly(n) {
    var g = [1];
    for (var i = 0; i < n; i++) {
      var ng = new Array(g.length + 1);
      for (var k = 0; k < ng.length; k++) { ng[k] = 0; }
      for (var j = 0; j < g.length; j++) {
        ng[j] ^= mul(g[j], EXP[i]);
        ng[j + 1] ^= g[j];
      }
      g = ng;
    }
    return g;
  }

  /** 對 data 算 n 個更正碼 */
  function ecc(data, n) {
    var g = genPoly(n), gd = [], i, j;
    for (i = n; i >= 0; i--) { gd.push(g[i]); }   // 改成由高次到低次

    var res = data.slice();
    for (i = 0; i < n; i++) { res.push(0); }

    for (i = 0; i < data.length; i++) {
      var coef = res[i];
      if (!coef) { continue; }
      for (j = 1; j < gd.length; j++) { res[i + j] ^= mul(gd[j], coef); }
    }
    return res.slice(data.length);
  }

  /* ---------- 版本表（等級 M）----------
     [每塊更正碼數, 第一組塊數, 第一組資料碼數, 第二組塊數, 第二組資料碼數] */
  var VERSIONS = {
    1:  [10, 1, 16, 0, 0],
    2:  [16, 1, 28, 0, 0],
    3:  [26, 1, 44, 0, 0],
    4:  [18, 2, 32, 0, 0],
    5:  [24, 2, 43, 0, 0],
    6:  [16, 4, 27, 0, 0],
    7:  [18, 4, 31, 0, 0],
    8:  [22, 2, 38, 2, 39],
    9:  [22, 3, 36, 2, 37],
    10: [26, 4, 43, 1, 44]
  };

  var ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };

  function dataCodewords(v) {
    var t = VERSIONS[v];
    return t[1] * t[2] + t[3] * t[4];
  }

  /** byte mode 能塞幾個 byte：扣掉 4 bits 模式 + 8/16 bits 長度 */
  function capacity(v) {
    var headerBits = 4 + (v < 10 ? 8 : 16);
    return Math.floor((dataCodewords(v) * 8 - headerBits) / 8);
  }

  function utf8(text) {
    var out = [], s = unescape(encodeURIComponent(text));
    for (var i = 0; i < s.length; i++) { out.push(s.charCodeAt(i)); }
    return out;
  }

  /* ---------- 編碼 ---------- */
  function encode(text) {
    var bytes = utf8(text), v = 0;
    for (var i = 1; i <= 10; i++) {
      if (bytes.length <= capacity(i)) { v = i; break; }
    }
    if (!v) { throw new Error("QR: 內容太長（上限 " + capacity(10) + " bytes）"); }

    var bits = [];
    function push(value, len) {
      for (var b = len - 1; b >= 0; b--) { bits.push((value >>> b) & 1); }
    }

    push(0x4, 4);                                  // byte mode
    push(bytes.length, v < 10 ? 8 : 16);
    bytes.forEach(function (b) { push(b, 8); });

    var totalBits = dataCodewords(v) * 8;
    for (var t = 0; t < 4 && bits.length < totalBits; t++) { bits.push(0); }
    while (bits.length % 8) { bits.push(0); }

    var words = [];
    for (var k = 0; k < bits.length; k += 8) {
      var byteVal = 0;
      for (var m = 0; m < 8; m++) { byteVal = (byteVal << 1) | bits[k + m]; }
      words.push(byteVal);
    }
    var pad = [0xEC, 0x11], p = 0;
    while (words.length < dataCodewords(v)) { words.push(pad[p++ % 2]); }

    /* 分塊、算更正碼、交錯 */
    var spec = VERSIONS[v], ecLen = spec[0];
    var blocks = [], at = 0, b;
    for (b = 0; b < spec[1]; b++) { blocks.push(words.slice(at, at += spec[2])); }
    for (b = 0; b < spec[3]; b++) { blocks.push(words.slice(at, at += spec[4])); }

    var ecBlocks = blocks.map(function (blk) { return ecc(blk, ecLen); });
    var maxLen = Math.max.apply(null, blocks.map(function (x) { return x.length; }));

    var out = [], idx, bi;
    for (idx = 0; idx < maxLen; idx++) {
      for (bi = 0; bi < blocks.length; bi++) {
        if (idx < blocks[bi].length) { out.push(blocks[bi][idx]); }
      }
    }
    for (idx = 0; idx < ecLen; idx++) {
      for (bi = 0; bi < ecBlocks.length; bi++) { out.push(ecBlocks[bi][idx]); }
    }

    return { version: v, codewords: out };
  }

  /* ---------- 排版 ---------- */
  function build(version, codewords) {
    var size = version * 4 + 17;
    var mod = [], fixed = [], y, x;

    for (y = 0; y < size; y++) {
      mod.push(new Array(size).fill(0));
      fixed.push(new Array(size).fill(false));
    }

    function set(cx, cy, dark) {
      mod[cy][cx] = dark ? 1 : 0;
      fixed[cy][cx] = true;
    }

    /* 定位圖案 + 分隔線 */
    function finder(ox, oy) {
      for (var dy = -1; dy <= 7; dy++) {
        for (var dx = -1; dx <= 7; dx++) {
          var px = ox + dx, py = oy + dy;
          if (px < 0 || py < 0 || px >= size || py >= size) { continue; }
          var d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          set(px, py, d !== 2 && d <= 3);
        }
      }
    }
    finder(0, 0); finder(size - 7, 0); finder(0, size - 7);

    /* 對齊圖案 */
    var centers = ALIGN[version];
    var last = centers[centers.length - 1];
    centers.forEach(function (cy) {
      centers.forEach(function (cx) {
        var corner = (cx === 6 && cy === 6) ||
                     (cx === 6 && cy === last) ||
                     (cx === last && cy === 6);
        if (corner) { return; }
        for (var dy = -2; dy <= 2; dy++) {
          for (var dx = -2; dx <= 2; dx++) {
            set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      });
    });

    /* 時序圖案 */
    for (var i = 8; i < size - 8; i++) {
      set(i, 6, i % 2 === 0);
      set(6, i, i % 2 === 0);
    }

    /* 先把格式資訊區佔住，資料才不會排進去 */
    for (i = 0; i <= 8; i++) {
      if (!fixed[i][8]) { set(8, i, false); }
      if (!fixed[8][i]) { set(i, 8, false); }
    }
    for (i = 0; i < 8; i++) {
      if (!fixed[size - 1 - i][8]) { set(8, size - 1 - i, false); }
      if (!fixed[8][size - 1 - i]) { set(size - 1 - i, 8, false); }
    }
    set(8, size - 8, true);   // 恆為黑的那一格

    if (version >= 7) {
      for (i = 0; i < 18; i++) {
        var a = size - 11 + i % 3, bq = Math.floor(i / 3);
        set(a, bq, false);
        set(bq, a, false);
      }
    }

    /* 資料以之字形填入 */
    var bitIndex = 0;
    var totalBits = codewords.length * 8;
    function nextBit() {
      if (bitIndex >= totalBits) { return 0; }
      var byteVal = codewords[bitIndex >> 3];
      var bit = (byteVal >>> (7 - (bitIndex & 7))) & 1;
      bitIndex++;
      return bit;
    }

    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) { right = 5; }
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          x = right - j;
          var upward = ((right + 1) & 2) === 0;
          y = upward ? size - 1 - vert : vert;
          if (!fixed[y][x]) { mod[y][x] = nextBit(); }
        }
      }
    }

    return { size: size, mod: mod, fixed: fixed };
  }

  var MASKS = [
    function (x, y) { return (x + y) % 2 === 0; },
    function (x, y) { return y % 2 === 0; },
    function (x) { return x % 3 === 0; },
    function (x, y) { return (x + y) % 3 === 0; },
    function (x, y) { return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0; },
    function (x, y) { return (x * y) % 2 + (x * y) % 3 === 0; },
    function (x, y) { return ((x * y) % 2 + (x * y) % 3) % 2 === 0; },
    function (x, y) { return ((x + y) % 2 + (x * y) % 3) % 2 === 0; }
  ];

  function formatBits(mask) {
    var data = (0 << 3) | mask;            // 等級 M 的兩個 bit 是 00
    var rem = data;
    for (var i = 0; i < 10; i++) { rem = (rem << 1) ^ ((rem >>> 9) * 0x537); }
    return ((data << 10) | rem) ^ 0x5412;
  }

  function versionBits(v) {
    var rem = v;
    for (var i = 0; i < 12; i++) { rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25); }
    return (v << 12) | rem;
  }

  function applyMask(base, maskIndex, version) {
    var size = base.size;
    var m = base.mod.map(function (row) { return row.slice(); });
    var f = base.fixed, x, y, i;

    for (y = 0; y < size; y++) {
      for (x = 0; x < size; x++) {
        if (!f[y][x] && MASKS[maskIndex](x, y)) { m[y][x] ^= 1; }
      }
    }

    var bits = formatBits(maskIndex);
    function bit(n) { return (bits >>> n) & 1; }
    for (i = 0; i <= 5; i++) { m[i][8] = bit(i); }
    m[7][8] = bit(6);
    m[8][8] = bit(7);
    m[8][7] = bit(8);
    for (i = 9; i <= 14; i++) { m[8][14 - i] = bit(i); }
    for (i = 0; i <= 7; i++) { m[8][size - 1 - i] = bit(i); }
    for (i = 8; i <= 14; i++) { m[size - 15 + i][8] = bit(i); }
    m[size - 8][8] = 1;

    if (version >= 7) {
      var vb = versionBits(version);
      for (i = 0; i < 18; i++) {
        var v = (vb >>> i) & 1;
        var a = size - 11 + i % 3, b = Math.floor(i / 3);
        m[b][a] = v;
        m[a][b] = v;
      }
    }
    return m;
  }

  /** 標準的四條懲罰規則，分數越低越好讀 */
  function penalty(m) {
    var size = m.length, score = 0, dark = 0, i, j, k;

    function runScore(line) {
      var s = 0, run = 1;
      for (var n = 1; n < line.length; n++) {
        if (line[n] === line[n - 1]) {
          run++;
        } else {
          if (run >= 5) { s += 3 + (run - 5); }
          run = 1;
        }
      }
      if (run >= 5) { s += 3 + (run - 5); }
      return s;
    }

    var FINDER = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    function finderScore(line) {
      var s = 0;
      for (var n = 0; n + 11 <= line.length; n++) {
        var fwd = true, bwd = true;
        for (k = 0; k < 11; k++) {
          if (line[n + k] !== FINDER[k]) { fwd = false; }
          if (line[n + k] !== FINDER[10 - k]) { bwd = false; }
        }
        if (fwd || bwd) { s += 40; }
      }
      return s;
    }

    for (i = 0; i < size; i++) {
      var row = m[i], col = [];
      for (j = 0; j < size; j++) { col.push(m[j][i]); dark += m[i][j]; }
      score += runScore(row) + runScore(col) + finderScore(row) + finderScore(col);
    }

    for (i = 0; i < size - 1; i++) {
      for (j = 0; j < size - 1; j++) {
        var a = m[i][j];
        if (a === m[i][j + 1] && a === m[i + 1][j] && a === m[i + 1][j + 1]) { score += 3; }
      }
    }

    var ratio = dark / (size * size) * 100;
    score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
    return score;
  }

  /** @returns {{size:number, mod:number[][]}} */
  function make(text) {
    var enc = encode(text);
    var base = build(enc.version, enc.codewords);
    var best = null, bestScore = Infinity;

    for (var i = 0; i < 8; i++) {
      var m = applyMask(base, i, enc.version);
      var s = penalty(m);
      if (s < bestScore) { bestScore = s; best = m; }
    }
    return { size: best.length, mod: best };
  }

  /**
   * 產生 SVG 字串。投影幕上放大不會糊，也不用產圖檔。
   * @param {string} text
   * @param {{quiet?:number, dark?:string, light?:string}} [opts]
   */
  function svg(text, opts) {
    opts = opts || {};
    var q = opts.quiet == null ? 4 : opts.quiet;
    var r = make(text);
    var n = r.size + q * 2;
    var d = "";

    for (var y = 0; y < r.size; y++) {
      for (var x = 0; x < r.size; x++) {
        if (r.mod[y][x]) { d += "M" + (x + q) + " " + (y + q) + "h1v1h-1z"; }
      }
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + " " + n +
           '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
           '<rect width="' + n + '" height="' + n + '" fill="' + (opts.light || "#fff") + '"/>' +
           '<path d="' + d + '" fill="' + (opts.dark || "#111") + '"/></svg>';
  }

export { make, svg, capacity };

