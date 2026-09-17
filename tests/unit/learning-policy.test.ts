import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEARNING_VERSION,
  shouldRetryLearning,
  type CheckLearning,
} from '../../packages/executor/src/learned-check.ts';

test('compiler retries distinguish invalid output from unsupported semantics and stay bounded', () => {
  const refusal: CheckLearning = {
    version: LEARNING_VERSION,
    status: 'unsupported',
    reason: 'format',
    retryable: true,
    attempts: 1,
  };
  assert.equal(shouldRetryLearning(undefined), true);
  assert.equal(shouldRetryLearning(refusal), true);
  assert.equal(shouldRetryLearning({ ...refusal, attempts: 2 }), false);
  assert.equal(shouldRetryLearning({ ...refusal, retryable: false }), false);
  assert.equal(shouldRetryLearning({ ...refusal, version: LEARNING_VERSION - 1, retryable: false }), true);
  assert.equal(shouldRetryLearning({ ...refusal, attempts: 2 }, true), true);
});
