// Shared contract of the GRID account server (server/) and its browser
// client (AccountClient.ts): request rules and answer shapes only. No
// secrets, no server code: this file is part of the client bundle.

/** `GET /api/health` answer of a GRID account server (anything else = no server: offline mode). */
export const ACCOUNT_SERVICE = 'grid-account';

/** Lowercase letters, digits and `_`, 3–20 characters (compared in lower case). */
export const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

/** Header every changing request carries (with the cookie, a cross-site form cannot send it). */
export const CSRF_HEADER = 'x-grid-csrf';

export type AuthError =
  | 'invalid_username'
  | 'weak_password'
  | 'username_taken'
  /** Wrong user name or password (never says which). */
  | 'invalid_credentials'
  | 'rate_limited'
  | 'suspended'
  | 'unauthenticated'
  | 'invalid_request'
  | 'storage_error'
  | 'network';

/** The signed-in account (never a secret: no token, no hash). */
export interface AccountSummary {
  accountId: string;
  username: string;
  displayName: string;
  status: 'active' | 'suspended';
}

export type AuthResult = { ok: true; account: AccountSummary } | { ok: false; error: AuthError };

export interface HealthAnswer {
  service: typeof ACCOUNT_SERVICE;
  db: 'up' | 'down';
}

/** Why a user name / password pair cannot be used to sign up (null = it can). */
export function signupProblem(username: unknown, password: unknown): AuthError | null {
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username.toLowerCase())) return 'invalid_username';
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return 'weak_password';
  return null;
}

/** Korean message for an auth refusal. */
export function authMessage(error: AuthError): string {
  switch (error) {
    case 'invalid_username':
      return '아이디는 영문 소문자·숫자·밑줄 3–20자입니다.';
    case 'weak_password':
      return `비밀번호는 ${PASSWORD_MIN}–${PASSWORD_MAX}자입니다.`;
    case 'username_taken':
      return '이미 사용 중인 아이디입니다.';
    case 'invalid_credentials':
      return '아이디 또는 비밀번호가 맞지 않습니다.';
    case 'rate_limited':
      return '시도가 너무 많습니다. 15분 후 다시 시도하세요.';
    case 'suspended':
      return '정지된 계정입니다.';
    case 'unauthenticated':
      return '로그인이 필요합니다.';
    case 'invalid_request':
      return '잘못된 요청입니다.';
    case 'storage_error':
      return '서버 저장소 오류입니다. 잠시 후 다시 시도하세요.';
    case 'network':
      return '서버에 연결하지 못했습니다.';
  }
}
