import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldSkipScheduledRun } from '../src/taskrunner/dedup.ts'
import type { RunState } from '../src/taskrunner/steps.ts'

const NOW = Date.parse('2026-11-21T09:00:00+08:00')

function state(overrides: Partial<RunState> = {}): RunState {
  return {
    uid: 'u1',
    plan: 'daily',
    queue: [],
    done: [
      { code: '_probe', action: 'listTasks', ok: true, detail: '' },
      { code: 'checkin', action: 'checkin', ok: true, detail: '' },
    ],
    finished: true,
    lastError: '',
    startedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

test('今天同一计划全部成功 ⇒ 跳过（防重复烧配额）', () => {
  assert.equal(shouldSkipScheduledRun({ status: state(), plan: 'daily', now: NOW + 3_600_000 }), true)
})

test('🔴 今天同一计划失败过 ⇒ 不跳过，允许 21:00 重试', () => {
  const failed = state({
    done: [
      { code: '_probe', action: 'listTasks', ok: true, detail: '' },
      { code: 'checkin', action: 'checkin', ok: false, detail: 'upstream 401' },
    ],
    lastError: 'upstream 401',
  })
  assert.equal(shouldSkipScheduledRun({ status: failed, plan: 'daily', now: NOW + 12 * 3_600_000 }), false)
})

test('失败只写在 lastError、done 全 ok 时也不得跳过', () => {
  const failed = state({ lastError: '最后一步异常' })
  assert.equal(shouldSkipScheduledRun({ status: failed, plan: 'daily', now: NOW + 1 }), false)
})

test('昨天跑完的同计划不跳过；不同计划不跳过；未完成不跳过；无状态不跳过', () => {
  const yesterday = state({ startedAt: NOW - 24 * 3_600_000, updatedAt: NOW - 24 * 3_600_000 })
  assert.equal(shouldSkipScheduledRun({ status: yesterday, plan: 'daily', now: NOW }), false)
  assert.equal(shouldSkipScheduledRun({ status: state(), plan: 'growth', now: NOW }), false)
  assert.equal(shouldSkipScheduledRun({ status: state({ finished: false }), plan: 'daily', now: NOW }), false)
  assert.equal(shouldSkipScheduledRun({ status: undefined, plan: 'daily', now: NOW }), false)
})
