/* 카테고리 및 단가 설정 - 데이터 주도 렌더링 */
(function () {
  'use strict';

  var STORAGE_KEY = 'logistics.categoryPricing.v1';

  /* ---------- 저장소 어댑터 (추후 API 교체 지점) ---------- */
  var Store = {
    load: function () {
      try {
        var raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        var data = JSON.parse(raw);
        return data && Array.isArray(data.brands) ? data : null;
      } catch (e) {
        console.warn('저장 데이터 로드 실패', e);
        return null;
      }
    },
    save: function (data) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      return true;
    }
  };

  var S = window.Settlement;   // 주문/정산서 래퍼 (백업/복원용)

  /* ---------- 초기 시드 데이터 ---------- */
  function seed() {
    var a = [];
    for (var i = 1; i <= 6; i++) {
      a.push(item('Pre Stella A' + i, 5500, 35000, 1));
    }
    return {
      brands: [
        {
          id: uid('b'), name: '파머스영어',
          categories: [
            { id: uid('c'), name: 'Pre stella A', items: a },
            { id: uid('c'), name: 'Pre stella B', items: [item('Pre Stella B1', 5000, 28000, 1)] }
          ]
        },
        { id: uid('b'), name: '고래영어', categories: [] }
      ]
    };
  }

  function item(name, ship, retail, qty) {
    return { id: uid('i'), name: name, shipPrice: ship, retailPrice: retail, qtyFactor: qty };
  }

  var seq = 0;
  function uid(prefix) {
    seq += 1;
    return prefix + '_' + Date.now().toString(36) + '_' + seq;
  }

  /* ---------- 상태 ----------
     편집 중 입력값은 문자열로 보관하고 저장 시 숫자로 변환한다. */
  var state = {
    brands: [],
    activeBrandId: null,
    dirty: false,
    errors: {}   // { itemId: { name?, shipPrice?, retailPrice?, qtyFactor? } }
  };

  var el = {
    tabs: document.getElementById('brandTabs'),
    area: document.getElementById('categoryArea'),
    saveBtn: document.getElementById('saveBtn'),
    dataExportBtn: document.getElementById('dataExportBtn'),
    dataImportBtn: document.getElementById('dataImportBtn'),
    toast: document.getElementById('toast')
  };

  /* ---------- 유틸 ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 콤마 제거 후 숫자 문자열 반환
  function stripComma(v) {
    return String(v == null ? '' : v).replace(/,/g, '').trim();
  }

  function formatInt(v) {
    var raw = stripComma(v);
    if (raw === '' || !/^-?\d+$/.test(raw)) return raw;
    return Number(raw).toLocaleString('ko-KR');
  }

  function activeBrand() {
    return state.brands.filter(function (b) { return b.id === state.activeBrandId; })[0] || null;
  }

  function findItem(itemId) {
    var b = activeBrand();
    if (!b) return null;
    for (var i = 0; i < b.categories.length; i++) {
      var list = b.categories[i].items;
      for (var j = 0; j < list.length; j++) {
        if (list[j].id === itemId) return list[j];
      }
    }
    return null;
  }

  function markDirty() {
    state.dirty = true;
  }

  var toastTimer = null;
  function toast(msg, isError) {
    el.toast.textContent = msg;
    el.toast.className = 'toast is-show' + (isError ? ' is-error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.className = 'toast'; }, 2600);
  }

  /* ---------- 검증 ---------- */
  // mode: 'live' = 중복만 검사(입력 중), 'full' = 저장 시 전체 검사
  function validate(mode) {
    var errors = {};
    var b = activeBrand();
    if (!b) return errors;

    var seen = {};   // 브랜드 내 상품명 중복 판정용
    b.categories.forEach(function (cat) {
      cat.items.forEach(function (it) {
        var e = {};
        var name = String(it.name || '').trim();

        if (name === '') {
          if (mode === 'full') e.name = '상품명을 입력하세요.';
        } else {
          var key = name.toLowerCase();
          if (seen[key]) e.name = '같은 브랜드 내 중복된 상품명입니다.';
          seen[key] = true;
        }

        if (mode === 'full') {
          var ship = stripComma(it.shipPrice);
          var retail = stripComma(it.retailPrice);
          var qty = stripComma(it.qtyFactor);

          if (!/^\d+$/.test(ship)) e.shipPrice = '정수만 입력하세요.';
          if (!/^\d+$/.test(retail)) e.retailPrice = '정수만 입력하세요.';
          if (!/^\d*\.?\d+$/.test(qty) || Number(qty) <= 0) e.qtyFactor = '0보다 큰 숫자.';
        }

        if (Object.keys(e).length) errors[it.id] = e;
      });
    });
    return errors;
  }

  // 재렌더 없이 에러 표시만 갱신 (입력 포커스 유지)
  function paintErrors() {
    Array.prototype.forEach.call(el.area.querySelectorAll('.row'), function (row) {
      var e = state.errors[row.dataset.itemId] || {};
      Array.prototype.forEach.call(row.querySelectorAll('.cell'), function (cell) {
        var field = cell.dataset.field;
        var input = cell.querySelector('.input');
        var msgEl = cell.querySelector('.cell__error');
        var msg = e[field] || '';
        if (input) input.classList.toggle('is-error', !!msg);
        if (msg && !msgEl) {
          msgEl = document.createElement('span');
          msgEl.className = 'cell__error';
          cell.appendChild(msgEl);
        }
        if (msgEl) {
          msgEl.textContent = msg;
          msgEl.style.display = msg ? '' : 'none';
        }
      });
    });
  }

  /* ---------- 렌더 ---------- */
  function render() {
    renderTabs();
    renderCategories();
    paintErrors();
  }

  function renderTabs() {
    var html = state.brands.map(function (b) {
      return '<button type="button" class="brand-tab' + (b.id === state.activeBrandId ? ' is-active' : '') +
        '" data-action="select-brand" data-id="' + b.id + '">' + esc(b.name) +
        '<span class="brand-tab__del" data-action="del-brand" data-id="' + b.id +
        '" title="브랜드 삭제" role="button">&times;</span></button>';
    }).join('');
    html += '<button type="button" class="brand-tab brand-tab--add" data-action="add-brand">메뉴 추가 +</button>';
    el.tabs.innerHTML = html;
  }

  function renderCategories() {
    var b = activeBrand();
    if (!b) {
      el.area.innerHTML = '<p class="empty-msg">브랜드를 추가해 주세요.</p>';
      return;
    }
    var html = b.categories.map(renderDepth1).join('');
    html += '<button type="button" class="btn-add-dashed" data-action="add-depth1">+ 1depth 카테고리 신규 추가</button>';
    el.area.innerHTML = html;
  }

  function renderDepth1(cat) {
    var rows = cat.items.length
      ? cat.items.map(renderRow).join('')
      : '<p class="empty-msg">등록된 2depth 상품이 없습니다.</p>';

    return '' +
      '<section class="depth1" data-cat-id="' + cat.id + '">' +
        '<div class="depth1__head">' +
          '<input class="depth1__title" type="text" value="' + esc(cat.name) +
            '" data-field="cat-name" data-id="' + cat.id + '" placeholder="1depth 카테고리명">' +
          '<div class="depth1__actions">' +
            '<button type="button" class="btn btn-add2" data-action="add-item" data-id="' + cat.id + '">+ 2depth 추가</button>' +
            '<button type="button" class="btn btn-del-depth1" data-action="del-depth1" data-id="' + cat.id + '">삭제</button>' +
          '</div>' +
        '</div>' +
        '<div class="depth1__body">' +
          '<div class="row-head">' +
            '<span>2depth(상품명)</span><span>출고가액(원)</span><span>상품가액(원)</span><span>수량 환산값</span><span></span>' +
          '</div>' +
          rows +
        '</div>' +
      '</section>';
  }

  function renderRow(it) {
    function cell(field, label, value, placeholder) {
      return '<div class="cell" data-field="' + field + '" data-label="' + label + '">' +
        '<input class="input" type="text" data-field="' + field + '" data-id="' + it.id +
        '" value="' + esc(value) + '" placeholder="' + placeholder + '"></div>';
    }
    return '' +
      '<div class="row" data-item-id="' + it.id + '">' +
        cell('name', '2depth(상품명)', it.name, '상품명') +
        cell('shipPrice', '출고가액(원)', formatInt(it.shipPrice), '0') +
        cell('retailPrice', '상품가액(원)', formatInt(it.retailPrice), '0') +
        cell('qtyFactor', '수량 환산값', it.qtyFactor, '1') +
        '<div class="cell">' +
          '<button type="button" class="btn btn-del-row" data-action="del-item" data-id="' + it.id + '">삭제</button>' +
        '</div>' +
      '</div>';
  }

  /* ---------- 이벤트 ---------- */
  document.addEventListener('click', function (ev) {
    var target = ev.target.closest('[data-action]');
    if (!target) return;
    var action = target.dataset.action;
    var id = target.dataset.id;

    if (action === 'select-brand') { selectBrand(id); }
    else if (action === 'del-brand') { ev.stopPropagation(); delBrand(id); }
    else if (action === 'add-brand') { addBrand(); }
    else if (action === 'add-depth1') { addDepth1(); }
    else if (action === 'del-depth1') { delDepth1(id); }
    else if (action === 'add-item') { addItem(id); }
    else if (action === 'del-item') { delItem(id); }
  });

  // 입력 중에는 state만 갱신하고 중복 검사만 즉시 반영
  el.area.addEventListener('input', function (ev) {
    var input = ev.target;
    var field = input.dataset.field;
    if (!field) return;

    if (field === 'cat-name') {
      var b = activeBrand();
      var cat = b && b.categories.filter(function (c) { return c.id === input.dataset.id; })[0];
      if (cat) { cat.name = input.value; markDirty(); }
      return;
    }

    var it = findItem(input.dataset.id);
    if (!it) return;
    it[field] = input.value;
    markDirty();

    if (field === 'name') {
      state.errors = mergeErrors(state.errors, validate('live'), ['name']);
      paintErrors();
    }
  });

  // 가격 필드는 blur 시 콤마 포맷
  el.area.addEventListener('focusout', function (ev) {
    var input = ev.target;
    var field = input.dataset.field;
    if (field !== 'shipPrice' && field !== 'retailPrice') return;
    var it = findItem(input.dataset.id);
    if (!it) return;
    it[field] = stripComma(it[field]);
    input.value = formatInt(it[field]);
  });

  // 포커스 시 원본 숫자로 되돌림
  el.area.addEventListener('focusin', function (ev) {
    var input = ev.target;
    var field = input.dataset.field;
    if (field !== 'shipPrice' && field !== 'retailPrice') return;
    input.value = stripComma(input.value);
  });

  el.saveBtn.addEventListener('click', save);

  // 사이드바: 현재 페이지 및 미구현 메뉴는 이동 차단
  document.querySelectorAll('.nav-item').forEach(function (a) {
    a.addEventListener('click', function (ev) {
      if (a.classList.contains('is-active')) { ev.preventDefault(); return; }
      if (a.getAttribute('href') === '#') {
        ev.preventDefault();
        toast('해당 페이지는 준비 중입니다.');
      }
    });
  });

  window.addEventListener('beforeunload', function (ev) {
    if (!state.dirty) return;
    ev.preventDefault();
    ev.returnValue = '';
  });

  // live 검사 결과로 지정 필드만 덮어쓰기 (full 검사로 표시된 다른 에러 유지)
  function mergeErrors(prev, next, fields) {
    var out = {};
    Object.keys(prev).forEach(function (id) {
      var e = {};
      Object.keys(prev[id]).forEach(function (f) {
        if (fields.indexOf(f) === -1) e[f] = prev[id][f];
      });
      if (Object.keys(e).length) out[id] = e;
    });
    Object.keys(next).forEach(function (id) {
      fields.forEach(function (f) {
        if (next[id][f]) {
          out[id] = out[id] || {};
          out[id][f] = next[id][f];
        }
      });
    });
    return out;
  }

  /* ---------- 액션 ---------- */
  function selectBrand(id) {
    if (id === state.activeBrandId) return;
    state.activeBrandId = id;
    state.errors = {};
    render();
  }

  function addBrand() {
    var name = (prompt('추가할 브랜드명을 입력하세요.') || '').trim();
    if (!name) return;
    if (state.brands.some(function (b) { return b.name.trim().toLowerCase() === name.toLowerCase(); })) {
      toast('이미 존재하는 브랜드명입니다.', true);
      return;
    }
    var b = { id: uid('b'), name: name, categories: [] };
    state.brands.push(b);
    state.activeBrandId = b.id;
    state.errors = {};
    markDirty();
    render();
  }

  function delBrand(id) {
    var b = state.brands.filter(function (x) { return x.id === id; })[0];
    if (!b) return;
    var itemCount = b.categories.reduce(function (n, c) { return n + c.items.length; }, 0);
    if (!confirm('"' + b.name + '" 브랜드를 삭제합니다.\n하위 1depth 카테고리 ' + b.categories.length +
      '개와 2depth 상품 ' + itemCount + '개가 모두 삭제됩니다. 계속할까요?')) return;

    state.brands = state.brands.filter(function (x) { return x.id !== id; });
    if (state.activeBrandId === id) {
      state.activeBrandId = state.brands.length ? state.brands[0].id : null;
    }
    state.errors = {};
    markDirty();
    render();
  }

  function addDepth1() {
    var b = activeBrand();
    if (!b) return;
    b.categories.push({ id: uid('c'), name: '새 카테고리', items: [] });
    markDirty();
    render();
    // 새 섹션 제목 바로 편집
    var titles = el.area.querySelectorAll('.depth1__title');
    var last = titles[titles.length - 1];
    if (last) { last.focus(); last.select(); }
  }

  function delDepth1(id) {
    var b = activeBrand();
    if (!b) return;
    var cat = b.categories.filter(function (c) { return c.id === id; })[0];
    if (!cat) return;
    if (!confirm('"' + cat.name + '" 카테고리를 삭제합니다.\n하위 2depth 상품 ' + cat.items.length +
      '개가 모두 삭제됩니다. 계속할까요?')) return;

    b.categories = b.categories.filter(function (c) { return c.id !== id; });
    markDirty();
    render();
  }

  function addItem(catId) {
    var b = activeBrand();
    if (!b) return;
    var cat = b.categories.filter(function (c) { return c.id === catId; })[0];
    if (!cat) return;
    cat.items.push({ id: uid('i'), name: '', shipPrice: '', retailPrice: '', qtyFactor: '1' });
    markDirty();
    render();
    var rows = el.area.querySelectorAll('.depth1[data-cat-id="' + catId + '"] .row');
    var lastRow = rows[rows.length - 1];
    if (lastRow) lastRow.querySelector('.input').focus();
  }

  function delItem(itemId) {
    var b = activeBrand();
    if (!b) return;
    b.categories.forEach(function (cat) {
      cat.items = cat.items.filter(function (it) { return it.id !== itemId; });
    });
    delete state.errors[itemId];
    markDirty();
    render();
  }

  /* ---------- 저장 ---------- */
  function save() {
    trimNames();
    state.errors = validate('full');
    render();

    var count = Object.keys(state.errors).length;
    if (count) {
      toast('입력값을 확인해 주세요. (오류 ' + count + '건)', true);
      var first = el.area.querySelector('.input.is-error');
      if (first) { first.focus(); first.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      return;
    }

    try {
      Store.save(toPayload());
      state.dirty = false;
      toast('변경사항이 저장되었습니다.');
    } catch (e) {
      console.error(e);
      toast('저장에 실패했습니다.', true);
    }
  }

  function trimNames() {
    state.brands.forEach(function (b) {
      b.name = b.name.trim();
      b.categories.forEach(function (c) {
        c.name = c.name.trim();
        c.items.forEach(function (it) { it.name = String(it.name || '').trim(); });
      });
    });
  }

  // 저장 포맷: 숫자 필드는 number 로 정규화
  function toPayload() {
    return {
      brands: state.brands.map(function (b) {
        return {
          id: b.id,
          name: b.name,
          categories: b.categories.map(function (c) {
            return {
              id: c.id,
              name: c.name,
              items: c.items.map(function (it) {
                return {
                  id: it.id,
                  name: it.name,
                  shipPrice: Number(stripComma(it.shipPrice)) || 0,
                  retailPrice: Number(stripComma(it.retailPrice)) || 0,
                  qtyFactor: Number(stripComma(it.qtyFactor)) || 1
                };
              })
            };
          })
        };
      })
    };
  }

  // 저장 payload(숫자형) → 편집 상태(문자열형)로 로드 후 렌더
  function applySettings(data) {
    var d = data || { brands: [] };
    state.brands = (d.brands || []).map(function (b) {
      return {
        id: b.id || uid('b'),
        name: b.name || '',
        categories: (b.categories || []).map(function (c) {
          return {
            id: c.id || uid('c'),
            name: c.name || '',
            items: (c.items || []).map(function (it) {
              return {
                id: it.id || uid('i'),
                name: it.name || '',
                shipPrice: it.shipPrice == null ? '' : String(it.shipPrice),
                retailPrice: it.retailPrice == null ? '' : String(it.retailPrice),
                qtyFactor: it.qtyFactor == null ? '1' : String(it.qtyFactor)
              };
            })
          };
        })
      };
    });
    state.activeBrandId = state.brands.length ? state.brands[0].id : null;
    state.dirty = false;
    state.errors = {};
    render();
  }

  /* ---------- 데이터 백업/복원: 공용 모듈(S.Backup)에 연결 ---------- */
  if (S && el.dataExportBtn) {
    el.dataExportBtn.addEventListener('click', function () { S.Backup.exportData({ toast: toast }); });
    el.dataImportBtn.addEventListener('click', function () {
      // 가져오기 성공 시 설정 페이지 즉시 반영
      S.Backup.importData({ toast: toast, onImported: function (d) { applySettings(d.settings); } });
    });
  }

  /* ---------- 초기화 ---------- */
  function init() {
    applySettings(Store.load() || seed());
  }

  init();
})();
