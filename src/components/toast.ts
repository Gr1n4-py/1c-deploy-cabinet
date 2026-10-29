/** Всплывающее уведомление в правом нижнем углу. */

type ToastKind = 'ok' | 'warn';

let hideTimer: number | undefined;

export function showToast(text: string, kind: ToastKind = 'ok'): void {
  let el = document.querySelector<HTMLDivElement>('[data-ref="toast"]');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.dataset.ref = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.remove('show', 'toast-ok', 'toast-warn');
  // reflow, чтобы transition проигрался заново при повторном показе
  void el.offsetWidth;
  el.classList.add('show', `toast-${kind}`);
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => el?.classList.remove('show'), 2600);
}
