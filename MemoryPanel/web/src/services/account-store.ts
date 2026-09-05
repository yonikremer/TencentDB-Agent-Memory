/**
 * account-store.ts — Demo-stage local account table (local localStorage).
 *
 * Extracted from the original demoStore.ts.
 *
 * email → { username, password, isAdmin } local account system, for the old version
 * Username and password login in use. Link A (new panel Control) has switched to user_key authentication,
 * This account system is retained only for historical compatibility (the `addTeamMember` `requireAccount` validation
 Still uses findAccountByUsername).
 *
 * Replace with the actual user center API after the backend goes live.
 */

import i18n from '@/i18n';

const ACCOUNTS_KEY = 'tdai-memory.accounts.v1';

/**
 * Generate a 12-digit random password to be used as a fallback when creating mock accounts (used when the user does not explicitly fill it in).
 * This is for demo purposes only and does not carry real credentials — but avoid hardcoding the weak password `123123` into the bundle.
 */
function genRandomPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 12; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

export interface MockAccount {
  email: string;
  username: string;
  password: string;
  isAdmin: boolean;
  description?: string;
}

function getDefaultAccounts(): MockAccount[] {
  // Empty seed: no real usernames/passwords are hardcoded anymore.
  // Historically, this listed 6 internal employee English names + weak password `123123` (which would be bundled into frontend JS,
  // so customers could see it when opening devtools on the image → employee identity leakage). The remote version changed it to
  // generic pseudonyms like alice/bob but still kept `123123`; this version continues to be completely empty — users build their own as needed.
  // Link A has switched to user_key authentication, and this mock only serves `addTeamMember`'s findAccountByUsername.
  return [];
}

function writeAccountsRaw(accounts: MockAccount[]): void {
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  } catch {
    /* ignore */
  }
}

function readAccounts(): MockAccount[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    if (!raw) {
      // First use: write the hardcoded seed account to localStorage
      const seeds = getDefaultAccounts();
      writeAccountsRaw(seeds);
      return seeds;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      const seeds = getDefaultAccounts();
      writeAccountsRaw(seeds);
      return seeds;
    }
    return parsed.filter(
      (a): a is MockAccount => a && typeof a.email === 'string' && typeof a.username === 'string' && typeof a.password === 'string'
    );
  } catch {
    const seeds = getDefaultAccounts();
    writeAccountsRaw(seeds);
    return seeds;
  }
}

/** Find account by email (case insensitive) */
export function findAccountByEmail(email: string): MockAccount | null {
  const e = email.trim().toLowerCase();
  return readAccounts().find((a) => a.email.toLowerCase() === e) ?? null;
}

/** Query account with username */
export function findAccountByUsername(username: string): MockAccount | null {
  return readAccounts().find((a) => a.username === username) ?? null;
}

/** Validate email + password login */
export function verifyAccountCredentials(email: string, password: string): MockAccount {
  const e = email.trim().toLowerCase();
  if (!e) throw new Error(i18n.t('account.error.emailRequired'));
  if (!password) throw new Error(i18n.t('account.error.passwordRequired'));
  const account = readAccounts().find((a) => a.email.toLowerCase() === e);
  if (!account) throw new Error(i18n.t('account.error.accountNotFound', { email: e }));
  if (account.password !== password) throw new Error(i18n.t('account.error.passwordIncorrect'));
  return account;
}

/** Create a single account (admin exclusive permission, permission validation is at the UI layer).
 *   Username allows duplicates, email is globally unique. */
export function createAccount(input: { email: string; username: string; password?: string; isAdmin?: boolean; description?: string }): MockAccount {
  const e = input.email.trim().toLowerCase();
  if (!e) throw new Error(i18n.t('account.error.emailEmpty'));
  if (!input.username.trim()) throw new Error(i18n.t('account.error.usernameEmpty'));
  const accounts = readAccounts();
  if (accounts.some((a) => a.email.toLowerCase() === e)) {
    throw new Error(i18n.t('account.error.emailExists', { email: input.email }));
  }
  const account: MockAccount = {
    email: input.email.trim(),
    username: input.username.trim(),
    // fallback random password - avoid hardcoded weak passwords; can be removed when switching to real user center
    password: input.password || genRandomPassword(),
    isAdmin: input.isAdmin ?? false,
    description: input.description?.trim() || undefined,
  };
  writeAccountsRaw([...accounts, account]);
  return account;
}

/** Batch create accounts */
export function batchCreateAccounts(
  entries: Array<{ email: string; username: string; description?: string }>
): { created: MockAccount[]; errors: Array<{ email: string; error: string }> } {
  const created: MockAccount[] = [];
  const errors: Array<{ email: string; error: string }> = [];
  const accounts = readAccounts();
  const emailSet = new Set(accounts.map((a) => a.email.toLowerCase()));

  for (const entry of entries) {
    const e = entry.email.trim().toLowerCase();
    const u = entry.username.trim();
    if (!e || !u) {
      errors.push({ email: entry.email || i18n.t('account.error.emptyPlaceholder'), error: i18n.t('account.error.emailAndUsernameEmpty') });
      continue;
    }
    if (emailSet.has(e)) {
      errors.push({ email: entry.email, error: i18n.t('account.error.emailRegistered') });
      continue;
    }
    const account: MockAccount = {
      email: entry.email.trim(),
      username: u,
      password: genRandomPassword(),
      isAdmin: false,
      description: entry.description?.trim() || undefined,
    };
    emailSet.add(e);
    accounts.push(account);
    created.push(account);
  }

  if (created.length > 0) {
    writeAccountsRaw(accounts);
  }
  return { created, errors };
}

/** Change Password */
export function changePassword(username: string, oldPassword: string, newPassword: string): void {
  if (!oldPassword) throw new Error(i18n.t('account.error.currentPasswordRequired'));
  if (!newPassword) throw new Error(i18n.t('account.error.newPasswordRequired'));
  if (newPassword.length < 4) throw new Error(i18n.t('account.error.passwordTooShort'));
  const accounts = readAccounts();
  const account = accounts.find((a) => a.username === username);
  if (!account) throw new Error(i18n.t('account.error.accountNotFoundByUsername', { username }));
  if (account.password !== oldPassword) throw new Error(i18n.t('account.error.currentPasswordIncorrect'));
  account.password = newPassword;
  writeAccountsRaw(accounts);
}

/**
 * Admin directly sets any user's password (no old password required).
 * Permission verification is at the UI layer (only admin can call it).
 */
export function setAccountPassword(username: string, newPassword: string): void {
  if (!newPassword) throw new Error(i18n.t('account.error.newPasswordRequired'));
  if (newPassword.length < 4) throw new Error(i18n.t('account.error.passwordTooShort'));
  if (!username) throw new Error(i18n.t('account.error.usernameEmpty'));
  const accounts = readAccounts();
  const account = accounts.find((a) => a.username === username);
  if (!account) throw new Error(i18n.t('account.error.accountNotFoundByUsername', { username }));
  account.password = newPassword;
  writeAccountsRaw(accounts);
}

/** Modify user email (admin exclusive permission, permission check is at the UI layer) */
export function updateAccountEmail(username: string, newEmail: string): void {
  const e = newEmail.trim().toLowerCase();
  if (!e) throw new Error(i18n.t('account.error.emailEmpty'));
  if (!username) throw new Error(i18n.t('account.error.usernameEmpty'));
  const accounts = readAccounts();
  const account = accounts.find((a) => a.username === username);
  if (!account) throw new Error(i18n.t('account.error.accountNotFoundByUsername', { username }));
  // Check if the email has already been used by someone else
  const conflict = accounts.find((a) => a.email.toLowerCase() === e && a.username !== username);
  if (conflict) throw new Error(i18n.t('account.error.emailUsedByOther', { email: newEmail.trim() }));
  account.email = newEmail.trim();
  writeAccountsRaw(accounts);
}

/** Get all account list (admin can see all, regular users can only see themselves) */
export function getAllAccounts(): MockAccount[] {
  return readAccounts();
}
