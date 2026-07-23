/* 거래처 정산서 - 데이터 주도 렌더링 (거래처→보고서→행 트리) */
(function () {
  'use strict';

  var STORE_KEY = 'logistics.statements.v1';

  /* ================= 저장소 (추후 API 교체 지점) ================= */
  var Store = {
    load: function () {
      try {
        var raw = localStorage.getItem(STORE_KEY);
        if (!raw) return null;
        var d = JSON.parse(raw);
        return (d && Array.isArray(d.partners)) ? d : null;
      } catch (e) { return null; }
    },
    save: function (data) {
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
      return true;
    }
  };

  /* ================= state ================= */
  var state = {
    data: { partners: [] },   // 영속 데이터
    selectedPartnerId: null,
    selectedReportId: null,
    expandedPartners: {},     // 폴더 아코디언 펼침
    dirty: false              // 캔버스 내용 미저장 여부
  };

  var el = {
    tree: document.getElementById('folderTree'),
    canvas: document.getElementById('canvas'),
    addPartner: document.getElementById('addPartnerBtn'),
    toast: document.getElementById('toast'),
    loadModal: document.getElementById('loadModal'),
    loadModalTarget: document.getElementById('loadModalTarget'),
    loadBody: document.getElementById('loadBody'),
    loadConfirm: document.getElementById('loadConfirm')
  };

  var S = window.Settlement;   // 공용 집계 로직 재사용

  /* ================= 유틸 ================= */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function uid(p) {
    return (p || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  function fmtMoney(n) { return (Math.round(Number(n) || 0)).toLocaleString('ko-KR'); }

  // 콤마·기호 제거 후 정수
  function parseAmount(s) {
    var d = String(s == null ? '' : s).replace(/[^\d]/g, '');
    var n = parseInt(d, 10);
    return isNaN(n) ? 0 : n;
  }

  // 금액칸: 비면 null, 아니면 정수
  function parseMoneyOrNull(s) {
    var d = String(s == null ? '' : s).replace(/[^\d]/g, '');
    if (d === '') return null;
    var n = parseInt(d, 10);
    return isNaN(n) ? null : n;
  }

  // 수량칸: 비면 null, 아니면 소수 허용
  function parseQty(s) {
    var d = String(s == null ? '' : s).replace(/[^\d.]/g, '');
    if (d === '') return null;
    var n = parseFloat(d);
    return isNaN(n) ? null : n;
  }

  function isNum(v) { return typeof v === 'number' && !isNaN(v); }
  function roundMoney(n) { return Math.round(Number(n) || 0); }
  // 수량 표시(소수 유지, 불필요한 0 제거)
  function fmtQty(v) { return isNum(v) ? String(v) : ''; }

  function todayYMD() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  var toastTimer = null;
  function toast(msg, isErr) {
    el.toast.textContent = msg;
    el.toast.className = 'toast is-show' + (isErr ? ' is-error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.className = 'toast'; }, 2400);
  }

  /* ================= 조회 ================= */
  function partnerById(id) {
    return state.data.partners.filter(function (p) { return p.id === id; })[0] || null;
  }
  function currentPartner() { return partnerById(state.selectedPartnerId); }
  function currentReport() {
    var p = currentPartner();
    if (!p) return null;
    return p.reports.filter(function (r) { return r.id === state.selectedReportId; })[0] || null;
  }
  function findGroup(gid) {
    var r = currentReport();
    if (!r) return null;
    return r.groups.filter(function (g) { return g.id === gid; })[0] || null;
  }
  function findItem(gid, iid) {
    var g = findGroup(gid);
    if (!g) return null;
    return g.items.filter(function (it) { return it.id === iid; })[0] || null;
  }

  /* ================= 영속 / dirty ================= */
  function persist() { Store.save(state.data); state.dirty = false; syncSaveBtn(); }
  function markDirty() { state.dirty = true; syncSaveBtn(); }

  function syncSaveBtn() {
    var b = document.getElementById('saveBtn');
    if (!b) return;
    b.textContent = state.dirty ? '저장' : '저장됨';
    b.classList.toggle('is-clean', !state.dirty);
    b.disabled = !state.dirty;
  }

  /* ================= 좌측 폴더 트리 ================= */
  function renderTree() {
    var partners = state.data.partners;
    if (!partners.length) {
      el.tree.innerHTML = '<p class="empty-msg">거래처가 없습니다. “+ 거래처 추가”로 시작하세요.</p>';
      return;
    }

    el.tree.innerHTML = partners.map(function (p) {
      var open = !!state.expandedPartners[p.id];

      var head = '<div class="folder__head' + (open ? ' is-open' : '') + '" data-action="toggle-partner" data-pid="' + p.id + '">' +
        '<span class="folder__caret">▸</span>' +
        '<span class="folder__icon">📁</span>' +
        '<span class="folder__name" title="' + esc(p.name) + '">' + esc(p.name) + '</span>' +
        '<span class="folder__count">' + p.reports.length + '</span>' +
        '<span class="folder__actions">' +
          '<button type="button" data-action="rename-partner" data-pid="' + p.id + '" title="이름변경">✎</button>' +
          '<button type="button" data-action="delete-partner" data-pid="' + p.id + '" title="삭제">🗑</button>' +
        '</span></div>';

      var body = '';
      if (open) {
        // 최신순(발행일 최신, 동일 시 생성순)
        var reports = p.reports.slice().sort(function (a, b) {
          return String(b.issueDate).localeCompare(String(a.issueDate)) || (b.createdAt - a.createdAt);
        });

        var files = reports.length ? reports.map(function (r) {
          var sel = r.id === state.selectedReportId && p.id === state.selectedPartnerId;
          return '<div class="file' + (sel ? ' is-selected' : '') + '" data-action="open-report" data-pid="' + p.id + '" data-rid="' + r.id + '">' +
            '<span class="file__icon">📄</span>' +
            '<span class="file__meta">' +
              '<span class="file__title" title="' + esc(r.title) + '">' + esc(r.title || '(제목 없음)') + '</span>' +
              '<span class="file__date">' + esc(r.issueDate || '발행일 미정') + '</span>' +
            '</span>' +
            '<span class="folder__actions">' +
              '<button type="button" data-action="rename-report" data-pid="' + p.id + '" data-rid="' + r.id + '" title="이름변경">✎</button>' +
              '<button type="button" data-action="delete-report" data-pid="' + p.id + '" data-rid="' + r.id + '" title="삭제">🗑</button>' +
            '</span></div>';
        }).join('') : '<p class="folder__empty">보고서가 없습니다.</p>';

        body = '<div class="folder__body">' +
          '<button type="button" class="stmt-new-report" data-action="new-report" data-pid="' + p.id + '">+ 새 보고서 작성</button>' +
          files + '</div>';
      }

      return '<div class="folder">' + head + body + '</div>';
    }).join('');
  }

  /* ================= 우측 보고서 캔버스 ================= */
  function renderCanvas() {
    var r = currentReport();
    if (!r) {
      el.canvas.innerHTML = '<div class="canvas-empty">좌측에서 보고서를 선택하거나 새로 작성하세요.</div>';
      return;
    }

    var toolbar = '<div class="canvas-toolbar">' +
      '<button type="button" class="btn stmt-load" data-action="load-data">정산 데이터 불러오기</button>' +
      '<span class="canvas-toolbar__spacer"></span>' +
      '<button type="button" class="btn stmt-save" id="saveBtn" data-action="save">저장</button>' +
      '<button type="button" class="btn stmt-print" data-action="print"> 인쇄 / PDF</button>' +
      '</div>';

    var head = '<div class="paper__head">' +
      '<input class="paper__title" data-field="title" value="' + esc(r.title) + '" placeholder="보고서 제목">' +
      '<div class="paper__meta">' +
        '<label>발행일자 <input type="date" data-field="issueDate" value="' + esc(r.issueDate) + '"></label>' +
        '<label>발행처 <input data-field="issuer" value="' + esc(r.issuer) + '" placeholder="발행처"></label>' +
        '<label>수신처 <input data-field="recipient" value="' + esc(r.recipient) + '" placeholder="수신처"></label>' +
      '</div></div>';

    var table = '<div class="stmt-table">' + r.groups.map(renderGroup).join('') + '</div>' +
      '<button type="button" class="stmt-add-group" data-action="add-group">+ 대항목 추가</button>';

    var grand = '<div class="paper__foot" id="grandArea">' + grandAreaInner(r) + '</div>';

    el.canvas.innerHTML = toolbar + '<div class="paper" id="paper">' + head + table + grand + '</div>';
    syncSaveBtn();
  }

  // 최종 총액 영역(VAT 토글 + 총액 행들). VAT 별도면 3행, 포함이면 단일 행.
  function grandAreaInner(r) {
    var supply = reportTotal(r);
    var vat = roundMoney(supply * 0.10);
    var sep = r.vatMode === 'separate';

    // VAT 토글 세그먼트 (인쇄 시 숨김)
    var seg = '<div class="vat-control">' +
      '<span class="vat-control__label">부가세</span>' +
      '<div class="vat-seg" id="vatSeg">' +
        '<button type="button" class="vat-seg__btn' + (!sep ? ' is-active' : '') + '" data-vat="included">VAT 포함</button>' +
        '<button type="button" class="vat-seg__btn' + (sep ? ' is-active' : '') + '" data-vat="separate">VAT 별도</button>' +
      '</div></div>';

    var rows;
    if (sep) {
      rows =
        '<div class="paper__vat-row"><span>공급가액</span><span class="paper__vat-val" id="vatSupply">₩ ' + fmtMoney(supply) + '</span></div>' +
        '<div class="paper__vat-row"><span>부가세 (10%)</span><span class="paper__vat-val" id="vatAmount">₩ ' + fmtMoney(vat) + '</span></div>' +
        '<div class="paper__grand"><span>최종 정산 총액 (VAT 포함)</span><span class="paper__grand-val" id="grandTotal">₩ ' + fmtMoney(supply + vat) + '</span></div>';
    } else {
      rows = '<div class="paper__grand"><span>최종 정산 총액</span><span class="paper__grand-val" id="grandTotal">₩ ' + fmtMoney(supply) + '</span></div>';
    }
    return seg + rows;
  }

  // VAT 모드 전환 시 총액 영역만 재렌더 (표는 그대로)
  function renderGrandArea(r) {
    var host = document.getElementById('grandArea');
    if (host) host.innerHTML = grandAreaInner(r);
  }

  // 대항목 블록
  function renderGroup(g) {
    var sub = groupTotal(g);
    // 불러온 대항목 배지 (화면 전용, 인쇄 숨김)
    var badge = g.imported ? '<span class="stmt-import-badge" title="대시보드 집계에서 불러온 항목">불러옴</span>' : '';
    var groupRow = '<div class="stmt-row stmt-row--group" data-gid="' + g.id + '">' +
      '<span class="stmt-row__actions">' +
        '<button type="button" data-action="move-group" data-gid="' + g.id + '" data-dir="-1" title="위로">▲</button>' +
        '<button type="button" data-action="move-group" data-gid="' + g.id + '" data-dir="1" title="아래로">▼</button>' +
        '<button type="button" data-action="del-group" data-gid="' + g.id + '" title="대항목 삭제">✕</button>' +
      '</span>' +
      '<div class="stmt-group__namewrap">' +
        '<input class="stmt-group__name" data-field="group-name" data-gid="' + g.id + '" value="' + esc(g.name) + '" placeholder="대항목명 (예: 총 상품 정산금)">' +
        badge +
      '</div>' +
      '<span class="stmt-row__amount stmt-subtotal" id="sub-' + g.id + '">₩ ' + fmtMoney(sub) + '</span>' +
    '</div>';

    var items = g.items.map(function (it) {
      var ov = itemOverridden(it);   // 계산값과 다른 수동값 여부
      var ds = ' data-gid="' + g.id + '" data-iid="' + it.id + '"';
      return '<div class="stmt-row stmt-row--item"' + ds + '>' +
        '<span class="stmt-row__actions">' +
          '<button type="button" data-action="move-item" data-gid="' + g.id + '" data-iid="' + it.id + '" data-dir="-1" title="위로">▲</button>' +
          '<button type="button" data-action="move-item" data-gid="' + g.id + '" data-iid="' + it.id + '" data-dir="1" title="아래로">▼</button>' +
          '<button type="button" data-action="del-item" data-gid="' + g.id + '" data-iid="' + it.id + '" title="소항목 삭제">✕</button>' +
        '</span>' +
        '<input class="stmt-item__label" data-field="item-label"' + ds + ' value="' + esc(it.label) + '" placeholder="소항목명 (예: 1번 상품군)">' +
        '<input class="stmt-item__qty stmt-num" data-field="item-qty"' + ds + ' inputmode="decimal" value="' + esc(fmtQty(it.qty)) + '" placeholder="수량">' +
        '<input class="stmt-item__unit stmt-num" data-field="item-unit"' + ds + ' inputmode="numeric" value="' + (isNum(it.unitPrice) ? fmtMoney(it.unitPrice) : '') + '" placeholder="단가">' +
        '<span class="stmt-total-cell">' +
          '<input class="stmt-item__total stmt-num" data-field="item-total"' + ds + ' inputmode="numeric" value="' + (isNum(it.total) && it.total ? fmtMoney(it.total) : '') + '" placeholder="0">' +
          '<span class="stmt-ovr" data-ovr="' + it.id + '"' + (ov ? '' : ' hidden') + ' title="' + (ov ? '계산값: ' + fmtMoney(it.qty * it.unitPrice) : '') + '">수정됨</span>' +
        '</span>' +
        '<input class="stmt-item__note" data-field="item-note"' + ds + ' value="' + esc(it.note) + '" placeholder="비고">' +
      '</div>';
    }).join('');

    var addItem = '<button type="button" class="stmt-add-item" data-action="add-item" data-gid="' + g.id + '">+ 소항목 추가</button>';

    return '<div class="stmt-group">' + groupRow + items + addItem + '</div>';
  }

  /* ================= 합산 ================= */
  function groupTotal(g) {
    return g.items.reduce(function (s, it) { return s + (Number(it.total) || 0); }, 0);
  }
  function reportTotal(r) {
    return r.groups.reduce(function (s, g) { return s + groupTotal(g); }, 0);
  }

  // 두 원천값이 있고 총금액이 계산값과 다르면 override 상태
  function itemOverridden(it) {
    if (!(isNum(it.qty) && isNum(it.unitPrice))) return false;
    return !!it.totalOverridden && roundMoney(it.total) !== roundMoney(it.qty * it.unitPrice);
  }

  // 특정 소항목 행 DOM
  function rowNodeOf(iid) {
    return el.canvas.querySelector('.stmt-row--item[data-iid="' + iid + '"]');
  }

  // 총금액 입력값 + override 배지를 DOM에 반영 (재렌더 없이)
  function syncItemRow(it) {
    var node = rowNodeOf(it.id);
    if (!node) return;
    var totalInput = node.querySelector('.stmt-item__total');
    if (totalInput && document.activeElement !== totalInput) {
      totalInput.value = (isNum(it.total) && it.total) ? fmtMoney(it.total) : '';
    }
    var badge = node.querySelector('.stmt-ovr');
    if (badge) {
      var ov = itemOverridden(it);
      badge.hidden = !ov;
      badge.title = ov ? '계산값: ' + fmtMoney(it.qty * it.unitPrice) : '';
    }
  }

  // 금액 입력 시 DOM만 갱신 (재렌더 없이 포커스 유지)
  function updateTotals() {
    var r = currentReport();
    if (!r) return;
    r.groups.forEach(function (g) {
      var node = document.getElementById('sub-' + g.id);
      if (node) node.textContent = '₩ ' + fmtMoney(groupTotal(g));
    });
    // VAT 파생값 갱신 (별도 모드일 때만 공급가액/부가세 행 존재)
    var supply = reportTotal(r);
    var vat = roundMoney(supply * 0.10);
    var sep = r.vatMode === 'separate';
    var sn = document.getElementById('vatSupply');
    if (sn) sn.textContent = '₩ ' + fmtMoney(supply);
    var vn = document.getElementById('vatAmount');
    if (vn) vn.textContent = '₩ ' + fmtMoney(vat);
    var gt = document.getElementById('grandTotal');
    if (gt) gt.textContent = '₩ ' + fmtMoney(sep ? supply + vat : supply);
  }

  /* ================= 생성 팩토리 ================= */
  function newItem() { return { id: uid('it'), label: '', qty: null, unitPrice: null, total: null, totalOverridden: false, note: '' }; }
  function newGroup() { return { id: uid('gr'), name: '', items: [newItem()] }; }
  function newReport() {
    return {
      id: uid('rp'), title: '새 정산보고서', issueDate: todayYMD(),
      issuer: '', recipient: '', createdAt: Date.now(),
      vatMode: 'included',        // 'included'(VAT 포함) | 'separate'(VAT 별도)
      groups: [newGroup()]
    };
  }

  /* ================= 이벤트: 거래처 추가 ================= */
  el.addPartner.addEventListener('click', function () {
    var name = (window.prompt('거래처(파트너사) 이름을 입력하세요.') || '').trim();
    if (!name) return;
    var p = { id: uid('pt'), name: name, reports: [], mappings: {} };   // mappings: 브랜드별 담당 1depth명
    state.data.partners.push(p);
    state.expandedPartners[p.id] = true;
    persist();
    renderTree();
    toast('거래처를 추가했습니다.');
  });

  /* ================= 이벤트: 폴더 트리 (관리 액션은 즉시 저장) ================= */
  el.tree.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-action]');
    if (!t) return;
    var a = t.dataset.action, pid = t.dataset.pid, rid = t.dataset.rid;
    var p = partnerById(pid);

    if (a === 'toggle-partner') {
      state.expandedPartners[pid] = !state.expandedPartners[pid];
      renderTree();

    } else if (a === 'rename-partner') {
      if (!p) return;
      var pn = (window.prompt('거래처 이름 변경', p.name) || '').trim();
      if (!pn) return;
      p.name = pn; persist(); renderTree();

    } else if (a === 'delete-partner') {
      if (!p) return;
      if (!window.confirm('“' + p.name + '” 거래처와 하위 보고서 ' + p.reports.length + '건이 모두 삭제됩니다. 계속할까요?')) return;
      state.data.partners = state.data.partners.filter(function (x) { return x.id !== pid; });
      if (state.selectedPartnerId === pid) { state.selectedPartnerId = null; state.selectedReportId = null; renderCanvas(); }
      persist(); renderTree();
      toast('거래처를 삭제했습니다.');

    } else if (a === 'new-report') {
      if (!p) return;
      var r = newReport();
      p.reports.push(r);
      state.expandedPartners[pid] = true;
      state.selectedPartnerId = pid;
      state.selectedReportId = r.id;
      persist();
      renderTree(); renderCanvas();

    } else if (a === 'open-report') {
      state.selectedPartnerId = pid;
      state.selectedReportId = rid;
      renderTree(); renderCanvas();

    } else if (a === 'rename-report') {
      if (!p) return;
      var rep = p.reports.filter(function (x) { return x.id === rid; })[0];
      if (!rep) return;
      var nt = (window.prompt('보고서 제목 변경', rep.title) || '').trim();
      if (!nt) return;
      rep.title = nt; persist();
      renderTree();
      if (state.selectedReportId === rid) renderCanvas();

    } else if (a === 'delete-report') {
      if (!p) return;
      var target = p.reports.filter(function (x) { return x.id === rid; })[0];
      if (!target) return;
      if (!window.confirm('“' + (target.title || '(제목 없음)') + '” 보고서를 삭제할까요?')) return;
      p.reports = p.reports.filter(function (x) { return x.id !== rid; });
      if (state.selectedReportId === rid) { state.selectedReportId = null; renderCanvas(); }
      persist(); renderTree();
      toast('보고서를 삭제했습니다.');
    }
  });

  /* ================= 이벤트: 캔버스 클릭 (저장/인쇄/행 조작) ================= */
  el.canvas.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-action]');
    if (!t) return;
    var a = t.dataset.action;

    if (a === 'save') { persist(); toast('저장되었습니다.'); return; }
    if (a === 'print') { window.print(); return; }
    if (a === 'load-data') { openLoadModal(); return; }

    var r = currentReport();
    if (!r) return;

    if (a === 'add-group') {
      r.groups.push(newGroup());
      renderCanvas(); markDirty();

    } else if (a === 'add-item') {
      var g = findGroup(t.dataset.gid);
      if (g) { g.items.push(newItem()); renderCanvas(); markDirty(); }

    } else if (a === 'del-group') {
      if (!window.confirm('이 대항목과 소항목을 삭제할까요?')) return;
      r.groups = r.groups.filter(function (x) { return x.id !== t.dataset.gid; });
      renderCanvas(); markDirty();

    } else if (a === 'del-item') {
      var g2 = findGroup(t.dataset.gid);
      if (g2) { g2.items = g2.items.filter(function (x) { return x.id !== t.dataset.iid; }); renderCanvas(); markDirty(); }

    } else if (a === 'move-group') {
      moveInArray(r.groups, indexById(r.groups, t.dataset.gid), Number(t.dataset.dir));
      renderCanvas(); markDirty();

    } else if (a === 'move-item') {
      var g3 = findGroup(t.dataset.gid);
      if (g3) { moveInArray(g3.items, indexById(g3.items, t.dataset.iid), Number(t.dataset.dir)); renderCanvas(); markDirty(); }
    }
  });

  // VAT 별도/포함 토글 → 정산서에 저장 후 총액 영역만 재렌더
  el.canvas.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-vat]');
    if (!b) return;
    var r = currentReport();
    if (!r) return;
    var mode = b.dataset.vat === 'separate' ? 'separate' : 'included';
    if (r.vatMode === mode) return;
    r.vatMode = mode;
    renderGrandArea(r);
    markDirty();
  });

  function indexById(arr, id) {
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return i;
    return -1;
  }
  function moveInArray(arr, idx, dir) {
    if (idx < 0) return;
    var j = idx + dir;
    if (j < 0 || j >= arr.length) return;
    var tmp = arr[idx]; arr[idx] = arr[j]; arr[j] = tmp;
  }

  /* ================= 정산 데이터 불러오기 ================= */
  var loadState = null;      // 모달 로컬 상태
  var loadBrands = null;     // 열 때 로드한 브랜드 목록
  var loadOrdersMap = null;  // 열 때 로드한 주문 데이터

  // 전월 'YYYY-MM'
  function prevMonthValue() {
    var d = new Date(), y = d.getFullYear(), m = d.getMonth() - 1;
    if (m < 0) { m = 11; y--; }
    return y + '-' + String(m + 1).padStart(2, '0');
  }

  function brandByName(name) {
    return (loadBrands || []).filter(function (b) { return b.name === name; })[0] || null;
  }

  function openLoadModal() {
    var r = currentReport();
    if (!r) return;
    if (!S) { toast('집계 모듈을 불러오지 못했습니다.', true); return; }

    var cat = S.Store.loadCategories();
    loadBrands = (cat && cat.brands) || [];
    if (!loadBrands.length) { toast('브랜드 데이터가 없습니다. 카테고리 및 단가 설정에서 먼저 저장하세요.', true); return; }
    loadOrdersMap = S.Store.loadOrders();

    var brand = loadBrands[0].name;
    loadState = { brand: brand, month: prevMonthValue(), checked: {}, unit: 'line', basis: 'ship', saveMapping: false };
    applyMapping();   // 거래처 매핑 있으면 미리 체크

    el.loadModalTarget.textContent = '대상: ' + (r.title || '(제목 없음)');
    el.loadModal.hidden = false;
    renderLoadBody();
  }

  function closeLoadModal() { el.loadModal.hidden = true; loadState = null; }

  // 현재 브랜드의 거래처 담당 상품군 매핑을 checked에 반영
  function applyMapping() {
    var p = currentPartner();
    var mapped = (p && p.mappings && p.mappings[loadState.brand]) || null;
    loadState.checked = {};
    if (mapped) mapped.forEach(function (n) { loadState.checked[n] = true; });
  }

  // 현재 조건으로 브랜드/기간 집계 (대시보드와 동일한 core 재사용)
  function computeLoad() {
    var brand = brandByName(loadState.brand);
    if (!brand) return null;
    var orders = loadOrdersMap[loadState.brand] || [];
    var mr = S.parseMonth(loadState.month);
    var range = S.monthRange(mr.year, mr.month0);
    var filtered = S.filterByRange(orders, range.start, range.end);
    return { brand: brand, agg: S.aggregate(filtered, brand), hasOrders: filtered.length > 0 };
  }

  function basisKey() { return loadState.basis === 'ship' ? 'shipAmount' : 'retailAmount'; }

  function catAmount(agg, name) {
    var e = agg.byCategory[name];
    return e ? (e[basisKey()] || 0) : 0;
  }

  // 삽입될 행 목록 계산 (미리보기·삽입 공용)
  function loadRows(brand, agg) {
    var cats = (brand.categories || []).filter(function (c) { return loadState.checked[c.name] && (c.items || []).length; });
    if (loadState.unit === 'line') {
      // 1depth 라인별: 금액 0 라인은 제외
      return cats.map(function (c) {
        return { label: c.name, qty: null, unitPrice: null, total: roundMoney(catAmount(agg, c.name)) };
      }).filter(function (row) { return row.total > 0; });
    }
    // 2depth 상품별: 체크된 1depth 소속 + 수량 > 0
    var flat = S.flatItems(brand);
    return flat.filter(function (f) {
      var e = agg.byItem[f.name];
      return loadState.checked[f.catName] && e && e.qty > 0;
    }).map(function (f) {
      var e = agg.byItem[f.name];
      var unit = loadState.basis === 'ship' ? f.shipPrice : f.retailPrice;
      return { label: f.name, qty: e.qty, unitPrice: unit, total: roundMoney(e.qty * unit) };
    });
  }

  function checkedCount() {
    return Object.keys(loadState.checked).filter(function (k) { return loadState.checked[k]; }).length;
  }

  // 모달 본문 전체 렌더
  function renderLoadBody() {
    var c = computeLoad();
    if (!c) { el.loadBody.innerHTML = '<p class="empty-msg">브랜드 정보를 찾을 수 없습니다.</p>'; return; }
    var brand = c.brand, agg = c.agg;

    var brandOpts = loadBrands.map(function (b) {
      return '<option value="' + esc(b.name) + '"' + (b.name === loadState.brand ? ' selected' : '') + '>' + esc(b.name) + '</option>';
    }).join('');

    var controls =
      '<div class="load-row">' +
        '<label class="load-field"><span>브랜드</span>' +
          '<select class="input load-input" data-load="brand">' + brandOpts + '</select></label>' +
        '<label class="load-field"><span>기간(월)</span>' +
          '<input type="month" class="input load-input" data-load="month" value="' + esc(loadState.month) + '"></label>' +
      '</div>' +
      '<div class="load-row">' +
        '<div class="load-field"><span>삽입 단위</span>' +
          '<div class="vat-seg">' +
            '<button type="button" class="vat-seg__btn' + (loadState.unit === 'line' ? ' is-active' : '') + '" data-unit="line">1depth 라인별</button>' +
            '<button type="button" class="vat-seg__btn' + (loadState.unit === 'item' ? ' is-active' : '') + '" data-unit="item">2depth 상품별</button>' +
          '</div></div>' +
        '<div class="load-field"><span>금액 기준</span>' +
          '<div class="vat-seg">' +
            '<button type="button" class="vat-seg__btn' + (loadState.basis === 'ship' ? ' is-active' : '') + '" data-basis="ship">출고액 기준</button>' +
            '<button type="button" class="vat-seg__btn' + (loadState.basis === 'retail' ? ' is-active' : '') + '" data-basis="retail">판매액 기준</button>' +
          '</div></div>' +
      '</div>';

    var catList = (brand.categories || []).filter(function (cat) { return (cat.items || []).length; }).map(function (cat) {
      return '<label class="load-cat">' +
        '<input type="checkbox" data-cat="' + esc(cat.name) + '"' + (loadState.checked[cat.name] ? ' checked' : '') + '>' +
        '<span class="load-cat__name">' + esc(cat.name) + '</span>' +
        '<span class="load-cat__amt">₩ ' + fmtMoney(catAmount(agg, cat.name)) + '</span></label>';
    }).join('') || '<p class="empty-msg">등록된 1depth 상품군이 없습니다.</p>';

    // 매핑 없으면 힌트
    var p = currentPartner();
    var hasMap = p && p.mappings && p.mappings[loadState.brand] && p.mappings[loadState.brand].length;

    el.loadBody.innerHTML =
      controls +
      '<div class="load-cats"><div class="load-cats__head">정산 대상 상품군 (1depth)</div>' + catList + '</div>' +
      '<div class="load-preview" id="loadPreview">' + previewHtml(brand, agg) + '</div>' +
      '<label class="load-savemap"><input type="checkbox" data-load="saveMapping"' + (loadState.saveMapping ? ' checked' : '') + '>' +
        ' 이 선택을 거래처 담당 상품군으로 저장</label>' +
      (hasMap ? '' : '<p class="load-hint">담당 상품군을 저장하면 다음부터 자동 선택됩니다.</p>');

    syncLoadConfirm(brand, agg, c.hasOrders);
  }

  // 미리보기 영역만 갱신 (체크박스 토글 시)
  function updateLoadPreview() {
    var c = computeLoad();
    if (!c) return;
    var host = document.getElementById('loadPreview');
    if (host) host.innerHTML = previewHtml(c.brand, c.agg);
    syncLoadConfirm(c.brand, c.agg, c.hasOrders);
  }

  function previewHtml(brand, agg) {
    if (!checkedCount()) return '<div class="load-preview__head">미리보기</div><p class="load-empty">정산 대상 상품군을 선택하세요.</p>';
    var rows = loadRows(brand, agg);
    if (!rows.length) return '<div class="load-preview__head">미리보기</div><p class="load-empty">선택한 기간에 출고 데이터가 없습니다.</p>';

    var body = rows.map(function (row) {
      var meta = (loadState.unit === 'item' && isNum(row.qty))
        ? '<span class="load-prow__meta">' + fmtQty(row.qty) + ' × ' + fmtMoney(row.unitPrice) + '</span>' : '';
      return '<div class="load-prow"><span class="load-prow__label">' + esc(row.label) + '</span>' +
        meta + '<span class="load-prow__amt">₩ ' + fmtMoney(row.total) + '</span></div>';
    }).join('');
    var sum = rows.reduce(function (s, row) { return s + row.total; }, 0);

    return '<div class="load-preview__head">미리보기 · 총 상품 정산금 (' + esc(loadState.month) + ')</div>' +
      body + '<div class="load-prow load-prow--sum"><span>합계</span><span class="load-prow__amt">₩ ' + fmtMoney(sum) + '</span></div>';
  }

  function syncLoadConfirm(brand, agg, hasOrders) {
    var rows = checkedCount() ? loadRows(brand, agg) : [];
    el.loadConfirm.disabled = !rows.length;
  }

  // 삽입 실행 (스냅샷)
  function doLoadInsert() {
    var r = currentReport();
    var c = computeLoad();
    if (!r || !c) return;
    var rows = loadRows(c.brand, c.agg);
    if (!rows.length) return;
    var period = loadState.month;

    // 동일 브랜드+기간 중복 경고
    var dup = r.groups.some(function (g) {
      return g.imported && g.importBrand === loadState.brand && g.importPeriod === period;
    });
    if (dup && !window.confirm('동일 기간의 불러온 항목이 이미 있습니다. 계속하시겠습니까?')) return;

    // 소항목 스냅샷 생성
    var note = period + ' 출고 집계';
    var items = rows.map(function (row) {
      return {
        id: uid('it'), label: row.label,
        qty: isNum(row.qty) ? row.qty : null,
        unitPrice: isNum(row.unitPrice) ? row.unitPrice : null,
        total: row.total, totalOverridden: false,
        note: loadState.unit === 'line' ? note : ''
      };
    });
    r.groups.push({
      id: uid('gr'), name: '총 상품 정산금 (' + period + ')',
      imported: true, importBrand: loadState.brand, importPeriod: period,
      items: items
    });

    // 담당 상품군 매핑 저장
    if (loadState.saveMapping) {
      var p = currentPartner();
      if (p) {
        p.mappings = p.mappings || {};
        p.mappings[loadState.brand] = (c.brand.categories || [])
          .filter(function (cat) { return loadState.checked[cat.name]; })
          .map(function (cat) { return cat.name; });
      }
    }

    persist();          // 매핑 포함 영속화
    closeLoadModal();
    renderCanvas();
    toast('정산 데이터를 불러왔습니다.');
  }

  // 모달 이벤트
  el.loadModal.addEventListener('click', function (ev) {
    if (ev.target.closest('[data-load-close]')) { closeLoadModal(); return; }
    var seg = ev.target.closest('[data-unit],[data-basis]');
    if (seg && loadState) {
      if (seg.dataset.unit) loadState.unit = seg.dataset.unit;
      else loadState.basis = seg.dataset.basis;
      renderLoadBody();
    }
  });

  el.loadBody.addEventListener('change', function (ev) {
    if (!loadState) return;
    var t = ev.target, k = t.dataset.load;
    if (k === 'brand') { loadState.brand = t.value; applyMapping(); renderLoadBody(); }
    else if (k === 'month') { loadState.month = t.value || loadState.month; renderLoadBody(); }
    else if (k === 'saveMapping') { loadState.saveMapping = t.checked; }
    else if (t.dataset.cat != null) { loadState.checked[t.dataset.cat] = t.checked; updateLoadPreview(); }
  });

  el.loadConfirm.addEventListener('click', doLoadInsert);

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !el.loadModal.hidden) closeLoadModal();
  });

  /* ================= 이벤트: 캔버스 인라인 편집 ================= */
  // 텍스트/금액 입력 → 모델 갱신 (재렌더 없이 dirty)
  el.canvas.addEventListener('input', function (ev) {
    var t = ev.target, f = t.dataset && t.dataset.field;
    if (!f) return;
    var r = currentReport();
    if (!r) return;

    if (f === 'title') { r.title = t.value; markDirty(); return; }
    if (f === 'issuer') { r.issuer = t.value; markDirty(); return; }
    if (f === 'recipient') { r.recipient = t.value; markDirty(); return; }
    if (f === 'group-name') { var g = findGroup(t.dataset.gid); if (g) { g.name = t.value; markDirty(); } return; }

    var it = findItem(t.dataset.gid, t.dataset.iid);
    if (!it) return;

    if (f === 'item-label') { it.label = t.value; markDirty(); }
    else if (f === 'item-note') { it.note = t.value; markDirty(); }
    else if (f === 'item-qty') {
      it.qty = parseQty(t.value);
      it.totalOverridden = false;                 // 원천값 변경 → override 해제
      if (isNum(it.qty) && isNum(it.unitPrice)) it.total = roundMoney(it.qty * it.unitPrice);
      syncItemRow(it); updateTotals(); markDirty();
    } else if (f === 'item-unit') {
      it.unitPrice = parseMoneyOrNull(t.value);
      it.totalOverridden = false;
      if (isNum(it.qty) && isNum(it.unitPrice)) it.total = roundMoney(it.qty * it.unitPrice);
      syncItemRow(it); updateTotals(); markDirty();
    } else if (f === 'item-total') {
      // 총금액 직접 수정: 두 원천값이 있으면 계산값과 비교해 override 표시
      it.total = parseMoneyOrNull(t.value);
      it.totalOverridden = isNum(it.qty) && isNum(it.unitPrice) &&
        roundMoney(it.total) !== roundMoney(it.qty * it.unitPrice);
      // 배지만 갱신 (입력 중인 total 값은 건드리지 않음)
      var node = rowNodeOf(it.id);
      if (node) {
        var badge = node.querySelector('.stmt-ovr');
        if (badge) {
          badge.hidden = !it.totalOverridden;
          badge.title = it.totalOverridden ? '계산값: ' + fmtMoney(it.qty * it.unitPrice) : '';
        }
      }
      updateTotals(); markDirty();
    }
  });

  // 날짜 선택 → 모델 갱신 + 트리 라벨 반영
  el.canvas.addEventListener('change', function (ev) {
    var t = ev.target;
    if (t.dataset && t.dataset.field === 'issueDate') {
      var r = currentReport();
      if (r) { r.issueDate = t.value; markDirty(); renderTree(); }
    }
  });

  // 금액칸(단가/총금액): 포커스 시 원본 숫자, 이탈 시 콤마 포맷 / 제목 이탈 시 트리 갱신
  el.canvas.addEventListener('focusin', function (ev) {
    var t = ev.target, f = t.dataset && t.dataset.field;
    if (f !== 'item-unit' && f !== 'item-total') return;
    var it = findItem(t.dataset.gid, t.dataset.iid);
    if (!it) return;
    var v = f === 'item-unit' ? it.unitPrice : it.total;
    t.value = isNum(v) && v ? String(v) : '';
  });
  el.canvas.addEventListener('focusout', function (ev) {
    var t = ev.target, f = t.dataset && t.dataset.field;
    if (f === 'item-unit' || f === 'item-total') {
      var it = findItem(t.dataset.gid, t.dataset.iid);
      if (!it) return;
      var v = f === 'item-unit' ? it.unitPrice : it.total;
      t.value = isNum(v) && v ? fmtMoney(v) : '';
    } else if (f === 'title') {
      renderTree();
    }
  });

  /* ================= 이탈 경고 ================= */
  window.addEventListener('beforeunload', function (e) {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // 활성 메뉴는 이동 막고, 미저장 이탈 경고는 beforeunload가 처리
  document.querySelectorAll('.nav-item').forEach(function (a) {
    a.addEventListener('click', function (ev) {
      if (a.classList.contains('is-active')) ev.preventDefault();
    });
  });

  /* ================= 시드 (최초 실행 예시, 저장 전) ================= */
  function seed() {
    var pid = uid('pt'), rid = uid('rp');
    return {
      partners: [{
        id: pid, name: '상일eNT', reports: [{
          id: rid, title: '상일eNT 26년 6월 정산보고서', issueDate: '2026-06-30',
          issuer: '출고정산㈜', recipient: '상일eNT', createdAt: Date.now(),
          groups: [
            { id: uid('gr'), name: '총 상품 정산금', items: [
              { id: uid('it'), label: '1번 상품군', qty: 20, unitPrice: 60000, total: 1200000, totalOverridden: false, note: '' },
              { id: uid('it'), label: '2번 상품군', qty: 43, unitPrice: 20000, total: 860000, totalOverridden: false, note: '6월 반품 2권 차감' }
            ] },
            { id: uid('gr'), name: '배송비', items: [
              { id: uid('it'), label: '퀵 배송비', qty: null, unitPrice: null, total: 30000, totalOverridden: false, note: '' }
            ] }
          ]
        }]
      }]
    };
  }

  /* ================= 마이그레이션 ================= */
  // 소항목을 신규 스키마로 정규화 (구버전: {name, amount} → {label, total})
  function normalizeItem(it) {
    it = it || {};
    var total = it.total != null ? it.total : it.amount;   // 구버전 amount → total
    return {
      id: it.id || uid('it'),
      label: it.label != null ? it.label : (it.name != null ? it.name : ''),
      qty: (it.qty != null && it.qty !== '') ? Number(it.qty) : null,
      unitPrice: (it.unitPrice != null && it.unitPrice !== '') ? Number(it.unitPrice) : null,
      total: (total != null && total !== '') ? Number(total) : null,
      totalOverridden: !!it.totalOverridden,
      note: it.note != null ? it.note : ''
    };
  }
  function normalizeData(data) {
    (data.partners || []).forEach(function (p) {
      if (!p.mappings || typeof p.mappings !== 'object') p.mappings = {};   // 담당 상품군 매핑 기본값
      (p.reports || []).forEach(function (r) {
        // 설정 없는 기존 정산서는 VAT 포함으로
        r.vatMode = r.vatMode === 'separate' ? 'separate' : 'included';
        (r.groups || []).forEach(function (g) {
          g.items = (g.items || []).map(normalizeItem);
        });
      });
    });
    return data;
  }

  /* ================= 초기화 ================= */
  function init() {
    var saved = Store.load();
    // 저장 데이터 없으면 예시 시드(메모리) — 사용자 액션 시 영속
    state.data = normalizeData(saved || seed());
    // 첫 거래처는 펼쳐서 보이게 (보고서 선택 전까지 캔버스는 빈 상태)
    if (state.data.partners[0]) state.expandedPartners[state.data.partners[0].id] = true;
    renderTree();
    renderCanvas();
    if (!saved) toast('예시 데이터로 시작합니다. 편집 후 저장하세요.');
  }

  /* ---------- 데이터 백업/복원: 공용 모듈(S.Backup)에 연결 ---------- */
  var backupExp = document.getElementById('dataExportBtn');
  var backupImp = document.getElementById('dataImportBtn');
  if (S && backupExp) {
    backupExp.addEventListener('click', function () { S.Backup.exportData({ toast: toast }); });
    backupImp.addEventListener('click', function () {
      S.Backup.importData({ toast: toast, onImported: function () {
        // 선택·미저장 상태 초기화 후 재로드
        state.selectedPartnerId = null; state.selectedReportId = null;
        state.expandedPartners = {}; state.dirty = false;
        init();
      } });
    });
  }

  init();
})();
