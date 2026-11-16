const vscode = require('vscode');

const CONFIG_SECTION = 'kimiLimits';
const SECRET_KEY = 'kimiLimits.apiKey';

let statusBarItem;
let refreshTimer;

function getConfig() {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

async function getApiKey(secrets) {
  const stored = await secrets.get(SECRET_KEY);
  if (stored) return stored;
  return getConfig().get('apiKey', '').trim();
}

const HOURS_IN_WORDS = ['', 'одночасового', 'двухчасового', 'трёхчасового', 'четырёхчасового', 'пятичасового', 'шестичасового', 'семичасового', 'восьмичасового', 'девятичасового', 'десятичасового', 'одиннадцатичасового', 'двенадцатичасового'];

/** Название rate limit в именительном (nom) и родительном (gen) падеже. */
function rateLimitName(window) {
  const duration = Number(window && window.duration) || 0;
  const minutes = window && window.timeUnit === 'TIME_UNIT_HOUR' ? duration * 60
    : window && window.timeUnit === 'TIME_UNIT_DAY' ? duration * 1440
    : duration;
  if (minutes > 0 && minutes % 60 === 0 && minutes / 60 < HOURS_IN_WORDS.length) {
    const gen = HOURS_IN_WORDS[minutes / 60];
    const nom = gen.replace(/ого$/, 'ой');
    return { nom: nom.charAt(0).toUpperCase() + nom.slice(1) + ' лимит', gen: gen + ' лимита' };
  }
  if (minutes > 0) {
    return { nom: `Лимит ${minutes} мин`, gen: `лимита ${minutes} мин` };
  }
  return { nom: 'Лимит запросов', gen: 'лимита запросов' };
}

/** Доля израсходованного (0–100, без округления) из записи окна: used_ratio (0–1), used/limit или remaining/limit. */
function windowUsed(value) {
  const clampPct = (x) => Math.min(100, Math.max(0, x));
  const ratio = Number(value.used_ratio);
  if (Number.isFinite(ratio)) return clampPct(ratio * 100);
  const limit = Number(value.limit);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const used = Number(value.used);
  if (Number.isFinite(used)) return clampPct((used / limit) * 100);
  const remaining = Number(value.remaining);
  if (Number.isFinite(remaining)) return clampPct(((limit - remaining) / limit) * 100);
  return null;
}

/** Приводит разные форматы ответа API к единому виду:
 * { plan, limits: [{ name, nameGen, used, total, unit, resetsAt }] } */
function normalizePayload(data) {
  const root = data && data.data ? data.data : data;
  const result = { plan: undefined, limits: [] };

  if (!root || typeof root !== 'object') return result;

  result.plan = root.plan || root.tier || root.subscription || undefined;

  const push = (name, used, total, extra) => {
    if (name == null) return;
    result.limits.push({
      name: String(name),
      used: used == null ? null : Number(used),
      total: total == null ? null : Number(total),
      unit: extra && extra.unit,
      nameGen: extra && extra.nameGen,
      resetsAt: extra && (extra.resetsAt || extra.reset_at || extra.resetAt),
    });
  };

  // Формат ключей подписки Kimi Code (sk-kimi-...):
  // { usages: { limit_5h: { used_ratio }, limit_7d: {...}, limit_month_total: {...}, limit_month_code: {...} } }
  const windows = root.usages && typeof root.usages === 'object' && !Array.isArray(root.usages) ? root.usages : null;
  if (windows) {
    const entries = Object.entries(windows).filter(([key, value]) => /^limit_/.test(key) && value && typeof value === 'object');
    if (entries.length > 0) {
      const membership = root.user && root.user.membership;
      if (membership && membership.level) {
        result.plan = String(membership.level).replace(/^LEVEL_/, '');
      }
      const order = ['limit_5h', 'limit_month_code', 'limit_month_total', 'limit_7d'];
      entries.sort((a, b) => {
        const ia = order.indexOf(a[0]);
        const ib = order.indexOf(b[0]);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      });
      const names = {
        limit_5h: ['Пятичасовой лимит', 'пятичасового лимита'],
        limit_7d: ['Недельный лимит', 'недельного лимита'],
        limit_month_total: ['Месячный лимит (всего)', 'месячного лимита (всего)'],
        limit_month_code: ['Месячный лимит на код', 'месячного лимита на код'],
      };
      for (const [key, value] of entries) {
        const used = windowUsed(value);
        if (used == null) continue;
        const naming = names[key] || [key, key];
        push(naming[0], used, 100, { nameGen: naming[1], resetsAt: value.resetTime ?? value.reset_at ?? value.resetAt });
      }
      return result;
    }
  }

  // Формат Kimi Coding API (GET /coding/v1/usages):
  // { usage: { limit, remaining, resetTime }, totalQuota: { limit, remaining, resetTime },
  //   limits: [{ window: { duration, timeUnit }, detail: { limit, remaining, resetTime } }] }
  const usage = root.usage;
  const kimiUsage = usage && typeof usage === 'object' && (usage.limit != null || usage.remaining != null);
  const kimiRateLimits = Array.isArray(root.limits) && root.limits.some(l => l && l.detail);
  const kimiTotalQuota = root.totalQuota && typeof root.totalQuota === 'object' && (root.totalQuota.limit != null || root.totalQuota.remaining != null || root.totalQuota.used != null);
  if (kimiUsage || kimiRateLimits || kimiTotalQuota) {
    const membership = root.user && root.user.membership;
    if (!result.plan && membership && membership.level) {
      result.plan = String(membership.level).replace(/^LEVEL_/, '');
    }
    const usedOf = (value) => value.used ?? (value.limit != null && value.remaining != null ? Number(value.limit) - Number(value.remaining) : undefined);
    if (Array.isArray(root.limits)) {
      for (const l of root.limits) {
        const d = l && l.detail;
        if (!d || (d.limit == null && d.remaining == null)) continue;
        const name = rateLimitName(l.window);
        push(name.nom, usedOf(d), d.limit, { resetsAt: d.resetTime, nameGen: name.gen });
      }
    }
    if (kimiTotalQuota) {
      push('Месячный лимит по подписке', usedOf(root.totalQuota), root.totalQuota.limit, { resetsAt: root.totalQuota.resetTime, nameGen: 'месячного лимита по подписке' });
    }
    if (kimiUsage) {
      push('Недельный лимит', usedOf(usage), usage.limit, { resetsAt: usage.resetTime, nameGen: 'недельного лимита' });
    }
    return result;
  }

  if (Array.isArray(root.limits)) {
    for (const l of root.limits) {
      push(l.name || l.label || l.type || l.kind, l.used ?? l.consumed, l.total ?? l.max ?? l.limit, l);
    }
    return result;
  }

  if (Array.isArray(root.quotas)) {
    for (const l of root.quotas) {
      const total = l.total ?? (l.remaining != null && l.used != null ? Number(l.used) + Number(l.remaining) : undefined);
      push(l.name || l.label || l.type, l.used, total, l);
    }
    return result;
  }

  // Свободные ключи вида { tokenQuota: { used, total } }
  for (const [key, value] of Object.entries(root)) {
    if (value && typeof value === 'object' && ('used' in value || 'remaining' in value)) {
      const total = value.total ?? value.max ?? (value.remaining != null && value.used != null ? Number(value.used) + Number(value.remaining) : undefined);
      push(key, value.used, total, value);
    }
  }
  return result;
}

/** Израсходованный процент (0–100, без округления), null если посчитать нельзя. */
function rawPercent(limit) {
  if (!limit || limit.used == null || limit.total == null || limit.total === 0) return null;
  return Math.min(100, Math.max(0, (limit.used / limit.total) * 100));
}

/** Израсходованный процент, округлённый до целого. */
function formatPercent(limit) {
  const pct = rawPercent(limit);
  return pct == null ? null : Math.round(pct);
}

/** Относительное время сброса: "сброс через 4ч 28мин". */
function formatResetIn(when) {
  const sec = Math.round((when.getTime() - Date.now()) / 1000);
  if (sec <= 0) return 'сброс';
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}дн`);
  if (hours) parts.push(`${hours}ч`);
  if (mins) parts.push(`${mins}мин`);
  if (!parts.length) parts.push('меньше минуты');
  return `сброс через ${parts.join(' ')}`;
}

function formatRemainder(limit) {
  const parts = [];
  const pct = formatPercent(limit);
  if (limit.nameGen && pct != null) {
    parts.push(`${limit.name}: израсходовано ${pct}%`);
  } else if (limit.used != null && limit.total != null) {
    parts.push(`${limit.used} из ${limit.total}${limit.unit ? ' ' + limit.unit : ''}`);
  } else if (limit.used != null) {
    parts.push(`использовано ${limit.used}${limit.unit ? ' ' + limit.unit : ''}`);
  }
  if (limit.resetsAt) {
    const when = new Date(limit.resetsAt);
    if (!isNaN(when.getTime())) {
      parts.push(formatResetIn(when));
    }
  }
  return parts.join(' · ');
}

async function fetchJson(endpoint, token) {
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`API вернул ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchLimits(context) {
  const config = getConfig();
  const endpoint = config.get('endpoint', '').trim();
  const apiKey = await getApiKey(context.secrets);

  if (!endpoint) {
    throw new Error('Не задан эндпоинт (настройка kimiLimits.endpoint).');
  }
  if (!apiKey) {
    throw new Error('Не задан API-ключ — выполните команду «Kimi Limits: Set API Key».');
  }
  return normalizePayload(await fetchJson(endpoint, apiKey));
}

/** Сводка для статус-бара: "8% / 36.33%" — израсходовано пятичасового и месячного (всего) лимитов. */
function statusBarSummary(snapshot) {
  const rate = rawPercent(snapshot.limits.find(l => l.name === 'Пятичасовой лимит'));
  const month = rawPercent(snapshot.limits.find(l => l.name === 'Месячный лимит (всего)' || l.name === 'Месячный лимит по подписке'));
  const parts = [];
  if (rate != null) parts.push(`${Math.round(rate)}%`);
  if (month != null) parts.push(`${month.toFixed(2)}%`);
  return parts.join(' / ');
}

function updateStatusBar(snapshot, error) {
  const config = getConfig();
  if (!config.get('showInStatusBar', true)) {
    statusBarItem.hide();
    return;
  }
  if (error) {
    statusBarItem.text = '$(error) Kimi: ошибка';
    statusBarItem.tooltip = error;
  } else if (snapshot && snapshot.limits.length > 0) {
    const used = Math.max(...snapshot.limits.map(l => formatPercent(l) ?? 0));
    const icon = used >= 100 ? '$(circle-filled)' : used > 80 ? '$(warning)' : '$(dashboard)';
    const summary = statusBarSummary(snapshot);
    statusBarItem.text = summary ? `${icon} Kimi: ${summary}` : `${icon} Kimi: ${used}%`;
    statusBarItem.tooltip = new vscode.MarkdownString(
      snapshot.limits.map(l => {
        const line = formatRemainder(l) || '—';
        return l.nameGen ? `- ${line}` : `- **${l.name}**: ${line}`;
      }).join('\n')
    );
  } else {
    statusBarItem.text = '$(dashboard) Kimi: —';
    statusBarItem.tooltip = 'Лимиты не загружены';
  }
  statusBarItem.show();
}

async function refresh(context) {
  try {
    const snapshot = await fetchLimits(context);
    updateStatusBar(snapshot, null);
  } catch (err) {
    updateStatusBar(null, err.message);
  }
}

function scheduleRefresh(context) {
  if (refreshTimer) clearInterval(refreshTimer);
  const minutes = Math.max(1, getConfig().get('refreshIntervalMinutes', 5));
  refreshTimer = setInterval(() => refresh(context), minutes * 60 * 1000);
}

async function activate(context) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'kimiLimits.refresh';
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('kimiLimits.refresh', async () => {
      await refresh(context);
    }),
    vscode.commands.registerCommand('kimiLimits.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Введите API-ключ Kimi (Moonshot AI)',
        password: true,
        ignoreFocusOut: true,
      });
      if (key) {
        await context.secrets.store(SECRET_KEY, key.trim());
        vscode.window.showInformationMessage('Kimi Limits: API-ключ сохранён в защищённом хранилище.');
        await refresh(context);
      }
    }),
    vscode.commands.registerCommand('kimiLimits.clearApiKey', async () => {
      await context.secrets.delete(SECRET_KEY);
      vscode.window.showInformationMessage('Kimi Limits: API-ключ удалён.');
      await refresh(context);
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(CONFIG_SECTION)) {
        scheduleRefresh(context);
        refresh(context);
      }
    })
  );

  scheduleRefresh(context);
  await refresh(context);
}

function deactivate() {
  if (refreshTimer) clearInterval(refreshTimer);
}

module.exports = { activate, deactivate, normalizePayload, formatRemainder, formatPercent, statusBarSummary };
