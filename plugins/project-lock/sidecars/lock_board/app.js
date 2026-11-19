/**
 * Lock & Tooling Sidecar UI controller.
 * Strict DOM API rendering (createElement + textContent only).
 */
(() => {
  const POLL_MS = 2000;
  const TICK_MS = 1000;
  const SHORT_ID_LEN = 8;
  const TAB1_EVENT_LIMIT = 8;
  const DEFAULT_MAX_LOCKS_PER_SESSION = 4;
  const GUARD_EVENT_LABELS = {
    LIMIT_DENIED: '세션 락 상한 초과 차단',
    DEP_GUARD_DENIED: '연쇄 공유 모듈 빌드 차단 (--no-dependencies 필요)',
  };
  const RELEASE_WAKE_EVENTS = new Set([
    'RELEASE',
    'PROMOTED',
    'WAKE_SENT',
    'WAKE_DEFERRED',
    'WAKE_FAILED',
    'TTL_EXPIRED',
    'RESERVATION_EXPIRED',
    'QUEUE_CANCELLED',
    'LIMIT_DENIED',
    'DEP_GUARD_DENIED',
  ]);
  const TOAST_EVENTS = new Set([
    'RELEASE',
    'PROMOTED',
    'WAKE_SENT',
    'WAKE_FAILED',
    'RESERVATION_EXPIRED',
    'LIMIT_DENIED',
    'DEP_GUARD_DENIED',
  ]);

  const $ = (id) => document.getElementById(id);

  const appState = {
    tab: 'locks',
    filter: '',
    workspaces: [],
    snapshot: null,
    pollTimer: null,
    tickTimer: null,
    toastTimer: null,
    inflight: false,
    pendingAction: new Set(),
    lastFetchOk: false,
    lastSeenEventId: 0,
    initializedEvents: false,
    alertedStallKeys: new Set(),
    selectedTools: new Set(),
    executingTools: false,
  };

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, val] of Object.entries(props)) {
      if (val === undefined || val === null) continue;
      if (key === 'className') {
        node.className = String(val);
      } else if (key === 'dataset' && typeof val === 'object') {
        for (const [dk, dv] of Object.entries(val)) {
          if (dv !== undefined && dv !== null) node.dataset[dk] = String(dv);
        }
      } else if (key.startsWith('on') && typeof val === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), val);
      } else {
        node.setAttribute(key, String(val));
      }
    }
    for (const child of children) {
      if (child === undefined || child === null || child === false) continue;
      if (Array.isArray(child)) {
        for (const nested of child) {
          if (nested !== undefined && nested !== null && nested !== false) {
            node.append(nested instanceof Node ? nested : document.createTextNode(String(nested)));
          }
        }
      } else {
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
      }
    }
    return node;
  }

  function clearNode(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function syncThemeFromCssVar() {
    const computed = getComputedStyle(document.documentElement).backgroundColor;
    const nums = (computed.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = computed.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }

  function showToast(message, isError = false) {
    const toast = $('toast');
    toast.textContent = String(message ?? '');
    toast.classList.remove('hidden', 'error');
    if (isError) toast.classList.add('error');
    clearTimeout(appState.toastTimer);
    appState.toastTimer = setTimeout(() => {
      toast.classList.add('hidden');
    }, 3200);
  }

  function formatDuration(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m < 60) return `${m}m ${String(rem).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatClock(epochSec) {
    if (!Number.isFinite(epochSec) || epochSec <= 0) return '—';
    const d = new Date(epochSec * 1000);
    return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function baseName(pathStr) {
    const clean = String(pathStr ?? '').replace(/[\\/]+$/, '');
    if (!clean) return '';
    const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
    return idx >= 0 ? clean.slice(idx + 1) : clean;
  }

  function shortId(id) {
    const raw = String(id ?? '');
    return raw.length > SHORT_ID_LEN ? raw.slice(0, SHORT_ID_LEN) : raw || '—';
  }

  function openConversation(convId) {
    if (!convId) return;
    if (window.sidecar?.ui?.toggleConversation) {
      window.sidecar.ui.toggleConversation(convId);
      return;
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(convId).then(
        () => showToast(`Copied conversation ID ${shortId(convId)}`),
        () => showToast(`Conversation ID: ${convId}`)
      );
      return;
    }
    showToast(`Conversation ID: ${convId}`);
  }

  function makeConvButton(convId, convTitle = '') {
    if (!convId || convId === 'ui' || convId === 'cli') {
      return el('span', { className: 'badge badge-muted' }, convId || '—');
    }
    const cleanTitle = String(convTitle ?? '').trim();
    const label = cleanTitle ? `${cleanTitle} (${shortId(convId)})` : shortId(convId);
    return el(
      'button',
      {
        type: 'button',
        className: cleanTitle ? 'link-btn conv-link' : 'link-btn',
        title: cleanTitle ? `Focus conversation: ${cleanTitle} (${convId})` : `Focus conversation ${convId}`,
        onClick: () => openConversation(convId),
      },
      label
    );
  }

  function makeWakeBadge(status, wakeStatus) {
    if (status !== 'promoted') return null;
    const st = String(wakeStatus || 'pending');
    if (st === 'sent') return el('span', { className: 'badge badge-success' }, '깨우기 전송됨');
    if (st === 'sending') return el('span', { className: 'badge badge-primary' }, '전송 중…');
    if (st === 'failed') return el('span', { className: 'badge badge-error' }, '깨우기 실패');
    if (st === 'disabled') return el('span', { className: 'badge badge-muted' }, '자동깨우기 OFF');
    return el('span', { className: 'badge badge-warning' }, 'Sidecar 전송 대기');
  }

  async function apiRequest(path, options = {}) {
    const fetcher = window.sidecar?.fetch
      ? window.sidecar.fetch.bind(window.sidecar)
      : fetch;
    const res = await fetcher(path, options);
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { error: text };
    }
    if (!res.ok) {
      throw new Error(json?.error || `${path}: HTTP ${res.status}`);
    }
    return json;
  }

  function setLiveStatus(kind, text) {
    const elLive = $('live-status');
    elLive.classList.remove('stale', 'error');
    if (kind === 'stale' || kind === 'error') elLive.classList.add(kind);
    $('live-label').textContent = text;
  }

  function switchTab(nextTab) {
    appState.tab = nextTab;
    for (const btn of document.querySelectorAll('.tab')) {
      const isSelected = btn.dataset.tab === nextTab;
      btn.classList.toggle('active', isSelected);
      btn.setAttribute('aria-selected', String(isSelected));
      btn.setAttribute('tabindex', isSelected ? '0' : '-1');
    }
    $('tab-locks').classList.toggle('active', nextTab === 'locks');
    $('tab-locks').classList.toggle('hidden', nextTab !== 'locks');
    $('tab-tooling').classList.toggle('active', nextTab === 'tooling');
    $('tab-tooling').classList.toggle('hidden', nextTab !== 'tooling');
  }

  function matchesFilter(textParts) {
    const q = appState.filter.trim().toLowerCase();
    if (!q) return true;
    return textParts.some((p) => String(p ?? '').toLowerCase().includes(q));
  }

  function renderSummaryAndHeader(snap) {
    const locks = snap.locks || [];
    const queue = snap.lock_queue || [];
    const nextUp = snap.nextUp || [];
    const autoWake = Boolean(snap.autoWakeEnabled);

    $('stat-locks').textContent = String(locks.length);
    $('stat-queue').textContent = String(queue.length);
    $('stat-wake').textContent = autoWake ? 'ON' : 'OFF';
    $('auto-wake-toggle').checked = autoWake;

    const firstNext = nextUp[0];
    if (firstNext) {
      const nextName = firstNext.waiterTitle || shortId(firstNext.waiterConvId);
      const nextTag = firstNext.status === 'promoted' ? '승계' : '#1';
      $('stat-next').textContent = `${nextName} (${nextTag})`;
      $('stat-next-pill').title = nextUp
        .map((n) => `${n.moduleKey}: ${n.waiterTitle || shortId(n.waiterConvId)} (${n.status})`)
        .join('\n');
    } else {
      $('stat-next').textContent = '—';
      $('stat-next-pill').title = 'No queued or promoted session';
    }

    const wsNames = (snap.xray?.activeWorkspaces || []).map(baseName).filter(Boolean);
    $('stat-ws').textContent = wsNames.length ? wsNames.join(', ') : 'All / None';
    $('stat-ws-pill').title = (snap.xray?.activeWorkspaces || []).join('\n') || 'No active host workspace';

    $('tab-count-locks').textContent = `${locks.length}/${queue.length}`;
    const bins = snap.tooling?.binaries || [];
    const okBins = bins.filter((b) => b.exists).length;
    $('tab-count-tooling').textContent = bins.length ? `${okBins}/${bins.length}` : '';
  }

  function makeTooltipText(shortText, fullText, extraClass = '') {
    const summary = String(shortText ?? '').trim();
    const detail = String(fullText ?? summary).trim();
    const textCls = extraClass ? `truncate-line ${extraClass}` : 'truncate-line';
    return el(
      'div',
      {
        className: 'tooltip-host',
        tabindex: '0',
        'aria-label': detail,
      },
      el('div', { className: textCls }, summary),
      el('div', { className: 'tooltip-popover', role: 'tooltip' }, detail)
    );
  }

  function formatActivitySource(source) {
    if (source === 'task-log') return '작업 로그';
    if (source === 'transcript') return '대화 로그';
    return '훅 활동';
  }

  function formatHealthBadgeContent(healthState, idleSec) {
    if (healthState === 'stale') {
      return { cls: 'badge badge-error', label: `장기 정체 ${formatDuration(idleSec)}` };
    }
    if (healthState === 'stalled') {
      return { cls: 'badge badge-warning', label: `멈춤 의심 ${formatDuration(idleSec)}` };
    }
    return { cls: 'badge badge-success', label: '작업 중' };
  }

  function makeHealthBadge(lk, stallSummary = {}) {
    if (lk.isReserved) return null;
    const nowSec = Date.now() / 1000;
    const since = Number(lk.latestActivityAt ?? lk.lastActiveAt) || nowSec;
    const idle = Number.isFinite(Number(lk.activityIdleSeconds))
      ? Math.max(0, Number(lk.activityIdleSeconds))
      : Math.max(0, Math.floor(nowSec - since));
    const state = String(lk.healthState || 'active');
    const suspectSec = Number(stallSummary.suspectSeconds) || 180;
    const longSec = Number(stallSummary.longSeconds) || 600;
    const { cls, label } = formatHealthBadgeContent(state, idle);
    const srcLabel = formatActivitySource(lk.activitySource);
    const tip =
      state === 'active'
        ? `최근 활동 ${formatDuration(idle)} 전 (${srcLabel})`
        : `최근 활동 ${formatDuration(idle)} 전 (${srcLabel}) — 응답 대기·비정상 종료 여부를 확인하세요.`;

    return el(
      'span',
      {
        className: cls,
        dataset: {
          activitySince: String(since),
          activitySource: srcLabel,
          suspectSec: String(suspectSec),
          longSec: String(longSec),
        },
        title: tip,
      },
      label
    );
  }

  function renderStallAlertBanner(snap) {
    const banner = $('stall-alert-banner');
    clearNode(banner);
    const blocking = (snap.locks || []).filter((lk) => lk.isBlockingStalled);
    if (blocking.length === 0) {
      banner.className = 'alert-banner hidden';
      return;
    }

    const hasCritical = blocking.some((lk) => lk.healthState === 'stale');
    banner.className = hasCritical ? 'alert-banner critical' : 'alert-banner';

    for (const lk of blocking) {
      const idleText = formatDuration(lk.activityIdleSeconds);
      const isBusy = appState.pendingAction.has(`unlock:${lk.moduleKey}`);
      const msg =
        `대기 ${lk.waitingCount}건 있음 · ${lk.moduleKey} 점유 세션이 ` +
        `${idleText}째 무활동(${formatActivitySource(lk.activitySource)})입니다.`;

      banner.appendChild(
        el(
          'div',
          { className: 'alert-banner-row' },
          el(
            'div',
            { className: 'alert-banner-text' },
            el(
              'span',
              { className: lk.healthState === 'stale' ? 'badge badge-error' : 'badge badge-warning' },
              lk.healthState === 'stale' ? '장기 정체' : '멈춤 의심'
            ),
            el('span', {}, msg),
            makeConvButton(lk.ownerId, lk.ownerTitle)
          ),
          el(
            'div',
            { className: 'action-group' },
            el(
              'button',
              {
                type: 'button',
                className: 'action-btn danger',
                disabled: isBusy ? 'disabled' : undefined,
                onClick: () => void handleUnlock(lk.moduleKey),
              },
              isBusy ? 'Unlocking…' : 'Unlock'
            )
          )
        )
      );
    }
  }

  function makeTimerBadge(item, isLock = true) {
    const nowSec = Date.now() / 1000;
    if (item.reservedUntil !== null && item.reservedUntil !== undefined) {
      const rem = Math.max(0, Math.ceil(item.reservedUntil - nowSec));
      return el(
        'span',
        {
          className: rem <= 15 ? 'badge badge-error' : 'badge badge-warning',
          dataset: { timerKind: 'reserved', deadline: String(item.reservedUntil) },
        },
        `Reserved ${formatDuration(rem)}`
      );
    }
    if (isLock) {
      const ttl = Number(item.ttlSeconds) || 1200;
      const last = Number(item.lastActiveAt) || nowSec;
      const rem = Math.max(0, Math.ceil(ttl - (nowSec - last)));
      const idle = Math.max(0, Math.floor(nowSec - last));
      return el(
        'span',
        {
          className: 'badge badge-muted',
          dataset: { timerKind: 'ttl', lastActive: String(last), ttl: String(ttl) },
          title: `Idle ${formatDuration(idle)} / ${formatDuration(ttl)}`,
        },
        `TTL ${formatDuration(rem)}`
      );
    }
    const reqAt = Number(item.requestedAt) || nowSec;
    const waited = Math.max(0, Math.floor(nowSec - reqAt));
    return el(
      'span',
      {
        className: 'badge badge-muted',
        dataset: { timerKind: 'wait', since: String(reqAt) },
      },
      `Wait ${formatDuration(waited)}`
    );
  }

  function renderNextUpSection(snap) {
    const sectionEl = $('next-up-section');
    const listEl = $('next-up-list');
    clearNode(listEl);

    const allNext = snap.nextUp || [];
    const queueById = new Map((snap.lock_queue || []).map((q) => [q.id, q]));
    const filtered = allNext.filter((item) =>
      matchesFilter([
        item.moduleKey,
        item.waiterConvId,
        item.waiterTitle,
        item.waiterWorkspaceName,
        item.requestGroupId,
      ])
    );

    $('next-up-count').textContent =
      filtered.length === allNext.length
        ? String(allNext.length)
        : `${filtered.length}/${allNext.length}`;

    sectionEl.classList.toggle('hidden', allNext.length === 0);
    if (allNext.length === 0) return;

    if (filtered.length === 0) {
      listEl.appendChild(el('div', { className: 'empty-card' }, 'No Next Up sessions match filter.'));
      return;
    }

    for (const item of filtered) {
      const qRow = queueById.get(item.id) || item;
      const isPromoted = item.status === 'promoted';
      const wakeKey = `wake:${item.id}`;
      const unlockKey = `unlock:${item.moduleKey}`;
      const isWaking = appState.pendingAction.has(wakeKey);
      const isUnlocking = appState.pendingAction.has(unlockKey);

      const actionBtn = isPromoted
        ? el(
            'button',
            {
              type: 'button',
              className: 'action-btn primary',
              disabled: isWaking ? 'disabled' : undefined,
              onClick: () => void handleWakeQueue(item.id),
            },
            isWaking ? 'Sending…' : '지금 깨우기'
          )
        : el(
            'button',
            {
              type: 'button',
              className: 'action-btn danger',
              disabled: isUnlocking ? 'disabled' : undefined,
              onClick: () => void handleUnlock(item.moduleKey),
            },
            isUnlocking ? 'Unlocking…' : '점유 해제 · 승계'
          );

      const statusBadge = isPromoted
        ? el('span', { className: 'badge badge-warning' }, 'PROMOTED · 다음 승계')
        : el('span', { className: 'badge badge-primary' }, 'NEXT #1 · 다음 실행 예정');

      const subParts = [
        item.waiterWorkspaceName,
        item.sessionKind,
        item.requestGroupId,
      ]
        .filter(Boolean)
        .join(' · ');

      listEl.appendChild(
        el(
          'div',
          { className: isPromoted ? 'next-card promoted' : 'next-card' },
          el(
            'div',
            { className: 'next-head' },
            el(
              'div',
              { className: 'next-meta' },
              statusBadge,
              el('span', { className: 'mono-key' }, item.moduleKey),
              makeWakeBadge(item.status, item.wakeStatus),
              makeTimerBadge(qRow, false)
            ),
            actionBtn
          ),
          el(
            'div',
            { className: 'next-body' },
            makeConvButton(item.waiterConvId, item.waiterTitle),
            subParts ? el('span', { className: 'cell-sub' }, subParts) : null
          )
        )
      );
    }
  }

  function renderLocksTable(snap) {
    const tbody = $('locks-tbody');
    clearNode(tbody);

    const allLocks = snap.locks || [];
    const filtered = allLocks.filter((lk) =>
      matchesFilter([
        lk.moduleKey,
        lk.ownerId,
        lk.ownerTitle,
        lk.ownerProjectId,
        lk.workspace,
        lk.nextWaiter?.waiterConvId,
        lk.nextWaiter?.waiterTitle,
        ...(lk.tags || []),
      ])
    );

    $('locks-count').textContent =
      filtered.length === allLocks.length
        ? String(allLocks.length)
        : `${filtered.length}/${allLocks.length}`;

    $('locks-table-wrap').classList.toggle('hidden', filtered.length === 0);
    $('locks-empty').classList.toggle('hidden', filtered.length > 0);
    $('locks-empty').textContent =
      allLocks.length > 0 ? 'No active locks match filter.' : 'No active module locks.';

    const maxLocks = Math.max(
      1,
      Number(snap.guardSettings?.maxLocksPerSession) || DEFAULT_MAX_LOCKS_PER_SESSION
    );

    for (const lk of filtered) {
      const busyKey = `unlock:${lk.moduleKey}`;
      const isBusy = appState.pendingAction.has(busyKey);
      const gitBadge =
        lk.gitDirty === true
          ? el('span', { className: 'badge badge-warning' }, 'dirty')
          : lk.gitDirty === false
            ? el('span', { className: 'badge badge-success' }, 'clean')
            : el('span', { className: 'badge badge-muted' }, '—');

      const wsName = lk.ownerWorkspaceName || baseName(lk.workspace);
      const tagsText = Array.isArray(lk.tags) && lk.tags.length ? lk.tags.join(', ') : '';
      const subParts = [wsName, tagsText].filter(Boolean).join(' · ');
      const nw = lk.nextWaiter;
      const ownerLockCount = Number.isFinite(Number(lk.ownerLockCount))
        ? Math.max(0, Number(lk.ownerLockCount))
        : 1;
      const atLockCap = ownerLockCount >= maxLocks;
      const ownerQuotaBadge = lk.ownerId
        ? el(
            'span',
            {
              className: atLockCap
                ? 'badge badge-warning quota-badge'
                : 'badge badge-muted quota-badge',
              title: atLockCap
                ? `세션 동시 락 상한 도달 (${ownerLockCount}/${maxLocks})`
                : `세션 동시 락 점유 (${ownerLockCount}/${maxLocks})`,
            },
            `${ownerLockCount}/${maxLocks}`
          )
        : null;

      const unlockBtn = el(
        'button',
        {
          type: 'button',
          className: 'action-btn danger',
          disabled: isBusy ? 'disabled' : undefined,
          onClick: () => void handleUnlock(lk.moduleKey),
        },
        isBusy ? 'Unlocking…' : 'Unlock'
      );

      const tr = el(
        'tr',
        { className: lk.isBlockingStalled ? 'row-stalled-blocking' : undefined },
        el(
          'td',
          {},
          el(
            'div',
            { className: 'cell-main' },
            el('span', { className: 'mono-key' }, lk.moduleKey),
            lk.isShared ? el('span', { className: 'badge badge-primary' }, 'shared') : null
          ),
          subParts ? el('div', { className: 'cell-sub' }, subParts) : null,
          nw
            ? el(
                'div',
                { className: 'cell-sub conv-chip' },
                el('span', { className: 'badge badge-primary' }, nw.status === 'promoted' ? '승계됨' : '다음 대기 #1'),
                makeConvButton(nw.waiterConvId, nw.waiterTitle)
              )
            : null
        ),
        el(
          'td',
          {},
          el('div', { className: 'cell-main' }, makeConvButton(lk.ownerId, lk.ownerTitle), ownerQuotaBadge),
          lk.ownerProjectId ? el('div', { className: 'cell-sub' }, lk.ownerProjectId) : null
        ),
        el(
          'td',
          {},
          el('div', { className: 'cell-main' }, makeTimerBadge(lk, true), makeHealthBadge(lk, snap.stallSummary)),
          lk.childIds?.length
            ? el('div', { className: 'cell-sub' }, `+${lk.childIds.length} child`)
            : null
        ),
        el('td', {}, gitBadge),
        el('td', { className: 'col-action' }, unlockBtn)
      );
      tbody.appendChild(tr);
    }
  }

  function renderQueueTable(snap) {
    const tbody = $('queue-tbody');
    clearNode(tbody);

    const allQueue = snap.lock_queue || [];
    const filtered = allQueue.filter((q) =>
      matchesFilter([
        q.moduleKey,
        q.waiterConvId,
        q.waiterTitle,
        q.waiterProjectId,
        q.waiterWorkspace,
        q.sessionKind,
        q.requestGroupId,
        q.wakeStatus,
      ])
    );

    $('queue-count').textContent =
      filtered.length === allQueue.length
        ? String(allQueue.length)
        : `${filtered.length}/${allQueue.length}`;

    $('queue-table-wrap').classList.toggle('hidden', filtered.length === 0);
    $('queue-empty').classList.toggle('hidden', filtered.length > 0);
    $('queue-empty').textContent =
      allQueue.length > 0 ? 'No queue entries match filter.' : 'No sessions waiting in queue.';

    for (const q of filtered) {
      const cancelKey = `cancel:${q.id}`;
      const wakeKey = `wake:${q.id}`;
      const isCancelBusy = appState.pendingAction.has(cancelKey);
      const isWakeBusy = appState.pendingAction.has(wakeKey);
      const isPromoted = q.status === 'promoted';

      const rankBadge = isPromoted
        ? el('span', { className: 'badge badge-warning' }, 'PROMOTED')
        : q.position === 1
          ? el('span', { className: 'badge badge-primary' }, 'NEXT #1')
          : el('span', { className: 'badge badge-muted' }, `#${q.position || '?'}`);

      const subModule = [q.reasonTag, q.requestGroupId].filter(Boolean).join(' · ');
      const wsLabel = q.waiterWorkspaceName || baseName(q.waiterWorkspace);
      const subWaiter = [q.sessionKind, wsLabel, q.waiterProjectId].filter(Boolean).join(' · ');

      const wakeBtn = isPromoted
        ? el(
            'button',
            {
              type: 'button',
              className: 'action-btn primary',
              disabled: isWakeBusy ? 'disabled' : undefined,
              onClick: () => void handleWakeQueue(q.id),
            },
            isWakeBusy ? 'Sending…' : 'Wake Now'
          )
        : null;

      const cancelBtn = el(
        'button',
        {
          type: 'button',
          className: 'action-btn',
          disabled: isCancelBusy ? 'disabled' : undefined,
          onClick: () => void handleCancelQueue(q.id),
        },
        isCancelBusy ? 'Cancelling…' : 'Cancel'
      );

      const tr = el(
        'tr',
        {},
        el('td', {}, rankBadge),
        el(
          'td',
          {},
          el('div', { className: 'cell-main' }, el('span', { className: 'mono-key' }, q.moduleKey)),
          subModule ? el('div', { className: 'cell-sub' }, subModule) : null
        ),
        el(
          'td',
          {},
          el('div', { className: 'cell-main' }, makeConvButton(q.waiterConvId, q.waiterTitle)),
          subWaiter ? el('div', { className: 'cell-sub' }, subWaiter) : null
        ),
        el(
          'td',
          {},
          el('div', { className: 'cell-main' }, makeTimerBadge(q, false), makeWakeBadge(q.status, q.wakeStatus)),
          q.retryCount > 0
            ? el('div', { className: 'cell-sub' }, `retries: ${q.retryCount}`)
            : null
        ),
        el('td', { className: 'col-action' }, el('div', { className: 'action-group' }, wakeBtn, cancelBtn))
      );
      tbody.appendChild(tr);
    }
  }

  function eventBadgeClass(name) {
    if (
      name.includes('FAIL') ||
      name.includes('DEADLOCK') ||
      name.includes('EXPIRED') ||
      name.includes('DENIED')
    ) {
      return 'badge badge-error';
    }
    if (name.includes('WAKE_SENT') || name.includes('ACQUIRED') || name.includes('CLAIMED')) {
      return 'badge badge-success';
    }
    if (name.includes('PROMOTED') || name.includes('QUEUED') || name.includes('WAKE_DEFERRED')) {
      return 'badge badge-warning';
    }
    if (name === 'RELEASE') {
      return 'badge badge-primary';
    }
    return 'badge badge-muted';
  }

  function formatEventCaption(ev) {
    const name = String(ev.event || '');
    const detail = String(ev.detail || '');
    if (name === 'RELEASE' && !detail) return '점유 해제됨';
    if (name === 'WAKE_DEFERRED') return `Sidecar 깨우기 대기 (${detail})`;
    if (name === 'WAKE_SENT') return `깨우기 메시지 전송됨 (${detail})`;
    const guardLabel = GUARD_EVENT_LABELS[name];
    if (guardLabel) return detail ? `${guardLabel} (${detail})` : guardLabel;
    return detail;
  }

  function renderEventRows(targetEl, events, emptyText) {
    clearNode(targetEl);
    if (!events || events.length === 0) {
      targetEl.appendChild(el('div', { className: 'empty-card' }, emptyText));
      return;
    }
    for (const ev of events) {
      const name = String(ev.event || '');
      const caption = formatEventCaption(ev);
      targetEl.appendChild(
        el(
          'div',
          { className: 'event-row' },
          el('span', { className: 'event-ts' }, formatClock(ev.ts)),
          el('span', { className: eventBadgeClass(name) }, name),
          ev.moduleKey ? el('span', { className: 'mono-key' }, ev.moduleKey) : null,
          ev.convId ? makeConvButton(ev.convId, ev.convTitle) : null,
          caption ? el('span', { className: 'event-detail' }, caption) : null
        )
      );
    }
  }

  function renderRecentWakesSection(snap) {
    const filtered = (snap.lock_events || [])
      .filter((ev) => RELEASE_WAKE_EVENTS.has(String(ev.event || '')))
      .slice(0, TAB1_EVENT_LIMIT);
    $('recent-wakes-count').textContent = String(filtered.length);
    renderEventRows(
      $('recent-wakes-list'),
      filtered,
      '최근 락 해제·승계·깨우기 기록이 없습니다.'
    );
  }

  function notifyNewLifecycleEvents(snap) {
    const events = snap.lock_events || [];
    const maxId = events.reduce((acc, ev) => Math.max(acc, Number(ev.id) || 0), 0);
    if (!appState.initializedEvents) {
      appState.lastSeenEventId = maxId;
      appState.initializedEvents = true;
      return;
    }
    if (maxId <= appState.lastSeenEventId) return;

    const fresh = events.filter(
      (ev) => (Number(ev.id) || 0) > appState.lastSeenEventId && TOAST_EVENTS.has(String(ev.event || ''))
    );
    appState.lastSeenEventId = maxId;
    if (fresh.length === 0) return;

    const top = fresh[0];
    const who = top.convTitle || shortId(top.convId);
    const mod = top.moduleKey || 'module';
    const guardLabel = GUARD_EVENT_LABELS[top.event];
    if (guardLabel) {
      showToast(`${guardLabel}: ${mod} (${who})`, true);
      return;
    }
    if (top.event === 'WAKE_SENT') {
      showToast(`깨우기 전송 완료: ${mod} → ${who}`);
    } else if (top.event === 'WAKE_FAILED') {
      showToast(`깨우기 실패: ${mod} → ${who}`, true);
    } else if (top.event === 'PROMOTED') {
      showToast(`승계 예약됨(60s): ${mod} → ${who}`);
    } else if (top.event === 'RELEASE') {
      showToast(`락 해제됨: ${mod} (${who})`);
    } else if (top.event === 'RESERVATION_EXPIRED') {
      showToast(`승계 예약 만료: ${mod} (${who})`, true);
    }
  }

  function renderToolingTab(snap) {
    const tooling = snap.tooling || {};
    const statusBadge = $('tooling-json-status');
    statusBadge.className = tooling.toolingJsonExists ? 'badge badge-success' : 'badge badge-error';
    statusBadge.textContent = tooling.toolingJsonExists ? 'tooling.json Ready' : 'tooling.json Missing';
    statusBadge.title = tooling.toolingJsonPath || '';

    const rootsEl = $('tooling-roots');
    clearNode(rootsEl);
    const rootItems = Array.isArray(tooling.rootInfo) && tooling.rootInfo.length
      ? tooling.rootInfo
      : [
          {
            label: 'AgentTooling 통합 루트',
            summary: '에이전트 전용 CLI·MCP·글로벌 래퍼 기준 폴더',
            description: '에이전트 공통 툴링을 관리하는 루트 폴더입니다.',
            path: tooling.agentToolingRoot || '',
          },
          {
            label: 'CodeXray 툴킷',
            summary: '.NET/Rust/Web/Svelte/Python 정적 분석·인덱싱·클론·Grep 엔진',
            description: 'CodeXrayMcp, xray-index, xray-grep, structural-clone, OpenGrep을 제공합니다.',
            path: tooling.codeXrayRoot || '',
          },
        ];

    for (const item of rootItems) {
      const fullTip = item.path
        ? `${item.description || item.summary}\n경로: ${item.path}`
        : item.description || item.summary;
      rootsEl.appendChild(
        el(
          'div',
          { className: 'kv-item' },
          el('div', { className: 'kv-label' }, item.label),
          makeTooltipText(item.summary || '—', fullTip, 'kv-desc')
        )
      );
    }

    const binEl = $('tooling-binaries');
    clearNode(binEl);
    const binaries = Array.isArray(tooling.binaries) ? tooling.binaries : [];
    const availableIds = new Set(binaries.map((b) => String(b.id || b.label || '')));
    for (const id of [...appState.selectedTools]) {
      if (!availableIds.has(id)) appState.selectedTools.delete(id);
    }

    for (const bin of binaries) {
      const toolId = String(bin.id || bin.label || '');
      const selected = appState.selectedTools.has(toolId);
      const badge = bin.exists
        ? el('span', { className: 'badge badge-success' }, 'Ready')
        : el('span', { className: 'badge badge-error' }, 'Missing');
      const catBadge = bin.category
        ? el('span', { className: 'badge badge-muted' }, bin.category)
        : null;
      const summaryText = bin.summary || `${bin.label} 도구`;
      const sizeNote = bin.exists ? ` (${formatBytes(bin.sizeBytes)})` : ' (미설치)';
      const fullTooltip = `${bin.description || summaryText}\n상태: ${bin.exists ? '사용 가능' : '실행 파일 없음'}${sizeNote}`;

      const checkbox = el('input', {
        type: 'checkbox',
        className: 'binary-checkbox',
        'aria-label': `${bin.label} 도구 선택`,
      });
      checkbox.checked = selected;

      const card = el(
        'label',
        {
          className: `binary-card selectable${selected ? ' selected' : ''}`,
          dataset: { toolId },
        },
        el(
          'div',
          { className: 'binary-head' },
          el(
            'div',
            { className: 'binary-title-wrap' },
            checkbox,
            el('span', { className: 'binary-name truncate-line' }, bin.label)
          ),
          el('div', { className: 'binary-badges' }, catBadge, badge)
        ),
        makeTooltipText(summaryText, fullTooltip, 'tool-summary')
      );

      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          appState.selectedTools.add(toolId);
          card.classList.add('selected');
        } else {
          appState.selectedTools.delete(toolId);
          card.classList.remove('selected');
        }
        updateToolingActionBar();
      });

      binEl.appendChild(card);
    }
    updateToolingActionBar();

    const xrayWs = snap.xray?.workspaces || [];
    $('xray-ws-count').textContent = String(xrayWs.length);
    const wsListEl = $('xray-workspaces');
    clearNode(wsListEl);

    if (xrayWs.length === 0) {
      wsListEl.appendChild(
        el('div', { className: 'empty-card' }, 'No active workspace or lock workspace detected.')
      );
    } else {
      for (const ws of xrayWs) {
        const db = ws.indexDb || {};
        const statusEl = db.exists
          ? db.error
            ? el('span', { className: 'badge badge-warning' }, 'DB Error')
            : el('span', { className: 'badge badge-success' }, 'Indexed')
          : el('span', { className: 'badge badge-muted' }, 'No index.db');

        const originBadge = el(
          'span',
          { className: 'badge badge-primary' },
          ws.source === 'active' ? 'Active Workspace' : 'Lock Workspace'
        );

        const metrics = [];
        if (db.exists && !db.error) {
          const c = db.counts || {};
          if (c.projects != null) metrics.push(el('span', { className: 'badge badge-muted' }, `projects: ${c.projects}`));
          if (c.files != null) metrics.push(el('span', { className: 'badge badge-muted' }, `files: ${c.files}`));
          if (c.types != null) metrics.push(el('span', { className: 'badge badge-muted' }, `types: ${c.types}`));
          if (c.members != null) metrics.push(el('span', { className: 'badge badge-muted' }, `members: ${c.members}`));
          metrics.push(el('span', { className: 'badge badge-muted' }, formatBytes(db.sizeBytes)));
          if (db.updatedEpoch) {
            metrics.push(el('span', { className: 'badge badge-muted' }, `updated: ${formatClock(db.updatedEpoch)}`));
          }
        }

        wsListEl.appendChild(
          el(
            'div',
            { className: 'card' },
            el(
              'div',
              { className: 'card-head' },
              el('span', { className: 'card-title' }, ws.name),
              el('div', { className: 'metric-row' }, originBadge, statusEl)
            ),
            makeTooltipText(ws.workspacePath, ws.workspacePath, 'cell-sub mono-key'),
            db.error ? el('div', { className: 'cell-sub' }, `Error: ${db.error}`) : null,
            metrics.length ? el('div', { className: 'metric-row' }, metrics) : null
          )
        );
      }
    }

    const allReviews = xrayWs.flatMap((ws) =>
      (ws.reviews || []).map((rev) => ({ ...rev, workspaceName: ws.name }))
    );
    allReviews.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
    $('reviews-count').textContent = String(allReviews.length);

    const reviewsEl = $('xray-reviews');
    clearNode(reviewsEl);
    if (allReviews.length === 0) {
      reviewsEl.appendChild(
        el('div', { className: 'empty-card' }, 'No .xray/reviews/*.json manifests found.')
      );
    } else {
      for (const rev of allReviews.slice(0, 12)) {
        const statusBadges = Object.entries(rev.statusCounts || {}).map(([st, cnt]) => {
          const cls =
            st === 'modify' || st === 'approved'
              ? 'badge badge-success'
              : st === 'skip' || st === 'skipped'
                ? 'badge badge-muted'
                : 'badge badge-warning';
          return el('span', { className: cls }, `${st}: ${cnt}`);
        });

        const previewItems = Array.isArray(rev.preview) ? rev.preview.slice(0, 3) : [];
        const previewLine = previewItems
          .map((p) => `${baseName(p.file) || p.file}${p.line ? `:${p.line}` : ''}${p.symbol ? ` (${p.symbol})` : ''}`)
          .filter(Boolean)
          .join(' · ');

        reviewsEl.appendChild(
          el(
            'div',
            { className: 'card' },
            el(
              'div',
              { className: 'card-head' },
              el('span', { className: 'card-title mono-key' }, rev.pattern || rev.runId),
              el(
                'div',
                { className: 'metric-row' },
                rev.isRegex ? el('span', { className: 'badge badge-primary' }, 'regex') : null,
                el('span', { className: 'badge badge-muted' }, `${rev.totalMatches} matches / ${rev.fileCount} files`)
              )
            ),
            el(
              'div',
              { className: 'cell-sub' },
              `${rev.workspaceName} · ${rev.fileName}`
            ),
            previewLine ? makeTooltipText(previewLine, previewLine, 'cell-sub mono-key') : null,
            statusBadges.length ? el('div', { className: 'metric-row' }, statusBadges) : null
          )
        );
      }
    }

    const events = snap.lock_events || [];
    $('events-count').textContent = String(events.length);
    renderEventRows($('events-list'), events, 'No lock events recorded yet.');
  }

  function notifyStalledBlockingLocks(snap) {
    const activeBlocking = new Map();
    for (const lk of snap.locks || []) {
      if (lk.isBlockingStalled) {
        activeBlocking.set(`${lk.moduleKey}|${lk.healthState}`, lk);
      }
    }
    for (const key of [...appState.alertedStallKeys]) {
      if (!activeBlocking.has(key)) {
        appState.alertedStallKeys.delete(key);
      }
    }
    for (const [key, lk] of activeBlocking.entries()) {
      if (appState.alertedStallKeys.has(key)) continue;
      appState.alertedStallKeys.add(key);
      const who = lk.ownerTitle || shortId(lk.ownerId);
      showToast(
        `멈춤 의심: ${lk.moduleKey} (${who}, 무활동 ${formatDuration(lk.activityIdleSeconds)} · 대기 ${lk.waitingCount}건)`,
        lk.healthState === 'stale'
      );
      break;
    }
  }

  function renderAll(snap) {
    appState.snapshot = snap;
    renderSummaryAndHeader(snap);
    renderStallAlertBanner(snap);
    renderNextUpSection(snap);
    renderLocksTable(snap);
    renderQueueTable(snap);
    renderRecentWakesSection(snap);
    renderToolingTab(snap);
    notifyNewLifecycleEvents(snap);
    notifyStalledBlockingLocks(snap);
  }

  function tickCountdowns() {
    const nowSec = Date.now() / 1000;
    for (const node of document.querySelectorAll('[data-timer-kind]')) {
      const kind = node.dataset.timerKind;
      if (kind === 'reserved') {
        const deadline = Number(node.dataset.deadline);
        const rem = Math.max(0, Math.ceil(deadline - nowSec));
        node.textContent = `Reserved ${formatDuration(rem)}`;
        node.className = rem <= 15 ? 'badge badge-error' : 'badge badge-warning';
      } else if (kind === 'ttl') {
        const last = Number(node.dataset.lastActive);
        const ttl = Number(node.dataset.ttl) || 1200;
        const rem = Math.max(0, Math.ceil(ttl - (nowSec - last)));
        node.textContent = `TTL ${formatDuration(rem)}`;
      } else if (kind === 'wait') {
        const since = Number(node.dataset.since);
        const waited = Math.max(0, Math.floor(nowSec - since));
        node.textContent = `Wait ${formatDuration(waited)}`;
      }
    }

    for (const node of document.querySelectorAll('[data-activity-since]')) {
      const since = Number(node.dataset.activitySince);
      if (!Number.isFinite(since)) continue;
      const idle = Math.max(0, Math.floor(nowSec - since));
      const suspectSec = Number(node.dataset.suspectSec) || 180;
      const longSec = Number(node.dataset.longSec) || 600;
      const state = idle >= longSec ? 'stale' : idle >= suspectSec ? 'stalled' : 'active';
      const { cls, label } = formatHealthBadgeContent(state, idle);
      node.className = cls;
      node.textContent = label;
    }
  }

  async function fetchState() {
    if (appState.inflight) return;
    appState.inflight = true;
    try {
      const qs = new URLSearchParams();
      if (appState.workspaces.length > 0) {
        qs.set('workspaces', JSON.stringify(appState.workspaces));
      }
      const queryStr = qs.toString();
      const snap = await apiRequest(`/api/state${queryStr ? `?${queryStr}` : ''}`, {
        method: 'GET',
      });
      appState.lastFetchOk = true;
      setLiveStatus('ok', 'Live');
      renderAll(snap);
    } catch (err) {
      setLiveStatus(appState.lastFetchOk ? 'stale' : 'error', 'Offline');
      showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      appState.inflight = false;
    }
  }

  function scheduleNextPoll() {
    clearTimeout(appState.pollTimer);
    if (document.hidden) return;
    appState.pollTimer = setTimeout(async () => {
      await fetchState();
      scheduleNextPoll();
    }, POLL_MS);
  }

  async function handleUnlock(moduleKey) {
    const key = `unlock:${moduleKey}`;
    if (appState.pendingAction.has(key)) return;
    appState.pendingAction.add(key);
    if (appState.snapshot) {
      renderNextUpSection(appState.snapshot);
      renderLocksTable(appState.snapshot);
    }
    try {
      const res = await apiRequest('/api/unlock', {
        method: 'POST',
        body: JSON.stringify({
          moduleKey,
          workspaces: appState.workspaces,
        }),
      });
      if (res.state) renderAll(res.state);
      const wokeAny = Array.isArray(res.wakeResults) && res.wakeResults.some((w) => w.sent);
      showToast(wokeAny ? `Unlocked ${moduleKey} · 승계 세션 깨우기 전송됨` : `Unlocked ${moduleKey}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      appState.pendingAction.delete(key);
      if (appState.snapshot) {
        renderNextUpSection(appState.snapshot);
        renderLocksTable(appState.snapshot);
      }
    }
  }

  async function handleCancelQueue(id) {
    const key = `cancel:${id}`;
    if (appState.pendingAction.has(key)) return;
    appState.pendingAction.add(key);
    if (appState.snapshot) {
      renderNextUpSection(appState.snapshot);
      renderQueueTable(appState.snapshot);
    }
    try {
      const res = await apiRequest('/api/queue/cancel', {
        method: 'POST',
        body: JSON.stringify({
          id,
          workspaces: appState.workspaces,
        }),
      });
      if (res.state) renderAll(res.state);
      showToast(`Cancelled queue #${id}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      appState.pendingAction.delete(key);
      if (appState.snapshot) {
        renderNextUpSection(appState.snapshot);
        renderQueueTable(appState.snapshot);
      }
    }
  }

  async function handleWakeQueue(id) {
    const key = `wake:${id}`;
    if (appState.pendingAction.has(key)) return;
    appState.pendingAction.add(key);
    if (appState.snapshot) {
      renderNextUpSection(appState.snapshot);
      renderQueueTable(appState.snapshot);
    }
    try {
      const res = await apiRequest('/api/wake', {
        method: 'POST',
        body: JSON.stringify({
          id,
          workspaces: appState.workspaces,
        }),
      });
      if (res.state) renderAll(res.state);
      if (res.sent) {
        showToast('깨우기 메시지를 전송했습니다.');
      } else {
        showToast(res.error || '깨우기 전송에 실패했습니다.', true);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      appState.pendingAction.delete(key);
      if (appState.snapshot) {
        renderNextUpSection(appState.snapshot);
        renderQueueTable(appState.snapshot);
      }
    }
  }

  async function handleAutoWakeToggle(enabled) {
    const toggle = $('auto-wake-toggle');
    toggle.disabled = true;
    try {
      const res = await apiRequest('/api/auto-wake', {
        method: 'POST',
        body: JSON.stringify({
          enabled,
          workspaces: appState.workspaces,
        }),
      });
      if (res.state) renderAll(res.state);
      showToast(`Auto-Wake ${res.autoWakeEnabled ? 'enabled' : 'paused'}`);
    } catch (err) {
      toggle.checked = !enabled;
      showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      toggle.disabled = false;
    }
  }

  function getSelectedToolEntries() {
    const bins = appState.snapshot?.tooling?.binaries || [];
    return bins.filter((bin) => appState.selectedTools.has(String(bin.id || bin.label || '')));
  }

  function updateToolingActionBar() {
    const summaryEl = $('tooling-selection-summary');
    const clearBtn = $('tooling-clear-btn');
    const execBtn = $('tooling-execute-btn');
    if (!summaryEl || !clearBtn || !execBtn) return;

    const selected = getSelectedToolEntries();
    const count = selected.length;
    if (count === 0) {
      summaryEl.textContent = '도구를 클릭해 1개 이상 선택한 뒤 Execute를 누르세요.';
      clearBtn.disabled = true;
      execBtn.disabled = true;
      execBtn.textContent = 'Execute';
      return;
    }

    const previewNames = selected.slice(0, 3).map((b) => b.label).join(', ');
    const more = count > 3 ? ` 외 ${count - 3}개` : '';
    summaryEl.textContent = `선택됨 (${count}개): ${previewNames}${more}`;
    clearBtn.disabled = appState.executingTools;
    execBtn.disabled = appState.executingTools;
    execBtn.textContent = appState.executingTools ? 'Sending…' : `Execute (${count})`;
  }

  function buildToolExecutionPrompt(selectedBins, workspaces) {
    const wsList = Array.isArray(workspaces)
      ? workspaces.map((w) => String(w || '').trim()).filter(Boolean)
      : [];
    const lines = ['[Lock & Tooling 사이드카 실행 요청]'];
    if (wsList.length > 0) {
      lines.push(`대상 워크스페이스: ${wsList.join(', ')}`);
    }
    lines.push('아래 선택한 도구를 사용해 현재 작업을 점검·실행하고 핵심 결과를 보고해 줘:');
    selectedBins.forEach((bin, idx) => {
      const hint = bin.actionHint || bin.summary || bin.label;
      lines.push(`${idx + 1}. \`${bin.label}\` (${bin.id}): ${hint}`);
    });
    return lines.join('\n');
  }

  async function copyPromptToClipboard(text) {
    if (!navigator.clipboard?.writeText) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  function handleClearSelectedTools() {
    if (appState.executingTools || appState.selectedTools.size === 0) return;
    appState.selectedTools.clear();
    if (appState.snapshot) {
      renderToolingTab(appState.snapshot);
    } else {
      updateToolingActionBar();
    }
  }

  async function handleExecuteSelectedTools() {
    if (appState.executingTools) return;
    const selected = getSelectedToolEntries();
    if (selected.length === 0) return;

    const activeWs =
      appState.snapshot?.xray?.activeWorkspaces?.length
        ? appState.snapshot.xray.activeWorkspaces
        : appState.workspaces;
    const prompt = buildToolExecutionPrompt(selected, activeWs);

    const canSendToChat =
      typeof window.sidecar?.agent?.sendMessage === 'function' &&
      Boolean(window.sidecar?.conversationId);

    if (!canSendToChat) {
      const copied = await copyPromptToClipboard(prompt);
      showToast(
        copied
          ? `${selected.length}개 도구 실행 프롬프트를 클립보드에 복사했습니다 (Ctrl+V로 전송).`
          : '활성 대화 ID가 없어 채팅창 직접 전송을 건너뛰었습니다.',
        !copied
      );
      return;
    }

    appState.executingTools = true;
    updateToolingActionBar();
    try {
      await window.sidecar.agent.sendMessage(prompt);
      appState.selectedTools.clear();
      showToast(`${selected.length}개 도구 실행 요청을 채팅창으로 전송했습니다.`);
    } catch (err) {
      const copied = await copyPromptToClipboard(prompt);
      const reason = err instanceof Error ? err.message : String(err);
      showToast(
        copied
          ? `채팅 전송 실패(${reason}) — 프롬프트를 클립보드에 복사했습니다.`
          : `채팅 전송 실패: ${reason}`,
        true
      );
    } finally {
      appState.executingTools = false;
      if (appState.snapshot) {
        renderToolingTab(appState.snapshot);
      } else {
        updateToolingActionBar();
      }
    }
  }

  async function initWorkspaces() {
    if (!window.sidecar) return;
    if (typeof window.sidecar.onWorkspaceChange === 'function') {
      window.sidecar.onWorkspaceChange((uris) => {
        appState.workspaces = Array.isArray(uris) ? uris : [];
        void fetchState();
      });
    }
    if (typeof window.sidecar.getWorkspaceUris === 'function') {
      try {
        const uris = await window.sidecar.getWorkspaceUris();
        if (Array.isArray(uris)) {
          appState.workspaces = uris;
        }
      } catch {
        // Non-fatal outside host environment.
      }
    }
  }

  function bindEvents() {
    const tabBtns = [...document.querySelectorAll('.tab')];
    for (const btn of tabBtns) {
      btn.addEventListener('click', () => {
        switchTab(btn.dataset.tab || 'locks');
      });
      btn.addEventListener('keydown', (ev) => {
        if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
        ev.preventDefault();
        const idx = tabBtns.indexOf(btn);
        const nextIdx =
          ev.key === 'ArrowRight'
            ? (idx + 1) % tabBtns.length
            : (idx - 1 + tabBtns.length) % tabBtns.length;
        const nextBtn = tabBtns[nextIdx];
        switchTab(nextBtn.dataset.tab || 'locks');
        nextBtn.focus();
      });
    }

    $('lock-filter').addEventListener('input', (ev) => {
      appState.filter = ev.target.value || '';
      if (appState.snapshot) {
        renderNextUpSection(appState.snapshot);
        renderLocksTable(appState.snapshot);
        renderQueueTable(appState.snapshot);
      }
    });

    $('auto-wake-toggle').addEventListener('change', (ev) => {
      void handleAutoWakeToggle(Boolean(ev.target.checked));
    });

    $('refresh-btn').addEventListener('click', () => {
      void fetchState();
    });

    $('tooling-clear-btn')?.addEventListener('click', handleClearSelectedTools);
    $('tooling-execute-btn')?.addEventListener('click', () => {
      void handleExecuteSelectedTools();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        clearTimeout(appState.pollTimer);
      } else {
        void fetchState().then(scheduleNextPoll);
      }
    });
  }

  async function boot() {
    syncThemeFromCssVar();
    new MutationObserver(() => syncThemeFromCssVar()).observe(
      document.documentElement,
      { attributes: true, attributeFilter: ['style'] }
    );

    bindEvents();
    await initWorkspaces();
    await fetchState();
    scheduleNextPoll();
    appState.tickTimer = setInterval(tickCountdowns, TICK_MS);
  }

  void boot();
})();
