/* 출고 정산 공용 데이터 레이어 + 순수 로직 (대시보드/보고서 공용) */
window.Settlement = (function () {
  'use strict';

  var CAT_KEY = 'logistics.categoryPricing.v1';
  var ORDER_KEY = 'logistics.orders.v1';
  var STMT_KEY = 'logistics.statements.v1';   // 거래처 정산서
  var MATCH_THRESHOLD = 0.9;   // 퍼지 매칭 임계치
  var PREFIX_MIN_LEN = 6;      // 접두사 매칭 최소 길이(정규화 기준) — 짧은 일반명 흡수 방지

  /* ================= 저장소 어댑터 (추후 API 교체 지점) ================= */
  var Store = {
    loadCategories: function () {
      try {
        var raw = localStorage.getItem(CAT_KEY);
        if (!raw) return null;
        var d = JSON.parse(raw);
        return d && Array.isArray(d.brands) ? d : null;
      } catch (e) { return null; }
    },
    saveCategories: function (data) {
      localStorage.setItem(CAT_KEY, JSON.stringify(data));
      return true;
    },
    // 주문 데이터는 브랜드명 기준으로 보관 (브랜드 id 재생성과 무관하게 유지)
    loadOrders: function () {
      try {
        var raw = localStorage.getItem(ORDER_KEY);
        if (!raw) return {};
        var d = JSON.parse(raw);
        return (d && typeof d === 'object') ? d : {};
      } catch (e) { return {}; }
    },
    saveOrders: function (map) {
      localStorage.setItem(ORDER_KEY, JSON.stringify(map));
      return true;
    },
    // 거래처 정산서 (백업/복원 공용)
    loadStatements: function () {
      try {
        var raw = localStorage.getItem(STMT_KEY);
        if (!raw) return null;
        var d = JSON.parse(raw);
        return (d && Array.isArray(d.partners)) ? d : null;
      } catch (e) { return null; }
    },
    saveStatements: function (data) {
      localStorage.setItem(STMT_KEY, JSON.stringify(data));
      return true;
    }
  };

  /* ================= 데이터 백업/복원 (전 페이지 공용) ================= */
  // 파일명용 타임스탬프 YYYYMMDD_HHmm
  function backupStamp() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  }

  // 봉투 요약 (확인 다이얼로그용)
  function backupSummary(d) {
    var brands = (d.settings && d.settings.brands) || [];
    var products = brands.reduce(function (s, b) {
      return s + (b.categories || []).reduce(function (t, c) { return t + (c.items || []).length; }, 0);
    }, 0);
    var orders = d.orders || {};
    var orderCnt = Object.keys(orders).reduce(function (s, k) { return s + ((orders[k] || []).length); }, 0);
    var partners = (d.statements && d.statements.partners) || [];
    var reportCnt = partners.reduce(function (s, p) { return s + ((p.reports || []).length); }, 0);
    return { brands: brands.length, products: products, orders: orderCnt, statements: reportCnt };
  }

  // 봉투 구조/버전/필수 키 검증 → 문제 메시지(정상이면 null)
  function backupValidate(env) {
    if (!env || typeof env !== 'object') return '올바른 백업 파일이 아닙니다.';
    if (env.version !== 1) return '지원하지 않는 백업 버전입니다 (' + env.version + ').';
    var d = env.data;
    if (!d || typeof d !== 'object') return '백업 데이터(data)가 없습니다.';
    if (!d.settings || !Array.isArray(d.settings.brands)) return '설정 데이터(settings)가 올바르지 않습니다.';
    if (!d.orders || typeof d.orders !== 'object' || Array.isArray(d.orders)) return '주문 데이터(orders)가 올바르지 않습니다.';
    if (!d.statements || !Array.isArray(d.statements.partners)) return '정산서 데이터(statements)가 올바르지 않습니다.';
    return null;
  }

  function backupApply(text, toast, onImported) {
    var env;
    try { env = JSON.parse(text); }
    catch (e) { toast('가져오기 실패: JSON 형식이 올바르지 않습니다.', true); return; }

    var err = backupValidate(env);
    if (err) { toast('가져오기 실패: ' + err, true); return; }

    var d = env.data, sm = backupSummary(d);
    var when = env.exportedAt ? new Date(env.exportedAt).toLocaleString('ko-KR') : '알 수 없음';
    var msg = '현재 저장된 모든 데이터가 가져온 파일의 내용으로 대체됩니다. 계속하시겠습니까?\n\n' +
      '· 브랜드 ' + sm.brands + '개\n' +
      '· 상품 ' + sm.products + '개\n' +
      '· 주문 ' + sm.orders + '건\n' +
      '· 정산서 ' + sm.statements + '건\n' +
      '· 내보낸 날짜: ' + when;
    if (!window.confirm(msg)) return;

    try {
      // 기존 래퍼 경유 저장
      Store.saveCategories(d.settings);
      Store.saveOrders(d.orders);
      Store.saveStatements(d.statements);
    } catch (e) {
      toast('가져오기 저장에 실패했습니다.', true);
      return;
    }

    if (onImported) onImported(d);   // 현재 페이지 재렌더 콜백
    toast('데이터를 가져왔습니다.');
  }

  var Backup = {
    // 내보내기: 저장 데이터 전체를 봉투 JSON으로 다운로드
    exportData: function (opts) {
      opts = opts || {};
      var env = {
        exportedAt: new Date().toISOString(), version: 1,
        data: {
          settings: Store.loadCategories() || { brands: [] },
          orders: Store.loadOrders() || {},
          statements: Store.loadStatements() || { partners: [] }
        }
      };
      var blob = new Blob([JSON.stringify(env, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = '출고정산_백업_' + backupStamp() + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      if (opts.toast) opts.toast('데이터를 내보냈습니다.');
    },
    // 가져오기: 파일 선택 → 검증 → 확인 → 저장 → onImported
    importData: function (opts) {
      opts = opts || {};
      var toast = opts.toast || function () {};
      var input = document.createElement('input');   // 임시 파일 선택기 (페이지별 input 불필요)
      input.type = 'file';
      input.accept = '.json,application/json';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        document.body.removeChild(input);
        if (!file) return;
        var fr = new FileReader();
        fr.onload = function () { backupApply(fr.result, toast, opts.onImported); };
        fr.onerror = function () { toast('파일을 읽지 못했습니다.', true); };
        fr.readAsText(file);
      });
      input.click();
    }
  };

  /* ================= 문자열 / 유사도 ================= */
  // 공백 제거 + 소문자화 (매칭 정규화)
  function normalize(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, '').trim();
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (j = 1; j <= b.length; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      prev = cur.slice();
    }
    return prev[b.length];
  }

  // 0~1 유사도
  function similarity(a, b) {
    var x = normalize(a), y = normalize(b);
    if (!x && !y) return 1;
    if (!x || !y) return 0;
    if (x === y) return 1;
    return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  }

  /* ================= 날짜 유틸 ================= */
  function toYMD(d) {
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function dotDate(ymd) { return String(ymd || '').replace(/-/g, '/'); }

  // 해당 월의 1일~말일
  function monthRange(year, month0) {
    return {
      start: toYMD(new Date(year, month0, 1)),
      end: toYMD(new Date(year, month0 + 1, 0))
    };
  }

  // 'YYYY-MM' → {year, month0}
  function parseMonth(ym) {
    var p = String(ym || '').split('-');
    return { year: Number(p[0]), month0: Number(p[1]) - 1 };
  }

  function toMonthValue(year, month0) {
    var d = new Date(year, month0, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  /* ================= 주문서 파싱 ================= */
  // 셀 텍스트 (수식/숫자 포함)
  function cellText(grid, r, c) {
    var row = grid[r];
    if (!row) return '';
    var v = row[c];
    if (v == null) return '';
    return String(v).trim();
  }

  function pickDate(text) {
    var m = String(text || '').match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
    if (!m) return null;
    return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
  }

  // 파일명 토큰: "20260722_장정아_..." / "20260701 김경대(...)" (언더스코어·공백 구분)
  function fileTokens(fileName) {
    return String(fileName || '').replace(/\.[^.]+$/, '').split(/[_\s]+/).filter(Boolean);
  }

  // 파일명 선두의 독립된 8자리 YYYYMMDD → 실제 날짜 검증 후 YYYY-MM-DD (공식 주문일)
  function dateFromFileName(fileName) {
    var t = fileTokens(fileName)[0] || '';
    var m = t.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];   // 연도 20xx, 월 1~12, 일 1~31
    if (y < 2000 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return m[1] + '-' + m[2] + '-' + m[3];
  }

  // 파일명 날짜 다음 토큰 = 주문자 (괄호 수식어 제거)
  function ordererFromFileName(fileName) {
    var t = fileTokens(fileName)[1] || '';
    return stripSuffix(t) || null;
  }

  // 이름 뒤 괄호 수식어 제거: 장정아(새김) -> 장정아
  function stripSuffix(s) {
    return String(s == null ? '' : s).replace(/[(（][^)）]*[)）]/g, '').trim();
  }

  // 헤더 행 탐색: B열=교재명, D열=수량 인 행 (인덱스 하드코딩 금지)
  function findHeaderRow(grid) {
    for (var r = 0; r < Math.min(grid.length, 60); r++) {
      var b = normalize(cellText(grid, r, 1));
      var d = normalize(cellText(grid, r, 3));
      if (b.indexOf('교재') > -1 && d.indexOf('수량') > -1) return r;
    }
    for (var r2 = 0; r2 < Math.min(grid.length, 60); r2++) {
      if (normalize(cellText(grid, r2, 1)).indexOf('교재명') > -1) return r2;
    }
    return -1;
  }

  /**
   * 주문서 시트 → { date, orderer, shipTo, lines:[{raw, qty}] }
   * 실패 시 Error throw. grid는 sheet_to_json(header:1) 결과.
   */
  function parseOrderGrid(grid, fileName) {
    // 업무 규칙: 파일명 날짜/주문자가 공식 소스 → 파일명 우선, 없을 때만 시트값(A2/E5) 폴백
    var date = dateFromFileName(fileName) || pickDate(cellText(grid, 1, 0));
    var orderer = ordererFromFileName(fileName) || stripSuffix(cellText(grid, 4, 4));
    var shipTo = cellText(grid, 3, 4);

    if (!date) throw new Error('파일명과 작성일(A2)에서 날짜를 찾지 못했습니다.');
    if (!orderer) throw new Error('파일명과 주문자명(E5)에서 이름을 찾지 못했습니다.');

    var h = findHeaderRow(grid);
    if (h < 0) throw new Error('교재명/수량 헤더 행을 찾지 못했습니다.');

    var lines = [];
    for (var r = h + 1; r < grid.length; r++) {
      var a = cellText(grid, r, 0);
      var name = cellText(grid, r, 1);
      if (normalize(a) === '합계') break;
      if (!name) break;
      var qty = Number(String(cellText(grid, r, 3)).replace(/,/g, ''));
      if (!isFinite(qty)) qty = 0;
      lines.push({ raw: name, qty: qty });   // C(공급가)/E(총 금액)은 사용하지 않음
    }
    if (!lines.length) throw new Error('교재 데이터 행이 없습니다.');

    return { date: date, orderer: orderer, shipTo: shipTo, lines: lines };
  }

  /* ================= 매칭 ================= */
  // brand의 모든 2depth를 평면 목록으로
  function flatItems(brand) {
    var out = [];
    (brand && brand.categories || []).forEach(function (c) {
      (c.items || []).forEach(function (it) {
        out.push({
          catId: c.id, catName: c.name,
          id: it.id, name: it.name,
          shipPrice: Number(it.shipPrice) || 0,
          retailPrice: Number(it.retailPrice) || 0,
          qtyFactor: Number(it.qtyFactor) || 1
        });
      });
    });
    return out;
  }

  /* ---------- 토큰 집합(멀티셋) 매칭 준비 ---------- */
  // 소문자 텍스트 → 토큰 배열: 글자연속/숫자연속만 추출(공백·문장부호·괄호 무시)
  // 예: 'bridge reading2' → [bridge, reading, 2] / 'Bridge2(Reading)' → [bridge, 2, reading]
  function tokenize(s) {
    return String(s == null ? '' : s).toLowerCase().match(/[a-z가-힣]+|\d+/g) || [];
  }

  // 멀티셋 키: 토큰 정렬 후 결합 (순서 무관, 개수 구분 — 'vol vol 2' ≠ 'vol 2')
  function tokenKey(s) {
    var t = tokenize(s);
    return t.length ? t.slice().sort().join('|') : '';
  }

  // 등록 상품 토큰키 → 상품명[] 인덱스. items 배열 단위로 1회 캐시(업로드당 1회 계산).
  var _tokItems = null, _tokMap = null;
  function tokenIndex(items) {
    if (items === _tokItems && _tokMap) return _tokMap;
    var map = {};
    for (var i = 0; i < items.length; i++) {
      var k = tokenKey(items[i].name);
      if (!k) continue;
      (map[k] || (map[k] = [])).push(items[i].name);
    }
    _tokItems = items; _tokMap = map;
    return map;
  }

  /**
   * 교재명 → 등록 2depth명.
   * 순서: ① 완전 일치 → ② 토큰 집합 → ③ 등록명 접두사 → ④ 유사도 90% 이상.
   * @returns {matched:string|null, score:number, candidates?:string[]}
   */
  function matchName(raw, items) {
    var key = normalize(raw);

    // ① 완전 일치 (정규화 기준)
    for (var i = 0; i < items.length; i++) {
      if (normalize(items[i].name) === key) return { matched: items[i].name, score: 1 };
    }

    // ② 토큰 집합 매칭: 단어/숫자 토큰 멀티셋이 정확히 같으면(순서·문장부호 무관) 매칭.
    //    예: 업로드 'Bridge reading2' ↔ 등록 'Bridge2(Reading)'. 접두사보다 안전해 앞에 배치.
    var tk = tokenKey(raw);
    if (tk) {
      var cands = tokenIndex(items)[tk];
      if (cands && cands.length === 1) return { matched: cands[0], score: 1 };
      // 후보 2개+ → 자동 매칭 금지, 후보 나열해 미매칭 패널로
      if (cands && cands.length > 1) return { matched: null, score: 0, candidates: cands.slice() };
    }

    // ③ 접두사 매칭: 등록명(정규화)이 업로드명의 접두사면 매칭.
    //    여러 개면 가장 긴(구체적) 접두사 우선. PREFIX_MIN_LEN 이상만 허용.
    //    예: 등록 'lime tree(1-' → 업로드 'lime tree(1-1)', 'lime tree(1-2)' 전부 흡수
    var pfxName = null, pfxLen = 0;
    for (var p = 0; p < items.length; p++) {
      var nk = normalize(items[p].name);
      if (nk.length >= PREFIX_MIN_LEN && nk.length > pfxLen && key.indexOf(nk) === 0) {
        pfxName = items[p].name; pfxLen = nk.length;
      }
    }
    if (pfxName) return { matched: pfxName, score: 1 };   // 완전 매칭으로 취급

    // ④ 유사도 90% 이상 (오타 폴백)
    var best = null, bestScore = 0;
    for (var j = 0; j < items.length; j++) {
      var s = similarity(raw, items[j].name);
      if (s > bestScore) { bestScore = s; best = items[j].name; }
    }
    return bestScore >= MATCH_THRESHOLD
      ? { matched: best, score: bestScore }
      : { matched: null, score: bestScore };
  }

  function matchLines(lines, items) {
    return lines.map(function (l) {
      var m = matchName(l.raw, items);
      var line = { raw: l.raw, qty: l.qty, matched: m.matched, excluded: false };
      if (m.candidates) line.candidates = m.candidates;   // 토큰 집합 다중 후보(수동 배정 참고용)
      return line;
    });
  }

  /* ================= 기간 필터 / 집계 ================= */
  function filterByRange(orders, start, end) {
    return (orders || []).filter(function (o) {
      return (!start || o.date >= start) && (!end || o.date <= end);
    });
  }

  /**
   * 기간 내 주문 → 2depth/1depth 집계.
   * 적용 수량 = 원본 수량 × 수량 환산값.
   * allowNames: 집계 대상 2depth명 배열(생략 시 전체) — 보고서 트리 필터용.
   */
  function aggregate(orders, brand, allowNames) {
    var items = flatItems(brand);
    if (allowNames) {
      var allow = {};
      allowNames.forEach(function (n) { allow[n] = true; });
      items = items.filter(function (it) { return allow[it.name]; });
    }
    var byName = {};
    items.forEach(function (it) { byName[it.name] = it; });

    var byItem = {}, byCategory = {}, totalQty = 0;
    items.forEach(function (it) {
      byItem[it.name] = { qty: 0, shipAmount: 0, retailAmount: 0 };
      byCategory[it.catName] = byCategory[it.catName] || { qty: 0, shipAmount: 0, retailAmount: 0 };
    });

    (orders || []).forEach(function (o) {
      (o.lines || []).forEach(function (l) {
        if (!l.matched || l.excluded) return;
        var it = byName[l.matched];
        if (!it) return;
        var applied = (Number(l.qty) || 0) * it.qtyFactor;
        var ship = applied * it.shipPrice;
        var retail = applied * it.retailPrice;

        byItem[it.name].qty += applied;
        byItem[it.name].shipAmount += ship;
        byItem[it.name].retailAmount += retail;
        byCategory[it.catName].qty += applied;
        byCategory[it.catName].shipAmount += ship;
        byCategory[it.catName].retailAmount += retail;
        totalQty += applied;
      });
    });

    // 브랜드 전체 수량 대비 비중
    var ratio = {};
    Object.keys(byItem).forEach(function (name) {
      ratio[name] = totalQty ? (byItem[name].qty / totalQty) * 100 : 0;
    });

    return { items: items, byItem: byItem, byCategory: byCategory, ratio: ratio, totalQty: totalQty };
  }

  // 주문 1건의 2depth별 적용 수량
  function orderQtyMap(order, items) {
    var byName = {};
    items.forEach(function (it) { byName[it.name] = it; });
    var map = {};
    (order.lines || []).forEach(function (l) {
      if (!l.matched || l.excluded) return;
      var it = byName[l.matched];
      if (!it) return;
      map[it.name] = (map[it.name] || 0) + (Number(l.qty) || 0) * it.qtyFactor;
    });
    return map;
  }

  /* ================= 표시 포맷 ================= */
  function fmtQty(n) {
    var v = Number(n) || 0;
    return v.toFixed(1);
  }

  // 상세 셀: 소수 없으면 정수로
  function fmtCell(n) {
    var v = Number(n) || 0;
    if (!v) return '';
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  }

  function fmtMoney(n) {
    return Math.round(Number(n) || 0).toLocaleString('ko-KR');
  }

  function fmtRatio(n) {
    return (Math.round((Number(n) || 0) * 100) / 100) + '%';
  }

  return {
    CAT_KEY: CAT_KEY, ORDER_KEY: ORDER_KEY, STMT_KEY: STMT_KEY, MATCH_THRESHOLD: MATCH_THRESHOLD,
    Store: Store, Backup: Backup,
    normalize: normalize, similarity: similarity, stripSuffix: stripSuffix,
    toYMD: toYMD, dotDate: dotDate, pickDate: pickDate,
    monthRange: monthRange, parseMonth: parseMonth, toMonthValue: toMonthValue,
    dateFromFileName: dateFromFileName, ordererFromFileName: ordererFromFileName,
    findHeaderRow: findHeaderRow, parseOrderGrid: parseOrderGrid,
    flatItems: flatItems, matchName: matchName, matchLines: matchLines,
    filterByRange: filterByRange, aggregate: aggregate, orderQtyMap: orderQtyMap,
    fmtQty: fmtQty, fmtCell: fmtCell, fmtMoney: fmtMoney, fmtRatio: fmtRatio
  };
})();
