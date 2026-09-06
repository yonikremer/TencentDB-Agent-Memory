import { describe, it, expect } from 'vitest';
import { isNotInScopeAction, ALLOWED_PANEL_ACTIONS, META_LIST_ACTIONS } from '../../src/panel/api/meta-actions.js';
import { isAllowedSkillAction, ALLOWED_SKILL_ACTIONS, SKILL_LIST_ACTIONS } from '../../src/panel/api/skill-actions.js';

describe('meta-actions', () => {
  it('isNotInScopeAction detects agent-fixed-asset prefix', () => {
    expect(isNotInScopeAction('agent-fixed-asset/list')).toBe(true);
    expect(isNotInScopeAction('user/list')).toBe(false);
    expect(isNotInScopeAction('')).toBe(false);
  });
  it('ALLOWED_PANEL_ACTIONS excludes not-in-scope', () => {
    expect(ALLOWED_PANEL_ACTIONS.has('user/create')).toBe(true);
    expect(ALLOWED_PANEL_ACTIONS.has('agent-fixed-asset/set')).toBe(false);
    expect(ALLOWED_PANEL_ACTIONS.has('auth/verify')).toBe(true);
  });
  it('META_LIST_ACTIONS contains list endpoints', () => {
    expect(META_LIST_ACTIONS.has('user/list')).toBe(true);
    expect(META_LIST_ACTIONS.has('user/create')).toBe(false);
  });
});

describe('skill-actions', () => {
  it('isAllowedSkillAction', () => {
    expect(isAllowedSkillAction('create')).toBe(true);
    expect(isAllowedSkillAction('files/write')).toBe(true);
    expect(isAllowedSkillAction('bogus')).toBe(false);
  });
  it('exposes sets', () => {
    expect(ALLOWED_SKILL_ACTIONS.size).toBeGreaterThan(0);
    expect(SKILL_LIST_ACTIONS.has('list')).toBe(true);
    expect(SKILL_LIST_ACTIONS.has('versions')).toBe(true);
  });
});