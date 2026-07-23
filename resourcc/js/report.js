/* 출고 보고서 - 데이터 주도 렌더링 (집계는 settlement-core 재사용) */
(function () {
  'use strict';

  var S = window.Settlement;

  // 1depth 기본 색상 계열 (2depth는 같은 색상의 명도 변형)
  var HUES = [212, 187, 28, 150, 268, 340, 45, 200];

  var state = {
    brands: [],
    ordersMap: {},
    isMock: false,
    activeBrand: null,
    month: '',              // 'YYYY-MM'
    metric: 'qty',          // 'qty' | 'amount'
    delta: 'mom',           // 'mom' | 'yoy'
    checked: {},            // { 2depth명: true }
    years: [],
    chartAView: 'donut',    // 'donut' | 'stack'
    chartBView: 'total',    // 'total' | 'line' (1depth 라인별)
    expanded: {},           // 라인별 집계 펼침 { 1depth명: true }
    treeExpanded: {},       // 상품 필터 트리 펼침 { 1depth명: true } (기본 접힘)
    amtExpanded: {},        // 상품별 금액 집계 펼침 (기본 접힘)
    amtSort: null,          // 상품별 금액 집계 정렬 { key:'qty'|'ship'|'retail', dir:'asc'|'desc' }
    accSort: null           // 전월 대비 집계 정렬 { key:'qty'|'ship'|'delta', dir:'asc'|'desc' }
  };

  var charts = { A: null, B: null };

  var el = {
    mockFlag: document.getElementById('mockFlag'),
    tabs: document.getElementById('brandTabs'),
    monthInput: document.getElementById('monthInput'),
    metricSeg: document.getElementById('metricSeg'),
    deltaSeg: document.getElementById('deltaSeg'),
    kpiRow: document.getElementById('kpiRow'),
    filterTree: document.getElementById('filterTree'),
    filterToggleAll: document.getElementById('filterToggleAll'),
    chartAView: document.getElementById('chartAView'),
    chartBView: document.getElementById('chartBView'),
    chartALegend: document.getElementById('chartALegend'),
    chartAPrintLegend: document.getElementById('chartAPrintLegend'),
    chartAPrintImg: document.getElementById('chartAPrintImg'),
    chartBPrintImg: document.getElementById('chartBPrintImg'),
    chartA: document.getElementById('chartA'),
    chartB: document.getElementById('chartB'),
    yearBtn: document.getElementById('yearBtn'),
    yearPanel: document.getElementById('yearPanel'),
    amtSub: document.getElementById('amtSub'),
    amtTable: document.getElementById('amtTable'),
    pdfBtn: document.getElementById('pdfBtn'),
    printHead: document.getElementById('printHead'),
    tableSub: document.getElementById('tableSub'),
    accTable: document.getElementById('accTable'),
    toast: document.getElementById('toast')
  };

  /* ================= 유틸 ================= */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.className = 'toast is-show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.className = 'toast'; }, 2600);
  }

  function catColor(i) { return 'hsl(' + HUES[i % HUES.length] + ',60%,42%)'; }

  function itemColor(i, j, n) {
    var l = 34 + (j + 1) * (44 / (n + 1));
    return 'hsl(' + HUES[i % HUES.length] + ',56%,' + l.toFixed(1) + '%)';
  }

  function fmtNum(v) {
    var n = Number(v) || 0;
    return Number.isInteger(n) ? n.toLocaleString('ko-KR') : n.toFixed(1);
  }

  function unit() { return state.metric === 'qty' ? '권' : '원'; }

  function fmtMetric(v) {
    return state.metric === 'qty' ? fmtNum(v) : S.fmtMoney(v);
  }

  // 출고 비율 표시(소수 1자리) — 값은 core의 agg.ratio(브랜드 전체 수량 대비) 재사용
  function fmtRatio1(v) {
    return (Math.round((Number(v) || 0) * 10) / 10).toFixed(1) + '%';
  }

  function brandObj() {
    return state.brands.filter(function (b) { return b.name === state.activeBrand; })[0] || null;
  }

  function brandOrders() { return state.ordersMap[state.activeBrand] || []; }

  function allowedNames() {
    return Object.keys(state.checked).filter(function (k) { return state.checked[k]; });
  }

  // 체크된 2depth가 1개 이상인 1depth만
  function visibleCats() {
    var b = brandObj();
    if (!b) return [];
    return (b.categories || []).map(function (c) {
      return { name: c.name, items: (c.items || []).filter(function (it) { return state.checked[it.name]; }) };
    }).filter(function (c) { return c.items.length; });
  }

  // 기간 집계 (core 재사용)
  function aggOf(range) {
    var b = brandObj();
    if (!b) return null;
    return S.aggregate(S.filterByRange(brandOrders(), range.start, range.end), b, allowedNames());
  }

  function metricOfItem(agg, name) {
    var e = agg.byItem[name];
    if (!e) return 0;
    return state.metric === 'qty' ? e.qty : e.shipAmount;
  }

  function metricOfCat(agg, name) {
    var e = agg.byCategory[name];
    if (!e) return 0;
    return state.metric === 'qty' ? e.qty : e.shipAmount;
  }

  function totalOf(agg) {
    if (!agg) return 0;
    if (state.metric === 'qty') return agg.totalQty;
    return Object.keys(agg.byItem).reduce(function (s, k) { return s + agg.byItem[k].shipAmount; }, 0);
  }

  function curRange() {
    var m = S.parseMonth(state.month);
    return S.monthRange(m.year, m.month0);
  }

  function prevRange() {
    var m = S.parseMonth(state.month);
    return state.delta === 'mom'
      ? S.monthRange(m.year, m.month0 - 1)
      : S.monthRange(m.year - 1, m.month0);
  }

  function deltaLabel() { return state.delta === 'mom' ? '전월 대비' : '전년 동기 대비'; }

  // 증감률 뱃지 (prev 0 → 신규)
  function badgeHtml(cur, prev) {
    if (!prev) {
      return cur
        ? '<span class="badge badge--up">신규 ▲</span>'
        : '<span class="badge badge--flat">–</span>';
    }
    var pct = ((cur - prev) / prev) * 100;
    var r = Math.round(pct * 10) / 10;
    if (Math.abs(r) < 0.05) return '<span class="badge badge--flat">0% –</span>';
    var cls = r > 0 ? 'badge--up' : 'badge--down';
    return '<span class="badge ' + cls + '">' + (r > 0 ? '+' : '') + r + '% ' + (r > 0 ? '▲' : '▼') + '</span>';
  }

  /* ================= 렌더 ================= */
  function render() {
    renderTabs();
    renderControls();
    renderTree();
    renderKpi();
    renderChartA();
    renderChartB();
    renderAmountTable();
    renderTable();
    renderPrintHead();
  }

  // 인쇄물 상단에 현재 조회 조건 기록
  function renderPrintHead() {
    var total = allowedNames().length;
    var b = brandObj();
    var all = b ? S.flatItems(b).length : 0;
    el.printHead.innerHTML =
      '<span><strong>브랜드</strong> ' + esc(state.activeBrand || '-') + '</span>' +
      '<span><strong>기준 월</strong> ' + esc(state.month) + '</span>' +
      '<span><strong>지표</strong> ' + (state.metric === 'qty' ? '수량(권)' : '금액(원)') + '</span>' +
      '<span><strong>증감 기준</strong> ' + deltaLabel() + '</span>' +
      '<span><strong>상품 필터</strong> ' + total + '/' + all + '개</span>' +
      '<span><strong>출력일</strong> ' + S.toYMD(new Date()) + '</span>' +
      (state.isMock ? '<span><strong>※ Mock 데이터</strong></span>' : '');
  }

  function renderTabs() {
    el.tabs.innerHTML = state.brands.map(function (b) {
      return '<button type="button" class="brand-tab' + (b.name === state.activeBrand ? ' is-active' : '') +
        '" data-brand="' + esc(b.name) + '">' + esc(b.name) + '</button>';
    }).join('');
  }

  function renderControls() {
    el.monthInput.value = state.month;
    Array.prototype.forEach.call(el.metricSeg.children, function (b) {
      b.classList.toggle('is-active', b.dataset.metric === state.metric);
    });
    Array.prototype.forEach.call(el.deltaSeg.children, function (b) {
      b.classList.toggle('is-active', b.dataset.delta === state.delta);
    });
    Array.prototype.forEach.call(el.chartAView.children, function (b) {
      b.classList.toggle('is-active', b.dataset.view === state.chartAView);
    });
    Array.prototype.forEach.call(el.chartBView.children, function (b) {
      b.classList.toggle('is-active', b.dataset.bview === state.chartBView);
    });
    el.yearBtn.textContent = (state.years.length ? state.years.join(', ') : '연도 선택') + ' ▾';
    renderYearPanel();
  }

  function renderYearPanel() {
    var years = availableYears();
    el.yearPanel.innerHTML = years.map(function (y) {
      return '<label class="dropdown__row"><input type="checkbox" data-year="' + y + '"' +
        (state.years.indexOf(y) > -1 ? ' checked' : '') + '>' + y + '년</label>';
    }).join('');
  }

  function availableYears() {
    var set = {};
    brandOrders().forEach(function (o) { set[Number(String(o.date).slice(0, 4))] = true; });
    set[new Date().getFullYear()] = true;
    return Object.keys(set).map(Number).sort(function (a, b) { return b - a; });
  }

  function renderTree() {
    var b = brandObj();
    if (!b || !b.categories.length) {
      el.filterTree.innerHTML = '<p class="empty-msg">등록된 상품이 없습니다.</p>';
      return;
    }
    el.filterTree.innerHTML = b.categories.map(function (c, i) {
      var items = c.items || [];
      var checkedN = items.filter(function (it) { return state.checked[it.name]; }).length;
      var allOn = items.length && checkedN === items.length;
      var someOn = checkedN > 0;
      var open = !!state.treeExpanded[c.name];

      // 카운트 배지: 전부 체크면 (n), 아니면 (k/n)
      var badge = items.length
        ? '<span class="tree__count">(' + (allOn ? items.length : checkedN + '/' + items.length) + ')</span>'
        : '';

      // 부모 행은 label 대신 div — 체크박스 외 영역 클릭은 펼침 토글용
      var head = '<div class="tree__node tree__node--parent" data-cat-row="' + esc(c.name) + '">' +
        '<span class="tree__caret' + (open ? ' is-open' : '') + '">▸</span>' +
        '<input type="checkbox" data-cat="' + esc(c.name) + '"' + (allOn ? ' checked' : '') +
        (!allOn && someOn ? ' data-indeterminate="1"' : '') + '>' +
        '<span class="tree__swatch" style="background:' + catColor(i) + '"></span>' +
        '<span class="tree__name">' + esc(c.name) + '</span>' + badge + '</div>';

      var kids = items.map(function (it, j) {
        return '<label class="tree__node tree__node--child">' +
          '<input type="checkbox" data-item="' + esc(it.name) + '"' + (state.checked[it.name] ? ' checked' : '') + '>' +
          '<span class="tree__swatch" style="background:' + itemColor(i, j, items.length) + '"></span>' +
          '<span class="tree__name" title="' + esc(it.name) + '">' + esc(it.name) + '</span></label>';
      }).join('');

      // 자식은 접힘 상태에서 숨김
      return '<div class="tree__group">' + head +
        '<div class="tree__children' + (open ? ' is-open' : '') + '">' + kids + '</div></div>';
    }).join('');

    // 부분 선택 표시
    Array.prototype.forEach.call(el.filterTree.querySelectorAll('[data-indeterminate]'), function (cb) {
      cb.indeterminate = true;
    });

    applyFilterCap();
  }

  // 필터 목록 높이 상한: 접힌 1depth 12개 기준. 초과 시(라인 추가·행 펼침) 목록 내부 스크롤.
  function applyFilterCap() {
    var parent = el.filterTree.querySelector('.tree__node--parent');
    if (!parent) { el.filterTree.style.maxHeight = ''; return; }   // 빈 목록 → 상한 해제
    var rowH = parent.offsetHeight;               // 접힌 1depth 행 높이(실측)
    var groupH = rowH + 12;                        // .tree__group 상하 패딩(6+6)
    var cap = Math.round(groupH * 12 + 11);        // 12그룹 + 그룹 경계선 11개(첫 그룹 제외)
    el.filterTree.style.maxHeight = cap + 'px';
  }

  function renderKpi() {
    var cur = aggOf(curRange());
    var prev = aggOf(prevRange());
    if (!cur) { el.kpiRow.innerHTML = ''; return; }

    var qty = cur.totalQty;
    var amount = Object.keys(cur.byItem).reduce(function (s, k) { return s + cur.byItem[k].shipAmount; }, 0);
    var orderCount = S.filterByRange(brandOrders(), curRange().start, curRange().end).length;

    el.kpiRow.innerHTML = [
      kpi('총 출고 수량', fmtNum(qty), '권'),
      kpi('총 출고금액', S.fmtMoney(amount), '원'),
      kpi('주문 건수', fmtNum(orderCount), '건'),
      '<div class="kpi"><div class="kpi__label">' + deltaLabel() + ' (' + (state.metric === 'qty' ? '수량' : '금액') + ')</div>' +
        '<div class="kpi__value">' + badgeHtml(totalOf(cur), totalOf(prev)) + '</div></div>'
    ].join('');
  }

  function kpi(label, value, u) {
    return '<div class="kpi"><div class="kpi__label">' + label + '</div>' +
      '<div class="kpi__value">' + value + '<span class="kpi__unit">' + u + '</span></div></div>';
  }

  /* ---------- Chart A ---------- */
  function renderChartA() {
    var cats = visibleCats();
    if (!cats.length) {
      destroy('A');
      el.chartALegend.innerHTML = '<p class="empty-msg">선택된 상품이 없습니다.</p>';
      if (el.chartAPrintLegend) el.chartAPrintLegend.innerHTML = '';
      return;
    }
    if (state.chartAView === 'donut') renderDonut(cats);
    else renderStack(cats);
  }

  function renderDonut(cats) {
    var agg = aggOf(curRange());
    var brandTotal = totalOf(agg);   // 브랜드 전체(선택된 상품 합계)

    // 데이터셋별로 자기 라벨/비중 기준을 직접 보유 → 툴팁이 호버된 링만 해석
    var lineRing = { data: [], colors: [], labels: [] };                       // 1depth 상품 라인
    var itemRing = { data: [], colors: [], labels: [], parents: [], bases: [] }; // 2depth 상품

    cats.forEach(function (c, i) {
      var catTotal = metricOfCat(agg, c.name);
      lineRing.labels.push(c.name);
      lineRing.data.push(catTotal);
      lineRing.colors.push(catColor(i));
      c.items.forEach(function (it, j) {
        itemRing.labels.push(it.name);
        itemRing.data.push(metricOfItem(agg, it.name));
        itemRing.colors.push(itemColor(i, j, c.items.length));
        itemRing.parents.push(c.name);     // 소속 1depth 라인
        itemRing.bases.push(catTotal);     // 라인 내 비중 기준
      });
    });

    // 링 배치 유지(안쪽=2depth, 바깥=1depth). 각 데이터셋에 _kind로 자기 정체성 부여.
    var data = {
      datasets: [
        {
          data: lineRing.data, backgroundColor: lineRing.colors,
          borderWidth: 1, borderColor: '#fff', weight: 1,
          _kind: 'line', _labels: lineRing.labels, _base: brandTotal
        },
        {
          data: itemRing.data, backgroundColor: itemRing.colors,
          borderWidth: 1, borderColor: '#fff', weight: 1.3,
          _kind: 'item', _labels: itemRing.labels, _parents: itemRing.parents, _bases: itemRing.bases
        }
      ]
    };

    var options = {
      responsive: true, maintainAspectRatio: false,
      cutout: '34%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            // 제목: 호버된 데이터셋의 자기 라벨(전역 labels 미사용)
            title: function (items) {
              if (!items.length) return '';
              var ds = items[0].dataset;
              return (ds._labels && ds._labels[items[0].dataIndex]) || '';
            },
            label: function (ctx) {
              var ds = ctx.dataset;
              var val = fmtMetric(ctx.raw) + unit();
              if (ds._kind === 'item') {
                var base = (ds._bases && ds._bases[ctx.dataIndex]) || 0;
                var pi = base ? Math.round((ctx.raw / base) * 1000) / 10 : 0;
                return val + ' · ' + (ds._parents[ctx.dataIndex] || '') + ' 내 ' + pi + '%';
              }
              var b = ds._base || 0;
              var pl = b ? Math.round((ctx.raw / b) * 1000) / 10 : 0;
              return val + ' · 브랜드 전체 대비 ' + pl + '%';
            }
          }
        }
      }
    };

    ensureChart('A', 'doughnut', data, options);
    renderLegend(cats, agg);
  }

  function renderStack(cats) {
    var m = S.parseMonth(state.month);
    var buckets = weekBuckets(m.year, m.month0);
    var aggs = buckets.map(function (bk) { return aggOf(bk); });

    var datasets = [];
    cats.forEach(function (c, i) {
      c.items.forEach(function (it, j) {
        datasets.push({
          label: it.name,
          stack: c.name,                     // 1depth 단위로 막대 분리, 내부는 2depth 누적
          backgroundColor: itemColor(i, j, c.items.length),
          data: aggs.map(function (a) { return metricOfItem(a, it.name); })
        });
      });
    });

    var data = { labels: buckets.map(function (b) { return b.label; }), datasets: datasets };

    var options = {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { font: { size: 11 } } },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: { font: { size: 11 }, callback: function (v) { return fmtMetric(v); } }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function (ctx) {
              return ctx.dataset.stack + ' / ' + ctx.dataset.label + ': ' + fmtMetric(ctx.raw) + unit();
            }
          }
        }
      }
    };

    ensureChart('A', 'bar', data, options);
    renderLegend(cats, aggOf(curRange()));
  }

  // 선택 월의 주차 구간
  function weekBuckets(year, month0) {
    var last = new Date(year, month0 + 1, 0).getDate();
    var out = [], d = 1, w = 1;
    while (d <= last) {
      var e = Math.min(d + 6, last);
      out.push({
        label: w + '주 (' + d + '~' + e + ')',
        start: S.toYMD(new Date(year, month0, d)),
        end: S.toYMD(new Date(year, month0, e))
      });
      d = e + 1; w++;
    }
    return out;
  }

  function renderLegend(cats, agg) {
    // 화면용 HTML 범례 (position right)
    el.chartALegend.innerHTML = cats.map(function (c, i) {
      return '<div class="legend__item">' +
        '<span class="legend__swatch" style="background:' + catColor(i) + '"></span>' +
        '<span class="legend__name" title="' + esc(c.name) + '">' + esc(c.name) + '</span>' +
        '<span class="legend__val">' + fmtMetric(metricOfCat(agg, c.name)) + '</span></div>';
    }).join('');

    // 인쇄용 HTML <ul> 범례 (동일 데이터, 캔버스 크기와 무관 → 잘림 없음)
    if (el.chartAPrintLegend) {
      el.chartAPrintLegend.innerHTML = cats.map(function (c, i) {
        return '<li class="legend-print__item">' +
          '<span class="legend-print__swatch" style="background:' + catColor(i) + '"></span>' +
          '<span class="legend-print__name">' + esc(c.name) + '</span>' +
          '<span class="legend-print__val">' + fmtMetric(metricOfCat(agg, c.name)) + '</span></li>';
      }).join('');
    }
  }

  /* ---------- Chart B ---------- */
  // 연도별 선 스타일: 최근 연도 실선, 이전 연도로 갈수록 파선
  var DASH = [[], [6, 4], [2, 3], [10, 3, 2, 3]];
  var POINT = ['circle', 'rectRot', 'triangle', 'rect'];

  function renderChartB() {
    var b = brandObj();
    if (!b || !state.years.length) { destroy('B'); return; }

    var years = state.years.slice().sort();           // 오름차순 (마지막 = 최근)
    // 연도×월 집계는 한 번만 계산해 두 모드가 공유
    var monthly = {};
    years.forEach(function (y) {
      monthly[y] = [];
      for (var m = 0; m < 12; m++) monthly[y].push(aggOf(S.monthRange(y, m)));
    });

    var datasets = state.chartBView === 'total'
      ? buildTotalSeries(years, monthly)
      : buildLineSeries(years, monthly);

    var labels = [];
    for (var i = 1; i <= 12; i++) labels.push(i + '월');

    var options = {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { beginAtZero: true, ticks: { font: { size: 11 }, callback: function (v) { return fmtMetric(v); } } }
      },
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 6, boxHeight: 6, pointStyleWidth: 6, font: { size: 12 } } },
        tooltip: {
          callbacks: {
            label: function (ctx) { return ctx.dataset.label + ': ' + fmtMetric(ctx.raw) + unit(); }
          }
        }
      }
    };

    ensureChart('B', 'line', { labels: labels, datasets: datasets }, options);
  }

  // 전체 합산: 연도당 1개 선
  function buildTotalSeries(years, monthly) {
    return years.map(function (y, idx) {
      var color = 'hsl(' + HUES[idx % HUES.length] + ',62%,45%)';
      return {
        label: y + '년',
        data: monthly[y].map(totalOf),
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        tension: .3,
        pointRadius: 3
      };
    });
  }

  // 라인별: 색상 = 1depth(다른 차트와 동일), 선 스타일 = 연도
  function buildLineSeries(years, monthly) {
    var out = [];
    var multiYear = years.length > 1;   // 연도 2개+ 일 때만 범례에 연도 병기(선 구분용)
    visibleCats().forEach(function (c, i) {
      years.forEach(function (y, yi) {
        var age = years.length - 1 - yi;             // 0 = 최근 연도
        var color = catColor(i);
        out.push({
          label: multiYear ? (c.name + ' · ' + y + '년') : c.name,
          data: monthly[y].map(function (a) { return metricOfCat(a, c.name); }),
          borderColor: color,
          backgroundColor: color,
          borderDash: DASH[Math.min(age, DASH.length - 1)],
          pointStyle: POINT[Math.min(age, POINT.length - 1)],
          borderWidth: age === 0 ? 2.4 : 1.6,
          tension: .3,
          pointRadius: 3
        });
      });
    });
    return out;
  }

  /* ---------- Chart 인스턴스 관리 ---------- */
  function chartPrintImg(key) { return key === 'A' ? el.chartAPrintImg : el.chartBPrintImg; }

  // 렌더 완료 후 인쇄용 이미지 스냅샷 갱신 (다음 프레임 → 빈 스냅샷 방지)
  function queueSnapshot(key) {
    var img = chartPrintImg(key);
    if (!img) return;
    requestAnimationFrame(function () {
      var c = charts[key];
      if (c) { try { img.src = c.toBase64Image(); } catch (e) { /* 캡처 실패 무시 */ } }
    });
  }

  // 타입이 같으면 데이터만 교체해 update, 다르면 재생성
  function ensureChart(key, type, data, options) {
    var canvas = key === 'A' ? el.chartA : el.chartB;
    var c = charts[key];
    options.devicePixelRatio = Math.max(2, window.devicePixelRatio || 1);   // 인쇄 시 선명도 확보
    options.animation = false;
    if (c && c.config.type === type) {
      c.data = data;
      c.options = options;
      c.update();
    } else {
      if (c) c.destroy();
      charts[key] = new Chart(canvas.getContext('2d'), { type: type, data: data, options: options });
    }
    queueSnapshot(key);
  }

  function destroy(key) {
    if (charts[key]) { charts[key].destroy(); charts[key] = null; }
    var img = chartPrintImg(key);
    if (img) img.removeAttribute('src');   // 데이터 없으면 인쇄 이미지도 비움
  }

  /* ---------- 정렬 유틸 ---------- */
  // 증감률(%) 정렬용 수치 — 신규(이전 0, 현재>0)는 최상위로
  function deltaPct(cur, prev) {
    var c = cur || 0, p = prev || 0;
    if (!p) return c ? Infinity : 0;
    return ((c - p) / p) * 100;
  }

  // 집계 엔트리에서 정렬 키에 해당하는 값 추출
  function sortVal(entry, key) {
    if (!entry) return 0;
    if (key === 'qty') return entry.qty || 0;
    if (key === 'retail') return entry.retailAmount || 0;
    return entry.shipAmount || 0;   // 'ship'
  }

  // 정렬 상태에 맞춰 배열을 재배치 (안정 정렬: 원본 순서 보존)
  function sortByMetric(list, valOf, sort) {
    if (!sort) return list;
    var arr = list.map(function (item, i) { return { item: item, i: i, v: valOf(item) }; });
    arr.sort(function (a, b) {
      var d = a.v - b.v;
      if (d === 0) return a.i - b.i;
      return sort.dir === 'asc' ? d : -d;
    });
    return arr.map(function (x) { return x.item; });
  }

  // 클릭 가능한 숫자 헤더 셀 HTML
  function sortHead(numClass, attr, sort, key, label) {
    var on = sort && sort.key === key;
    var arrow = on ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return '<span class="' + numClass + ' sort-th' + (on ? ' is-on' : '') + '" ' +
      attr + '="' + key + '" role="button" tabindex="0" title="클릭하여 정렬">' +
      esc(label) + '<span class="sort-ind">' + arrow + '</span></span>';
  }

  // 헤더 클릭 시 정렬 상태 토글 (같은 열: 내림차순 → 오름차순 → 해제)
  function nextSort(cur, key) {
    if (!cur || cur.key !== key) return { key: key, dir: 'desc' };
    if (cur.dir === 'desc') return { key: key, dir: 'asc' };
    return null;
  }

  /* ---------- 상품별 금액 집계 (지표 토글과 무관하게 두 금액 병렬 표시) ---------- */
  function renderAmountTable() {
    var cats = visibleCats();
    var agg = aggOf(curRange());

    el.amtSub.textContent = state.month + ' 기준 · 출고액/판매액 동시 표시';

    if (!cats.length || !agg) {
      el.amtTable.innerHTML = '<p class="report-empty">표시할 데이터가 없습니다.</p>';
      return;
    }

    var sort = state.amtSort;
    var head = '<div class="amt__head"><span>상품 라인</span><span>상품명</span>' +
      sortHead('amt__num', 'data-amt-sort', sort, 'qty', '총 출고 수량') +
      '<span class="amt__num">출고 비율</span>' +
      sortHead('amt__num', 'data-amt-sort', sort, 'ship', '총 출고액(원)') +
      sortHead('amt__num', 'data-amt-sort', sort, 'retail', '총 판매액(원)') + '</div>';

    var tQty = 0, tShip = 0, tRetail = 0;

    var orderedCats = sortByMetric(cats, function (c) {
      return sortVal(agg.byCategory[c.name], sort && sort.key);
    }, sort);

    var body = orderedCats.map(function (c) {
      var sub = agg.byCategory[c.name] || { qty: 0, shipAmount: 0, retailAmount: 0 };
      tQty += sub.qty; tShip += sub.shipAmount; tRetail += sub.retailAmount;

      var open = !!state.amtExpanded[c.name];

      // 라인 소계 비중 = 소속 상품 비중 합(core의 agg.ratio 재사용)
      var catRatio = c.items.reduce(function (s, it) { return s + (agg.ratio[it.name] || 0); }, 0);

      var subRow = '<div class="amt__row amt__row--sub' + (open ? ' is-open' : '') +
        '" data-amt-cat="' + esc(c.name) + '">' +
        '<span class="amt__cell amt__toggle"><span class="acc__caret">▶</span>' + esc(c.name) + '</span>' +
        '<span class="amt__cell">소계 (' + c.items.length + ')</span>' +
        '<span class="amt__num">' + fmtNum(sub.qty) + '</span>' +
        '<span class="amt__num">' + fmtRatio1(catRatio) + '</span>' +
        '<span class="amt__num">' + S.fmtMoney(sub.shipAmount) + '</span>' +
        '<span class="amt__num">' + S.fmtMoney(sub.retailAmount) + '</span></div>';

      // 기간 내 수량 0인 상품도 0으로 노출 (정렬 적용)
      var orderedItems = sortByMetric(c.items, function (it) {
        return sortVal(agg.byItem[it.name], sort && sort.key);
      }, sort);
      var items = orderedItems.map(function (it) {
        var e = agg.byItem[it.name] || { qty: 0, shipAmount: 0, retailAmount: 0 };
        return '<div class="amt__row amt__row--item">' +
          '<span class="amt__cell amt__line">' + esc(c.name) + '</span>' +
          '<span class="amt__cell" title="' + esc(it.name) + '">' + esc(it.name) + '</span>' +
          '<span class="amt__num">' + fmtNum(e.qty) + '</span>' +
          '<span class="amt__num">' + fmtRatio1(agg.ratio[it.name] || 0) + '</span>' +
          '<span class="amt__num">' + S.fmtMoney(e.shipAmount) + '</span>' +
          '<span class="amt__num">' + S.fmtMoney(e.retailAmount) + '</span></div>';
      }).join('');

      return '<div class="amt__group">' + subRow +
        '<div class="acc__children' + (open ? ' is-open' : '') + '"><div>' + items + '</div></div></div>';
    }).join('');

    var total = '<div class="amt__row amt__row--total">' +
      '<span class="amt__cell">전체 합계</span><span class="amt__cell"></span>' +
      '<span class="amt__num">' + fmtNum(tQty) + '</span>' +
      '<span class="amt__num">' + fmtRatio1(agg.totalQty ? (tQty / agg.totalQty) * 100 : 0) + '</span>' +
      '<span class="amt__num">' + S.fmtMoney(tShip) + '</span>' +
      '<span class="amt__num">' + S.fmtMoney(tRetail) + '</span></div>';

    el.amtTable.innerHTML = head + body + total;
  }

  /* ---------- 아코디언 테이블 ---------- */
  function renderTable() {
    var cats = visibleCats();
    var cur = aggOf(curRange());
    var prev = aggOf(prevRange());

    el.tableSub.textContent = state.month + ' 기준 · ' + deltaLabel();

    if (!cats.length || !cur) {
      el.accTable.innerHTML = '<p class="report-empty">표시할 데이터가 없습니다.</p>';
      return;
    }

    var sort = state.accSort;
    var head = '<div class="acc__head"><span>상품 라인</span>' +
      sortHead('acc__num', 'data-acc-sort', sort, 'qty', '총 합산 수량') +
      sortHead('acc__num', 'data-acc-sort', sort, 'ship', '총 합산 가액') +
      sortHead('acc__num', 'data-acc-sort', sort, 'delta', deltaLabel()) + '</div>';

    // 증감률(delta) 정렬은 현재 지표(수량/금액) 기준으로 cur·prev를 비교
    function accSortVal(byCur, byPrev, name) {
      var ce = byCur[name], pe = byPrev[name];
      if (sort && sort.key === 'delta') {
        var cv = ce ? (state.metric === 'qty' ? ce.qty : ce.shipAmount) : 0;
        var pv = pe ? (state.metric === 'qty' ? pe.qty : pe.shipAmount) : 0;
        return deltaPct(cv, pv);
      }
      return sortVal(ce, sort && sort.key);
    }

    var orderedCats = sortByMetric(cats, function (c) {
      return accSortVal(cur.byCategory, prev.byCategory, c.name);
    }, sort);

    var body = orderedCats.map(function (c) {
      var open = !!state.expanded[c.name];
      var cq = cur.byCategory[c.name] || { qty: 0, shipAmount: 0 };
      var pq = prev.byCategory[c.name] || { qty: 0, shipAmount: 0 };
      var curV = state.metric === 'qty' ? cq.qty : cq.shipAmount;
      var prevV = state.metric === 'qty' ? pq.qty : pq.shipAmount;

      var parent = '<div class="acc__row acc__row--parent' + (open ? ' is-open' : '') + '" data-cat="' + esc(c.name) + '">' +
        '<span class="acc__name"><span class="acc__caret">▶</span><span>' + esc(c.name) + '</span></span>' +
        '<span class="acc__num">' + fmtNum(cq.qty) + '권</span>' +
        '<span class="acc__num">' + S.fmtMoney(cq.shipAmount) + '원</span>' +
        '<span class="acc__num">' + badgeHtml(curV, prevV) + '</span></div>';

      var orderedItems = sortByMetric(c.items, function (it) {
        return accSortVal(cur.byItem, prev.byItem, it.name);
      }, sort);
      var kids = orderedItems.map(function (it) {
        var ci = cur.byItem[it.name] || { qty: 0, shipAmount: 0 };
        var pi = prev.byItem[it.name] || { qty: 0, shipAmount: 0 };
        var cv = state.metric === 'qty' ? ci.qty : ci.shipAmount;
        var pv = state.metric === 'qty' ? pi.qty : pi.shipAmount;
        return '<div class="acc__row acc__row--child">' +
          '<span class="acc__name"><span>' + esc(it.name) + '</span></span>' +
          '<span class="acc__num">' + fmtNum(ci.qty) + '권</span>' +
          '<span class="acc__num">' + S.fmtMoney(ci.shipAmount) + '원</span>' +
          '<span class="acc__num">' + badgeHtml(cv, pv) + '</span></div>';
      }).join('');

      return '<div class="acc__group">' + parent +
        '<div class="acc__children' + (open ? ' is-open' : '') + '"><div>' + kids + '</div></div></div>';
    }).join('');

    el.accTable.innerHTML = head + body;
  }

  /* ================= 이벤트 ================= */
  el.tabs.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-brand]');
    if (!t || t.dataset.brand === state.activeBrand) return;
    state.activeBrand = t.dataset.brand;
    resetChecked();
    state.expanded = {};
    state.treeExpanded = {};   // 브랜드 전환 시 필터 트리 모두 접힘
    state.amtExpanded = {};
    state.years = defaultYears();
    render();
  });

  el.monthInput.addEventListener('change', function () {
    if (!el.monthInput.value) return;
    state.month = el.monthInput.value;
    render();
  });

  el.metricSeg.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-metric]');
    if (!b || b.dataset.metric === state.metric) return;
    state.metric = b.dataset.metric;
    render();
  });

  el.deltaSeg.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-delta]');
    if (!b || b.dataset.delta === state.delta) return;
    state.delta = b.dataset.delta;
    render();
  });

  el.chartAView.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-view]');
    if (!b || b.dataset.view === state.chartAView) return;
    state.chartAView = b.dataset.view;
    renderControls();
    renderChartA();
  });

  el.chartBView.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-bview]');
    if (!b || b.dataset.bview === state.chartBView) return;
    state.chartBView = b.dataset.bview;
    renderControls();
    renderChartB();
  });

  // 트리 필터
  // 트리 펼침 토글: 체크박스 클릭은 선택 전용, 그 외 1depth 행 영역은 펼침
  el.filterTree.addEventListener('click', function (ev) {
    if (ev.target.matches('input[type="checkbox"]')) return;
    var row = ev.target.closest('[data-cat-row]');
    if (!row) return;
    var name = row.dataset.catRow;
    state.treeExpanded[name] = !state.treeExpanded[name];
    // 부분 갱신: 캐럿·자식만 토글 (선택 상태 재렌더 불필요)
    row.querySelector('.tree__caret').classList.toggle('is-open', state.treeExpanded[name]);
    var kids = row.nextElementSibling;
    if (kids) kids.classList.toggle('is-open', state.treeExpanded[name]);
  });

  el.filterTree.addEventListener('change', function (ev) {
    var cb = ev.target;
    var brand = brandObj();
    if (!brand) return;

    if (cb.dataset.cat) {
      var cat = brand.categories.filter(function (c) { return c.name === cb.dataset.cat; })[0];
      if (cat) (cat.items || []).forEach(function (it) { state.checked[it.name] = cb.checked; });
    } else if (cb.dataset.item) {
      state.checked[cb.dataset.item] = cb.checked;
    } else return;

    render();
  });

  el.filterToggleAll.addEventListener('click', function () {
    var on = allowedNames().length === 0;   // 전부 꺼져 있으면 전체 선택
    Object.keys(state.checked).forEach(function (k) { state.checked[k] = on; });
    el.filterToggleAll.textContent = on ? '전체 해제' : '전체 선택';
    render();
  });

  // 연도 드롭다운
  el.yearBtn.addEventListener('click', function () {
    el.yearPanel.hidden = !el.yearPanel.hidden;
  });

  el.yearPanel.addEventListener('change', function (ev) {
    var y = Number(ev.target.dataset.year);
    if (!y) return;
    if (ev.target.checked) { if (state.years.indexOf(y) === -1) state.years.push(y); }
    else state.years = state.years.filter(function (v) { return v !== y; });
    renderControls();
    renderChartB();
  });

  document.addEventListener('click', function (ev) {
    if (!el.yearPanel.hidden && !ev.target.closest('#yearDropdown')) el.yearPanel.hidden = true;
  });

  // 상품별 금액 집계: 헤더 정렬
  el.amtTable.addEventListener('click', function (ev) {
    var th = ev.target.closest('[data-amt-sort]');
    if (!th) return;
    state.amtSort = nextSort(state.amtSort, th.dataset.amtSort);
    renderAmountTable();
  });
  el.amtTable.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var th = ev.target.closest('[data-amt-sort]');
    if (!th) return;
    ev.preventDefault();
    state.amtSort = nextSort(state.amtSort, th.dataset.amtSort);
    renderAmountTable();
  });

  // 상품별 금액 집계 아코디언
  el.amtTable.addEventListener('click', function (ev) {
    var row = ev.target.closest('[data-amt-cat]');
    if (!row) return;
    var name = row.dataset.amtCat;
    state.amtExpanded[name] = !state.amtExpanded[name];
    row.classList.toggle('is-open', state.amtExpanded[name]);
    var kids = row.nextElementSibling;
    if (kids) kids.classList.toggle('is-open', state.amtExpanded[name]);
  });

  // 전월 대비 집계: 헤더 정렬
  el.accTable.addEventListener('click', function (ev) {
    var th = ev.target.closest('[data-acc-sort]');
    if (!th) return;
    state.accSort = nextSort(state.accSort, th.dataset.accSort);
    renderTable();
  });
  el.accTable.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var th = ev.target.closest('[data-acc-sort]');
    if (!th) return;
    ev.preventDefault();
    state.accSort = nextSort(state.accSort, th.dataset.accSort);
    renderTable();
  });

  // 라인별 집계 아코디언
  el.accTable.addEventListener('click', function (ev) {
    var row = ev.target.closest('.acc__row--parent');
    if (!row) return;
    var name = row.dataset.cat;
    state.expanded[name] = !state.expanded[name];
    row.classList.toggle('is-open', state.expanded[name]);
    var kids = row.nextElementSibling;
    if (kids) kids.classList.toggle('is-open', state.expanded[name]);
  });

  document.querySelectorAll('.nav-item').forEach(function (a) {
    a.addEventListener('click', function (ev) {
      if (a.classList.contains('is-active')) ev.preventDefault();
    });
  });

  /* ---------- PDF 출력 (브라우저 인쇄 → PDF로 저장) ---------- */
  // 차트는 인쇄 시 이미지 스냅샷(.chart-print-img)으로 대체 → 인쇄용 리사이즈 로직 불필요
  el.pdfBtn.addEventListener('click', function () {
    document.title = ['출고보고서', state.activeBrand || '', state.month].filter(Boolean).join('_');
    renderPrintHead();
    window.print();
  });

  window.addEventListener('afterprint', function () {
    document.title = '출고 보고서 | 출고정산시스템';
  });

  /* ================= Mock 폴백 ================= */
  // 결정적 난수 (재렌더 시 값이 흔들리지 않게)
  function lcg(seed) {
    var s = seed;
    return function () { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  }

  function mockData() {
    function line(prefix, n, ship, retail, factor) {
      var out = [];
      for (var i = 1; i <= n; i++) {
        out.push({ id: 'm' + prefix + i, name: prefix + ' ' + i, shipPrice: ship, retailPrice: retail, qtyFactor: factor });
      }
      return out;
    }

    var brands = [
      {
        id: 'mb1', name: '파머스영어', categories: [
          { id: 'mc1', name: 'Pre stella A', items: line('Pre Stella A', 6, 5500, 35000, 1) },
          { id: 'mc2', name: 'Sound Doctor', items: line('Sound doctor', 6, 5000, 28000, 1) },
          { id: 'mc3', name: 'Inter Stella', items: line('Inter Stella Vol.S', 3, 6000, 39000, 0.5) }
        ]
      },
      {
        id: 'mb2', name: '고래영어', categories: [
          { id: 'mc4', name: 'Whale Basic', items: line('Whale Basic', 4, 4800, 26000, 1) }
        ]
      }
    ];

    var names = ['김미연', '이성학', '장정아', '박수진', '최도현', '한지우'];
    var rnd = lcg(20260722);
    var ordersMap = {};
    var now = new Date();

    brands.forEach(function (b, bi) {
      var items = S.flatItems(b);
      var list = [];
      for (var y = now.getFullYear() - 1; y <= now.getFullYear(); y++) {
        for (var m = 0; m < 12; m++) {
          if (y === now.getFullYear() && m > now.getMonth()) break;
          // 3월·9월 신학기 가중
          var boost = (m === 2 || m === 8) ? 2.2 : 1;
          var cnt = Math.round((3 + rnd() * 3) * (bi ? .6 : 1));
          for (var k = 0; k < cnt; k++) {
            var day = 1 + Math.floor(rnd() * 27);
            var lines = items.filter(function () { return rnd() < .45; }).map(function (it) {
              return { raw: it.name, qty: Math.max(1, Math.round(rnd() * 8 * boost)), matched: it.name, excluded: false };
            });
            if (!lines.length) continue;
            list.push({
              id: 'mo_' + b.id + '_' + y + m + k,
              date: S.toYMD(new Date(y, m, day)),
              orderer: names[Math.floor(rnd() * names.length)],
              shipTo: '리틀포레스트어학원',
              fileName: 'mock.xlsx',
              lines: lines
            });
          }
        }
      }
      ordersMap[b.name] = list;
    });

    return { brands: brands, ordersMap: ordersMap };
  }

  /* ================= 초기화 ================= */
  function resetChecked() {
    state.checked = {};
    var b = brandObj();
    if (!b) return;
    (b.categories || []).forEach(function (c) {
      (c.items || []).forEach(function (it) { state.checked[it.name] = true; });
    });
  }

  function defaultYears() {
    var years = availableYears();
    return years.slice(0, 2).sort();
  }

  function init() {
    var cat = S.Store.loadCategories();
    var orders = S.Store.loadOrders();
    var hasOrders = Object.keys(orders).some(function (k) { return (orders[k] || []).length; });

    if (!cat || !cat.brands.length || !hasOrders) {
      var mock = mockData();
      state.brands = mock.brands;
      state.ordersMap = mock.ordersMap;
      state.isMock = true;
      el.mockFlag.hidden = false;
    } else {
      state.brands = cat.brands;
      state.ordersMap = orders;
    }

    state.activeBrand = state.brands.length ? state.brands[0].name : null;
    var now = new Date();
    state.month = S.toMonthValue(now.getFullYear(), now.getMonth());
    resetChecked();
    state.years = defaultYears();
    render();

    if (state.isMock) toast('저장된 데이터가 없어 Mock 데이터로 표시합니다.');
  }

  /* ---------- 데이터 백업/복원: 공용 모듈(S.Backup)에 연결 ---------- */
  var backupExp = document.getElementById('dataExportBtn');
  var backupImp = document.getElementById('dataImportBtn');
  if (S && backupExp) {
    backupExp.addEventListener('click', function () { S.Backup.exportData({ toast: toast }); });
    // 가져오기 성공 시 현재 페이지 재렌더(저장 데이터 재로드)
    backupImp.addEventListener('click', function () { S.Backup.importData({ toast: toast, onImported: function () { init(); } }); });
  }

  init();
})();
