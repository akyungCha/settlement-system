/* 출고 정산 대시보드 - 데이터 주도 렌더링 */
(function () {
  'use strict';

  var S = window.Settlement;

  var state = {
    brands: [],            // 설정 페이지에서 로드한 브랜드/카테고리 트리
    activeBrand: null,     // 브랜드명 (주문 데이터 키)
    ordersMap: {},         // { 브랜드명: [order] }
    range: { start: '', end: '' },
    quick: 'thisMonth',
    amountMode: 'ship'     // 'ship' | 'retail'
  };

  var el = {
    tabs: document.getElementById('brandTabs'),
    dropzone: document.getElementById('dropzone'),
    fileInput: document.getElementById('fileInput'),
    unmatchedPanel: document.getElementById('unmatchedPanel'),
    unmatchedCount: document.getElementById('unmatchedCount'),
    unmatchedList: document.getElementById('unmatchedList'),
    startDate: document.getElementById('startDate'),
    endDate: document.getElementById('endDate'),
    searchBtn: document.getElementById('searchBtn'),
    chips: document.getElementById('quickChips'),
    monthPicker: document.getElementById('monthPicker'),
    exportBtn: document.getElementById('exportBtn'),
    resultRange: document.getElementById('resultRange'),
    resultCount: document.getElementById('resultCount'),
    tableWrap: document.getElementById('tableWrap'),
    toast: document.getElementById('toast'),
    delModal: document.getElementById('delModal'),
    delModalTarget: document.getElementById('delModalTarget'),
    delModalConfirm: document.getElementById('delModalConfirm')
  };

  /* ================= 유틸 ================= */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var toastTimer = null;
  function toast(msg, isError) {
    el.toast.textContent = msg;
    el.toast.className = 'toast is-show' + (isError ? ' is-error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.className = 'toast'; }, 3600);
  }

  function uid() { return 'o_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6); }

  function brandObj() {
    return state.brands.filter(function (b) { return b.name === state.activeBrand; })[0] || null;
  }

  function brandOrders() {
    return state.ordersMap[state.activeBrand] || [];
  }

  function rangedOrders() {
    return S.filterByRange(brandOrders(), state.range.start, state.range.end)
      .slice()
      .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });  // 날짜 내림차순
  }

  function persist() { S.Store.saveOrders(state.ordersMap); }

  // 주문 삭제 권한 — 지금은 모두 허용.
  // TODO: 로그인 구현 시 최고관리자 롤 체크로 교체 (예: currentUser.role === 'superadmin')
  function canDeleteOrders() { return true; }

  // 삭제 확인용 요약: "2026/07/23 · 김미연 · 3개 상품, 총 18권"
  function orderSummaryText(o) {
    var brand = brandObj();
    var map = S.orderQtyMap(o, brand ? S.flatItems(brand) : []);
    var names = Object.keys(map);
    var qty = names.reduce(function (s, n) { return s + map[n]; }, 0);
    var qtyStr = Number.isInteger(qty) ? qty : Number(qty.toFixed(1));
    return S.dotDate(o.date) + ' · ' + (o.orderer || '주문자 미상') +
      ' · ' + names.length + '개 상품, 총 ' + qtyStr + '권';
  }

  // 저장 데이터에서 주문 제거 후 전체 재렌더 (파생 수치 재계산)
  function deleteOrder(id) {
    var list = state.ordersMap[state.activeBrand] || [];
    var idx = list.findIndex(function (o) { return o.id === id; });
    if (idx < 0) return false;
    list.splice(idx, 1);
    persist();
    render();
    return true;
  }

  /* ================= 기간 프리셋 ================= */
  function presetRange(kind, monthValue) {
    var now = new Date();
    var y = now.getFullYear(), m = now.getMonth();
    if (kind === 'thisMonth') return { start: S.toYMD(new Date(y, m, 1)), end: S.toYMD(now) };
    if (kind === 'lastMonth') return { start: S.toYMD(new Date(y, m - 1, 1)), end: S.toYMD(new Date(y, m, 0)) };
    if (kind === 'last3') return { start: S.toYMD(new Date(y, m - 2, 1)), end: S.toYMD(now) };
    if (kind === 'thisYear') return { start: S.toYMD(new Date(y, 0, 1)), end: S.toYMD(new Date(y, 11, 31)) };
    if (kind === 'month' && monthValue) {
      var p = monthValue.split('-');
      var yy = Number(p[0]), mm = Number(p[1]) - 1;
      return { start: S.toYMD(new Date(yy, mm, 1)), end: S.toYMD(new Date(yy, mm + 1, 0)) };
    }
    return null;
  }

  /* ================= 렌더 ================= */
  function render() {
    renderTabs();
    renderFilter();
    renderUnmatched();
    renderTable();
  }

  function renderTabs() {
    if (!state.brands.length) {
      el.tabs.innerHTML = '<p class="empty-msg">등록된 브랜드가 없습니다. 카테고리 및 단가 설정에서 먼저 저장해 주세요.</p>';
      return;
    }
    el.tabs.innerHTML = state.brands.map(function (b) {
      return '<button type="button" class="brand-tab' + (b.name === state.activeBrand ? ' is-active' : '') +
        '" data-brand="' + esc(b.name) + '">' + esc(b.name) + '</button>';
    }).join('');
  }

  function renderFilter() {
    el.startDate.value = state.range.start;
    el.endDate.value = state.range.end;
    Array.prototype.forEach.call(el.chips.querySelectorAll('.chip'), function (c) {
      c.classList.toggle('is-active', c.dataset.quick === state.quick);
    });
  }

  function renderUnmatched() {
    var brand = brandObj();
    var rows = [];
    brandOrders().forEach(function (o) {
      (o.lines || []).forEach(function (l, idx) {
        if (l.matched || l.excluded) return;
        rows.push({ orderId: o.id, idx: idx, file: o.fileName, raw: l.raw, qty: l.qty, cand: l.candidates || null });
      });
    });

    if (!rows.length || !brand) {
      el.unmatchedPanel.hidden = true;
      el.unmatchedList.innerHTML = '';
      return;
    }

    var items = S.flatItems(brand);
    var options = '<option value="">-- 상품 선택 --</option>' + items.map(function (it) {
      return '<option value="' + esc(it.name) + '">' + esc(it.catName + ' / ' + it.name) + '</option>';
    }).join('') + '<option value="__exclude">집계에서 제외</option>';

    el.unmatchedPanel.hidden = false;
    el.unmatchedCount.textContent = '(' + rows.length + '건)';
    el.unmatchedList.innerHTML =
      '<div class="um-row um-row--head"><span>파일명</span><span>원본 교재명</span><span>수량</span><span>수동 배정</span></div>' +
      rows.map(function (r) {
        // 토큰 집합 다중 후보는 자동 매칭 대신 후보를 나열(수동 배정 참고)
        var cand = r.cand ? '<span class="um-row__cand">후보: ' + r.cand.map(esc).join(', ') + '</span>' : '';
        return '<div class="um-row">' +
          '<span class="um-row__file">' + esc(r.file) + '</span>' +
          '<span class="um-row__raw">' + esc(r.raw) + cand + '</span>' +
          '<span class="um-row__qty">' + esc(r.qty) + '</span>' +
          '<select class="select" data-assign="' + r.orderId + '" data-idx="' + r.idx + '">' + options + '</select>' +
        '</div>';
      }).join('');
  }

  function renderTable() {
    var brand = brandObj();
    el.resultRange.textContent = S.dotDate(state.range.start) + '~' + S.dotDate(state.range.end) + ' 검색 결과';

    if (!brand) {
      el.resultCount.textContent = '';
      el.tableWrap.innerHTML = '<p class="table-empty">브랜드 데이터가 없습니다. <a href="index.html">카테고리 및 단가 설정</a>에서 먼저 저장해 주세요.</p>';
      return;
    }

    var orders = rangedOrders();
    var agg = S.aggregate(orders, brand);
    var items = agg.items;

    el.resultCount.innerHTML = '검색 결과 내 누적 총 <strong>' + orders.length + '건</strong>';

    if (!items.length) {
      el.tableWrap.innerHTML = '<p class="table-empty">등록된 2depth 상품이 없습니다. <a href="index.html">카테고리 및 단가 설정</a>에서 추가해 주세요.</p>';
      return;
    }

    var amountKey = state.amountMode === 'ship' ? 'shipAmount' : 'retailAmount';
    var cats = brand.categories.filter(function (c) { return (c.items || []).length; });

    var h = '<table class="grid">';

    // 1행: 1depth 그룹 헤더
    h += '<thead><tr>';
    h += '<th class="h-depth1 lbl" colspan="2">상품명 1depth</th>';
    cats.forEach(function (c) {
      h += '<th class="h-depth1" colspan="' + c.items.length + '">' + esc(c.name) + '</th>';
    });
    h += '</tr>';

    // 2행: 2depth 헤더
    h += '<tr><th class="h-depth2 lbl" colspan="2">상품명 2depth</th>';
    items.forEach(function (it) { h += '<th class="h-depth2">' + esc(it.name) + '</th>'; });
    h += '</tr>';

    // 3행: 총 출고 수량
    h += '<tr><th class="h-sum lbl" colspan="2">총 출고 수량</th>';
    items.forEach(function (it) {
      h += '<td class="h-sum num">' + S.fmtQty(agg.byItem[it.name].qty) + '</td>';
    });
    h += '</tr>';

    // 4행: 출고 비율
    h += '<tr><th class="h-sum lbl" colspan="2">출고 비율(100% 기준)</th>';
    items.forEach(function (it) {
      h += '<td class="h-sum num">' + S.fmtRatio(agg.ratio[it.name]) + '</td>';
    });
    h += '</tr>';

    // 5행: 금액 (출고금액/상품금액 전환)
    h += '<tr><th class="h-sum lbl" colspan="2">' +
      '<select class="sum-select" id="amountMode">' +
        '<option value="ship"' + (state.amountMode === 'ship' ? ' selected' : '') + '>총 출고금액</option>' +
        '<option value="retail"' + (state.amountMode === 'retail' ? ' selected' : '') + '>총 상품금액</option>' +
      '</select></th>';
    items.forEach(function (it) {
      h += '<td class="h-sum num money">' + S.fmtMoney(agg.byItem[it.name][amountKey]) + '</td>';
    });
    h += '</tr>';

    // 6행: 상세 컬럼 헤더
    h += '<tr><th class="h-detail c-date">date</th><th class="h-detail c-name">주문자명</th>';
    items.forEach(function () { h += '<th class="h-detail"></th>'; });
    h += '</tr></thead>';

    // 상세 행
    h += '<tbody>';
    if (!orders.length) {
      h += '<tr><td class="c-date"></td><td class="c-name"></td>' +
        '<td colspan="' + items.length + '">해당 기간에 업로드된 주문서가 없습니다.</td></tr>';
    } else {
      var canDel = canDeleteOrders();
      orders.forEach(function (o) {
        var map = S.orderQtyMap(o, items);
        // date 셀 좌측에 hover 노출 × (권한 있을 때만)
        var delBtn = canDel
          ? '<button type="button" class="order-del" data-del-order="' + esc(o.id) +
            '" title="주문 리스트 삭제" aria-label="주문 리스트 삭제">×</button>'
          : '';
        h += '<tr><td class="c-date">' + delBtn +
          '<span class="c-date__text">' + esc(S.dotDate(o.date)) + '</span></td>' +
          '<td class="c-name">' + esc(o.orderer) + '</td>';
        items.forEach(function (it) { h += '<td class="num">' + S.fmtCell(map[it.name]) + '</td>'; });
        h += '</tr>';
      });
    }
    h += '</tbody></table>';

    el.tableWrap.innerHTML = h;
    stickHeader();
  }

  // thead 각 행의 실제 높이를 측정해 sticky top 주입
  function stickHeader() {
    var rows = el.tableWrap.querySelectorAll('thead tr');
    var top = 0;
    Array.prototype.forEach.call(rows, function (tr) {
      Array.prototype.forEach.call(tr.children, function (cell) { cell.style.top = top + 'px'; });
      top += tr.getBoundingClientRect().height;
    });
  }

  /* ================= 업로드 / 파싱 ================= */
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(new Uint8Array(fr.result)); };
      fr.onerror = function () { reject(new Error('파일을 읽지 못했습니다.')); };
      fr.readAsArrayBuffer(file);
    });
  }

  async function handleFiles(files) {
    var brand = brandObj();
    if (!brand) { toast('브랜드를 먼저 등록해 주세요.', true); return; }
    if (!window.XLSX) { toast('엑셀 라이브러리를 불러오지 못했습니다. 네트워크를 확인해 주세요.', true); return; }

    var items = S.flatItems(brand);
    var list = state.ordersMap[state.activeBrand] || (state.ordersMap[state.activeBrand] = []);
    var ok = 0, skipped = 0, failed = [];

    el.dropzone.classList.add('is-busy');
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      try {
        var buf = await readFile(file);
        var wb = XLSX.read(buf, { type: 'array' });
        var sheet = wb.Sheets[wb.SheetNames[0]];
        var grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false, blankrows: true });
        var parsed = S.parseOrderGrid(grid, file.name);

        // 동일 날짜+주문자 중복 확인
        var dupIdx = list.findIndex(function (o) {
          return o.date === parsed.date && o.orderer === parsed.orderer;
        });
        if (dupIdx > -1) {
          var replace = confirm('이미 등록된 주문서입니다.\n' + parsed.date + ' / ' + parsed.orderer +
            '\n(기존 파일: ' + list[dupIdx].fileName + ')\n\n확인 = 교체, 취소 = 건너뛰기');
          if (!replace) { skipped++; continue; }
          list.splice(dupIdx, 1);
        }

        list.push({
          id: uid(),
          date: parsed.date,
          orderer: parsed.orderer,
          shipTo: parsed.shipTo,
          fileName: file.name,
          lines: S.matchLines(parsed.lines, items)
        });
        ok++;
      } catch (e) {
        failed.push(file.name + ' — ' + e.message);
      }
    }
    el.dropzone.classList.remove('is-busy');

    persist();
    render();

    var msg = [];
    if (ok) msg.push(ok + '건 업로드 완료');
    if (skipped) msg.push(skipped + '건 건너뜀');
    if (failed.length) {
      toast('파싱 실패 ' + failed.length + '건\n' + failed.join('\n'), true);
    } else if (msg.length) {
      toast(msg.join(' / '));
    }
  }

  /* ================= Excel 추출 (ExcelJS, 서식 적용) ================= */
  function exportExcel() {
    var brand = brandObj();
    if (!brand) { toast('내보낼 브랜드가 없습니다.', true); return; }
    if (!window.ExcelJS) { toast('엑셀 라이브러리를 불러오지 못했습니다.', true); return; }

    var orders = rangedOrders();
    var agg = S.aggregate(orders, brand);
    var items = agg.items;
    if (!items.length) { toast('내보낼 상품이 없습니다.', true); return; }

    var cats = brand.categories.filter(function (c) { return (c.items || []).length; });
    var amountKey = state.amountMode === 'ship' ? 'shipAmount' : 'retailAmount';
    var amountLabel = state.amountMode === 'ship' ? '총 출고금액' : '총 상품금액';

    var ncol = 2 + items.length;   // A, B + 상품 컬럼

    var wb = new ExcelJS.Workbook();
    var ws = wb.addWorksheet('출고정산');

    // --- 값 채우기 (숫자는 숫자로, 비율은 문자열) ---
    // 1행: 1depth (라벨 + 라인명)
    var r1 = ['상품명 1depth', null];
    cats.forEach(function (c) {
      r1.push(c.name);
      for (var k = 1; k < c.items.length; k++) r1.push(null);
    });
    ws.addRow(r1);
    ws.addRow(['상품명 2depth', null].concat(items.map(function (it) { return it.name; })));
    ws.addRow(['총 출고 수량', null].concat(items.map(function (it) { return Number(agg.byItem[it.name].qty.toFixed(1)); })));
    ws.addRow(['출고 비율(100% 기준)', null].concat(items.map(function (it) { return S.fmtRatio(agg.ratio[it.name]); })));
    ws.addRow([amountLabel, null].concat(items.map(function (it) { return Math.round(agg.byItem[it.name][amountKey]); })));
    ws.addRow(['date', '주문자명'].concat(items.map(function () { return null; })));
    orders.forEach(function (o) {
      var map = S.orderQtyMap(o, items);
      ws.addRow([o.date, o.orderer].concat(items.map(function (it) {
        return map[it.name] ? map[it.name] : null;
      })));
    });

    var nrow = ws.rowCount;

    // --- 병합 ---
    for (var r = 1; r <= 5; r++) ws.mergeCells(r, 1, r, 2);   // A:B 라벨 (1~5행)
    var colStart = 3;                                          // 상품 컬럼 시작
    cats.forEach(function (c) {
      var len = c.items.length;
      if (len > 1) ws.mergeCells(1, colStart, 1, colStart + len - 1);   // 1depth 병합
      colStart += len;
    });

    // --- 열 너비 ---
    ws.getColumn(1).width = 14.8;
    ws.getColumn(2).width = 12;
    for (var C = 3; C <= ncol; C++) ws.getColumn(C).width = 14.8;

    // --- 전체 셀 서식: 폰트/정렬/테두리/행높이 (병합 슬레이브 포함) ---
    var thin = { style: 'thin', color: { argb: 'FF000000' } };
    for (var R = 1; R <= nrow; R++) {
      var row = ws.getRow(R);
      row.height = 17.25;
      for (var Cc = 1; Cc <= ncol; Cc++) {
        var cell = row.getCell(Cc);
        cell.font = { name: '맑은 고딕', size: 12 };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = { top: thin, left: thin, bottom: thin, right: thin };
      }
    }

    // --- 상품명 헤더 밴드만 회색 채움 (1행 1depth 셀 + 2행 2depth 셀) ---
    var gray = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7E6E6' } };
    for (var Ch = 3; Ch <= ncol; Ch++) {
      ws.getRow(1).getCell(Ch).fill = gray;
      ws.getRow(2).getCell(Ch).fill = gray;
    }

    // --- 다운로드 ---
    var fileName = '출고정산_' + state.activeBrand + '_' + state.range.start + '_' + state.range.end + '.xlsx';
    wb.xlsx.writeBuffer().then(function (buf) {
      var blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = fileName;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    }).catch(function () { toast('엑셀 생성에 실패했습니다.', true); });
  }

  /* ================= 이벤트 ================= */
  el.tabs.addEventListener('click', function (ev) {
    var tab = ev.target.closest('[data-brand]');
    if (!tab) return;
    state.activeBrand = tab.dataset.brand;
    render();
  });

  // 드롭존
  el.dropzone.addEventListener('click', function (ev) {
    if (ev.target === el.fileInput) return;   // 프로그램 클릭 재귀 방지
    el.fileInput.click();
  });

  el.fileInput.addEventListener('change', function () {
    if (el.fileInput.files.length) handleFiles(el.fileInput.files);
    el.fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (t) {
    el.dropzone.addEventListener(t, function (ev) {
      ev.preventDefault();
      el.dropzone.classList.add('is-over');
    });
  });

  ['dragleave', 'drop'].forEach(function (t) {
    el.dropzone.addEventListener(t, function (ev) {
      ev.preventDefault();
      el.dropzone.classList.remove('is-over');
    });
  });

  el.dropzone.addEventListener('drop', function (ev) {
    var files = Array.prototype.filter.call(ev.dataTransfer.files, function (f) {
      return /\.xlsx?$/i.test(f.name);
    });
    if (!files.length) { toast('.xlsx 파일만 업로드할 수 있습니다.', true); return; }
    handleFiles(files);
  });

  // 미매칭 수동 배정
  el.unmatchedList.addEventListener('change', function (ev) {
    var sel = ev.target.closest('[data-assign]');
    if (!sel) return;
    var order = brandOrders().filter(function (o) { return o.id === sel.dataset.assign; })[0];
    if (!order) return;
    var line = order.lines[Number(sel.dataset.idx)];
    if (!line) return;

    if (sel.value === '__exclude') { line.excluded = true; line.matched = null; }
    else if (sel.value) { line.matched = sel.value; line.excluded = false; }
    else return;

    persist();
    render();
    toast('매칭 정보가 반영되었습니다.');
  });

  // 기간 검색
  el.searchBtn.addEventListener('click', function () {
    var s = el.startDate.value, e = el.endDate.value;
    if (!s || !e) { toast('시작일과 종료일을 모두 선택해 주세요.', true); return; }
    if (s > e) { toast('시작일이 종료일보다 늦습니다.', true); return; }
    state.range = { start: s, end: e };
    state.quick = null;
    render();
  });

  el.chips.addEventListener('click', function (ev) {
    var chip = ev.target.closest('.chip');
    if (!chip || chip.dataset.quick === 'month') return;
    var r = presetRange(chip.dataset.quick);
    if (!r) return;
    state.range = r;
    state.quick = chip.dataset.quick;
    render();
  });

  el.monthPicker.addEventListener('change', function () {
    var r = presetRange('month', el.monthPicker.value);
    if (!r) return;
    state.range = r;
    state.quick = 'month';
    render();
  });

  // 금액 행 전환
  el.tableWrap.addEventListener('change', function (ev) {
    if (ev.target.id !== 'amountMode') return;
    state.amountMode = ev.target.value;
    renderTable();
  });

  el.exportBtn.addEventListener('click', exportExcel);

  /* ---------- 데이터 백업/복원: 공용 모듈(S.Backup)에 연결 ---------- */
  var backupExp = document.getElementById('dataExportBtn');
  var backupImp = document.getElementById('dataImportBtn');
  if (S && backupExp) {
    backupExp.addEventListener('click', function () { S.Backup.exportData({ toast: toast }); });
    // 가져오기 성공 시 현재 페이지 재렌더(저장 데이터 재로드)
    backupImp.addEventListener('click', function () { S.Backup.importData({ toast: toast, onImported: function () { init(); } }); });
  }

  /* ================= 주문 삭제 ================= */
  var pendingDeleteId = null;

  function openDelModal(o) {
    pendingDeleteId = o.id;
    el.delModalTarget.textContent = orderSummaryText(o);
    el.delModal.hidden = false;
    el.delModalConfirm.focus();
  }

  function closeDelModal() {
    pendingDeleteId = null;
    el.delModal.hidden = true;
  }

  // 상세 행 × 클릭 → 확인 모달
  el.tableWrap.addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-del-order]');
    if (!btn) return;
    var o = brandOrders().filter(function (x) { return x.id === btn.dataset.delOrder; })[0];
    if (o) openDelModal(o);
  });

  el.delModalConfirm.addEventListener('click', function () {
    var id = pendingDeleteId;
    closeDelModal();
    if (id && deleteOrder(id)) toast('주문 리스트가 삭제되었습니다.');
  });

  // 취소 버튼 / 배경 클릭 / ESC로 닫기
  el.delModal.addEventListener('click', function (ev) {
    if (ev.target.closest('[data-modal-close]')) closeDelModal();
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !el.delModal.hidden) closeDelModal();
  });

  document.querySelectorAll('.nav-item').forEach(function (a) {
    a.addEventListener('click', function (ev) {
      if (a.classList.contains('is-active')) { ev.preventDefault(); return; }
      if (a.getAttribute('href') === '#') {
        ev.preventDefault();
        toast('해당 페이지는 준비 중입니다.');
      }
    });
  });

  window.addEventListener('resize', function () {
    if (el.tableWrap.querySelector('thead')) stickHeader();
  });

  /* ================= 초기화 ================= */
  function init() {
    var cat = S.Store.loadCategories();
    state.brands = (cat && cat.brands) || [];
    state.activeBrand = state.brands.length ? state.brands[0].name : null;
    state.ordersMap = S.Store.loadOrders();
    state.range = presetRange('thisMonth');
    render();
  }

  // 첫 방문 시 시드 로드 후 렌더(어느 페이지로 진입해도 동작). 실패해도 조용히 진행.
  S.Store.ensureSeed().then(init);
})();
