export const token = () => window.PortalAccess?.Access?.token || '';
export const api = (path, options) => window.PortalAccess.api(path, options);
export const currentUser = () => window.PortalAccess?.Access?.user;
export const isManager = person => Boolean(person && (person.role === 'admin' || person.management));
export const toast = (message, tone = 'info') => window.showToast?.(message, tone);

export const mediaUrl = path => {
  if (!path) return '';
  const glue = String(path).includes('?') ? '&' : '?';
  return `${window.PORTAL_API_BASE || ''}${path}${glue}t=${encodeURIComponent(token())}`;
};

export function initials(name) {
  return (
    String(name || '?')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(part => part[0])
      .join('')
      .toUpperCase() || '?'
  );
}

export function sizeLabel(size) {
  const value = Number(size) || 0;
  if (!value) return '';
  return value >= 1048576
    ? `${(value / 1048576).toFixed(1).replace('.', ',')} MB`
    : `${Math.max(1, Math.ceil(value / 1024))} KB`;
}

export function timeLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'ontem';
  if (days < 7) return `há ${days} dias`;
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function timeDetail(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const clock = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const startOfDay = value => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diff = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
  if (diff === 0) return `Hoje às ${clock}`;
  if (diff === 1) return `Ontem às ${clock}`;
  return `${date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${clock}`;
}

export function relativeUpper(iso) {
  const text = timeLabel(iso);
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

export function likersText(post) {
  const names = (post.likers || []).map(person => String(person?.name || '').trim()).filter(Boolean);
  if (!names.length) return '';
  const shown = names.slice(0, 4);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} e mais ${rest}`;
  if (shown.length === 1) return shown[0];
  return `${shown.slice(0, -1).join(', ')} e ${shown[shown.length - 1]}`;
}

export function fmtDate(value) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

export function todayIso() {
  const now = new Date();
  const pad = number => String(number).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function digestTone(label) {
  const text = String(label || '').toLowerCase();
  if (text.includes('conclu')) return { tone: 'green', icon: '✓' };
  if (text.includes('demanda')) return { tone: 'blue', icon: '▤' };
  if (text.includes('contrato')) return { tone: 'purple', icon: '❑' };
  if (text.includes('publica') || text.includes('post')) return { tone: 'teal', icon: '◍' };
  return { tone: 'slate', icon: '·' };
}

export function updateNavBadge(count) {
  const badge = document.getElementById('feedNavBadge');
  if (!badge) return;
  const value = Math.max(0, Number(count) || 0);
  badge.textContent = value > 9 ? '9+' : String(value);
  badge.classList.toggle('hidden', value <= 0);
}
