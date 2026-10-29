import { authMessage, PASSWORD_MAX, PASSWORD_MIN, type AuthResult } from '../economy/AccountProtocol';
import { STARTING_CREDITS } from '../economy/EconomyRules';
import type { AccountMode, AccountSession } from '../economy/AccountSession';
import { formatCr } from './GridStore';

/**
 * Account line on the GRID pages (which account is shown, sign in / sign
 * up / sign out) and the sign-in dialog. The password goes straight to the
 * server over the same origin and is never stored in the page.
 */
export class AccountPanel {
  private readonly bars: HTMLElement[] = [];
  private readonly dialog: HTMLElement;
  private busy = false;

  constructor(
    root: HTMLElement,
    pages: readonly HTMLElement[],
    private readonly session: AccountSession,
  ) {
    for (const page of pages) {
      const bar = document.createElement('div');
      bar.className = 'grid-account';
      bar.setAttribute('aria-live', 'polite');
      page.prepend(bar);
      bar.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-account]')?.dataset.account;
        if (act === 'login' || act === 'signup') this.open(act);
        else if (act === 'logout') void this.session.logout();
        else if (act === 'retry') void this.session.start();
      });
      this.bars.push(bar);
    }
    this.dialog = document.createElement('div');
    this.dialog.className = 'grid-dialog grid-auth';
    this.dialog.hidden = true;
    this.dialog.setAttribute('role', 'dialog');
    this.dialog.setAttribute('aria-modal', 'true');
    this.dialog.setAttribute('aria-label', 'GRID 계정');
    this.dialog.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Escape') this.close();
    });
    root.appendChild(this.dialog);
    session.onModeChange((m) => this.render(m));
    this.render(session.mode);
  }

  private render(mode: AccountMode): void {
    let html: string;
    switch (mode.kind) {
      case 'checking':
        html = `<span class="ga-state">계정 확인 중…</span>`;
        break;
      case 'offline':
        html =
          mode.reason === 'no_server'
            ? `<span class="ga-state"><b>오프라인 기록</b> · 이 브라우저에만 저장됩니다 (계정 서버 없음)</span>`
            : `<span class="ga-state warn"><b>계정 서버에 연결할 수 없음</b> · 오프라인 기록을 표시합니다</span><button type="button" class="btn ga-btn" data-account="retry">다시 연결</button>`;
        break;
      case 'signed_out':
        html = `<span class="ga-state">${mode.reason === 'expired' ? '<b class="warn">로그인이 만료되었습니다.</b> ' : mode.reason === 'suspended' ? '<b class="warn">정지된 계정입니다.</b> ' : ''}<b>오프라인 기록</b> · 서버 계정과 별개이며 계정으로 옮겨지지 않습니다</span>
          <button type="button" class="btn ga-btn" data-account="login">로그인</button><button type="button" class="btn ga-btn" data-account="signup">가입</button>`;
        break;
      case 'signed_in':
        html = `<span class="ga-state">계정 <b class="ga-name">${escapeHtml(mode.account.displayName)}</b> · 서버에 저장됩니다. 경기 보상·미션 진행은 서버 경기 검증 도입 전까지 지급되지 않습니다</span>
          <button type="button" class="btn ga-btn" data-account="logout">로그아웃</button>`;
        break;
    }
    for (const bar of this.bars) {
      bar.dataset.mode = mode.kind;
      bar.innerHTML = html;
    }
  }

  private open(kind: 'login' | 'signup'): void {
    this.dialog.hidden = false;
    this.renderForm(kind);
  }

  private close(): void {
    if (this.busy) return;
    this.dialog.hidden = true;
    this.dialog.innerHTML = '';
  }

  private renderForm(kind: 'login' | 'signup', message = '', username = ''): void {
    const signup = kind === 'signup';
    this.dialog.innerHTML = `
      <form class="gd-panel ga-panel" novalidate>
        <div class="eyebrow">GRID 계정</div>
        <h3 class="gd-name">${signup ? '가입' : '로그인'}</h3>
        <label class="ga-field">아이디<input name="username" autocomplete="username" maxlength="20" required value="${escapeHtml(username)}" /></label>
        <label class="ga-field">비밀번호<input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="${PASSWORD_MIN}" maxlength="${PASSWORD_MAX}" required /></label>
        <p class="field-hint">${signup ? `아이디는 영문 소문자·숫자·밑줄 3–20자, 비밀번호는 ${PASSWORD_MIN}자 이상. 새 계정은 ${formatCr(STARTING_CREDITS)}로 시작합니다. 이 브라우저의 오프라인 기록은 옮겨지지 않습니다.` : '로그인하면 크레딧·스킨·장착·미션을 서버 계정에서 불러옵니다.'}</p>
        <p class="gd-note ga-error error" role="alert">${escapeHtml(message)}</p>
        <div class="gd-actions">
          <button type="button" class="btn ga-cancel">취소</button>
          <button type="submit" class="btn btn-primary ga-submit">${signup ? '가입' : '로그인'}</button>
        </div>
        <button type="button" class="ga-switch" data-to="${signup ? 'login' : 'signup'}">${signup ? '이미 계정이 있으면 로그인' : '계정이 없으면 가입'}</button>
      </form>`;
    const form = this.dialog.querySelector('form')!;
    form.querySelector('.ga-cancel')!.addEventListener('click', () => this.close());
    form.querySelector('.ga-switch')!.addEventListener('click', () => this.renderForm(signup ? 'login' : 'signup', '', (form.elements.namedItem('username') as HTMLInputElement).value));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit(kind, form);
    });
    form.querySelector<HTMLInputElement>(username ? 'input[name="password"]' : 'input[name="username"]')!.focus();
  }

  private async submit(kind: 'login' | 'signup', form: HTMLFormElement): Promise<void> {
    if (this.busy) return;
    const username = (form.elements.namedItem('username') as HTMLInputElement).value.trim();
    const pw = form.elements.namedItem('password') as HTMLInputElement;
    this.busy = true;
    for (const b of form.querySelectorAll('button')) b.disabled = true;
    form.querySelector('.ga-error')!.textContent = '';
    form.querySelector('.ga-submit')!.textContent = '처리 중…';
    let r: AuthResult;
    try {
      r = kind === 'signup' ? await this.session.signup(username, pw.value) : await this.session.login(username, pw.value);
    } finally {
      this.busy = false;
      pw.value = '';
    }
    if (!r.ok) return this.renderForm(kind, authMessage(r.error), username);
    const notice = await this.session.offlineNotice();
    if (!notice) return this.close();
    this.dialog.innerHTML = `
      <div class="gd-panel ga-panel">
        <div class="eyebrow">GRID 계정</div>
        <h3 class="gd-name">오프라인 기록은 옮겨지지 않습니다</h3>
        <p class="gd-note ga-notice">이 브라우저의 오프라인 기록(크레딧 ${formatCr(notice.credits)}, 스킨 ${notice.items}개)은 서버가 검증할 수 없어 계정으로 옮기지 않습니다. 오프라인 기록은 지워지지 않으며, 로그아웃하면 다시 표시됩니다.</p>
        <div class="gd-actions ga-one"><button type="button" class="btn btn-primary ga-ack">확인</button></div>
      </div>`;
    const ack = this.dialog.querySelector<HTMLButtonElement>('.ga-ack')!;
    ack.addEventListener('click', () => {
      this.session.acknowledgeNotice();
      this.close();
    });
    ack.focus();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
