import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheChanges, cacheViews, editCache } from '../../packages/executor/src/cache-review.ts';
import { CACHE_VERSION, type CacheArtifact } from '../../packages/executor/src/cache-artifact.ts';
const fp = { url: 'https://example.test/', dom: 'dom', image: 'image' };
function fixture(): CacheArtifact {
  return {
    version: CACHE_VERSION,
    channels: {
      case: {
        operations: [
          {
            key: 'one',
            kind: 'tap',
            commands: [{ kind: 'Tap', selector: '#submit', before: fp }],
            before: fp,
            after: fp,
            complete: true,
          },
          { key: 'two', kind: 'assert', commands: [], before: fp, after: fp, complete: true, passed: true },
        ],
        nativeByOperation: {
          one: {
            cacheId: 'c',
            midsceneVersion: '1.12.6',
            caches: [
              { type: 'locate', prompt: 'password SUPER-SECRET', cache: { xpaths: ['//*[@id="submit"]'] } },
              {
                type: 'plan',
                prompt: 'SUPER-SECRET',
                yamlWorkflow:
                  'flow:\n  - aiTap: Submit button\n  - aiInput: SUPER-SECRET\n    locate: Password field\n',
              },
            ],
          },
        },
      },
    },
  };
}
test('cache inspection masks matching context and values, but exposes editable XPath and planning locators', () => {
  const views = cacheViews(fixture(), 'L1');
  assert.ok(!JSON.stringify(views).includes('SUPER-SECRET'));
  assert.equal(views[0].fields.length, 3);
  const edits = views[0].fields
    .filter((f) => f.path.includes('workflow'))
    .map((f) => ({ path: f.path, value: f.value + ' updated' }));
  const edited = editCache(fixture(), 'L1', edits);
  assert.equal(edited.edited, true);
  assert.ok(edited.channels.case.operations.every((o) => !o.complete));
  const plan = edited.channels.case.nativeByOperation.one.caches[1] as any;
  assert.match(plan.yamlWorkflow, /Submit button updated/);
  assert.match(plan.yamlWorkflow, /Password field updated/);
  assert.match(plan.yamlWorkflow, /aiInput: SUPER-SECRET/);
});
test('L2 edits preserve operations and input/oracle; invalidate assertions and report exact selector diff', () => {
  const original = fixture(),
    view = cacheViews(original, 'L2');
  const edited = editCache(original, 'L2', [{ path: view[0].fields[0].path, value: '#save' }]);
  assert.equal(original.channels.case.operations[0].commands[0].selector, '#submit');
  assert.equal(edited.channels.case.operations[0].complete, true);
  assert.equal(edited.channels.case.operations[1].complete, false);
  assert.equal(edited.channels.case.operations[1].passed, true);
  const changes = cacheChanges(original, edited);
  assert.ok(
    changes.some(
      (c) => c.tier === 'L2' && c.path.endsWith('selector') && c.before === '#submit' && c.after === '#save',
    ),
  );
  assert.throws(() => editCache(original, 'L2', [{ path: 'case.operations.1.passed', value: 'true' }]), {
    code: 'CACHE_EDIT',
  });
  assert.throws(() => editCache(original, 'L1', [{ path: '__proto__.polluted', value: 'true' }]), {
    code: 'CACHE_EDIT',
  });
  assert.deepEqual(cacheChanges(original, structuredClone(original)), []);
  assert.throws(
    () =>
      editCache(original, 'L1', [
        { path: cacheViews(original, 'L1')[0].fields[0].path, value: 'input#query' },
      ]),
    { code: 'CACHE_EDIT' },
  );
  assert.deepEqual(editCache(original, 'L2', [{ path: view[0].fields[0].path, value: '#submit' }]), original);
});
test('protected native content changes are marked without disclosing the changed data', () => {
  const a = fixture(),
    b = fixture();
  (b.channels.case.nativeByOperation.one.caches[0] as any).prompt = 'NEW-SECRET';
  const diff = cacheChanges(a, b);
  assert.equal(diff.length, 1);
  assert.match(diff[0].path, /protectedContext/);
  assert.ok(!JSON.stringify(diff).includes('SECRET'));
});

test('semantic cache edits retain guards; diagnostic image changes do not change the executable contract', () => {
  const a = fixture();
  const command = a.channels.case.operations[0].commands[0];
  command.target = { by: 'role', role: 'button', value: '提交' };
  command.guard = { version: 1, url: fp.url, identity: { tag: 'button', text: '提交' } };
  const b = editCache(a, 'L2', [{ path: 'case.operations.0.commands.0.selector', value: '#new-submit' }]);
  assert.deepEqual(b.channels.case.operations[0].commands[0].target, { by: 'css', value: '#new-submit' });
  assert.deepEqual(b.channels.case.operations[0].commands[0].guard, command.guard);
  assert.throws(
    () => editCache(a, 'L2', [{ path: 'case.operations.0.commands.0.guard.identity.text', value: '删除' }]),
    { code: 'CACHE_EDIT' },
  );
  const c = structuredClone(a);
  c.channels.case.operations[0].before.image = 'dynamic-input';
  c.channels.case.operations[0].after.dom = 'dynamic-input';
  assert.deepEqual(cacheChanges(a, c), []);
});
