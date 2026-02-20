/**
 * Toast notification system for user feedback
 */

export type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: number;
  type: ToastType;
  message: string;
  duration: number;
}

class ToastManager {
  private container: HTMLDivElement;
  private toasts: Map<number, Toast> = new Map();
  private nextId = 1;

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    document.body.appendChild(this.container);
  }

  show(message: string, type: ToastType = 'info', duration = 4000) {
    const id = this.nextId++;
    const toast: Toast = { id, type, message, duration };
    this.toasts.set(id, toast);

    const element = document.createElement('div');
    element.className = `toast toast-${type}`;
    element.innerHTML = `
      <div class="toast-icon">${this.getIcon(type)}</div>
      <div class="toast-message">${this.escapeHtml(message)}</div>
      <button class="toast-close" aria-label="Close">×</button>
    `;

    const closeBtn = element.querySelector('.toast-close') as HTMLButtonElement;
    closeBtn.addEventListener('click', () => this.hide(id));

    this.container.appendChild(element);

    // Animate in
    requestAnimationFrame(() => {
      element.classList.add('toast-show');
    });

    // Auto-hide
    if (duration > 0) {
      setTimeout(() => this.hide(id), duration);
    }

    return id;
  }

  hide(id: number) {
    const toast = this.toasts.get(id);
    if (!toast) return;

    const elements = this.container.querySelectorAll('.toast');
    const element = Array.from(elements).find(el => {
      return el.querySelector('.toast-message')?.textContent === toast.message;
    });

    if (element) {
      element.classList.remove('toast-show');
      setTimeout(() => {
        element.remove();
        this.toasts.delete(id);
      }, 300);
    }
  }

  success(message: string, duration?: number) {
    return this.show(message, 'success', duration);
  }

  error(message: string, duration?: number) {
    return this.show(message, 'error', duration);
  }

  warning(message: string, duration?: number) {
    return this.show(message, 'warning', duration);
  }

  info(message: string, duration?: number) {
    return this.show(message, 'info', duration);
  }

  private getIcon(type: ToastType): string {
    switch (type) {
      case 'success': return '✓';
      case 'error': return '✕';
      case 'warning': return '⚠';
      case 'info': return 'ℹ';
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

export const toast = new ToastManager();
