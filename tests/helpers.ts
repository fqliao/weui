import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config, publicError } from '../packages/config/src/index.ts';
export const budget = {
  timeoutMs: 600000,
  maxActions: 100,
  maxModelCalls: 60,
  maxTokens: 150000,
  maxCostUsd: 1,
};
export class Client {
  cookie = '';
  async call(route: string, method = 'GET', body?: unknown, expected = 200, attempt = 0): Promise<any> {
    const response = await fetch(config.API_ORIGIN + '/api' + route, {
      method,
      headers: { 'content-type': 'application/json', cookie: this.cookie, origin: config.WEB_ORIGIN },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 429 && expected !== 429 && attempt < 3) {
      await response.arrayBuffer();
      await new Promise((r) =>
        setTimeout(
          r,
          Math.min(60000, Math.max(1000, Number(response.headers.get('retry-after') || 1) * 1000)),
        ),
      );
      return this.call(route, method, body, expected, attempt + 1);
    }
    const text = await response.text();
    let result: any;
    try {
      result = JSON.parse(text);
    } catch {
      result = text;
    }
    assert.equal(response.status, expected, `${method} ${route}: ${publicError(text)}`);
    const cookie = response.headers.get('set-cookie');
    if (cookie) this.cookie = cookie.split(';')[0];
    return result;
  }
  async login(tester = false) {
    return this.call('/auth/login', 'POST', {
      email: process.env[tester ? 'BOOTSTRAP_TESTER_EMAIL' : 'BOOTSTRAP_ADMIN_EMAIL'],
      password: process.env[tester ? 'BOOTSTRAP_TESTER_PASSWORD' : 'BOOTSTRAP_ADMIN_PASSWORD'],
    });
  }
  async plan(goal: string, extra: Record<string, unknown> = {}) {
    const task = await this.call('/tasks', 'POST', {
      projectId: 'sample-project',
      environmentId: 'sample-environment',
      knowledgeReleaseId: 'sample-knowledge-v1',
      goal,
      mode: 'catalog',
      budget,
      ...extra,
    });
    await this.call(`/tasks/${task.id}/plans`, 'POST', {});
    return this.planned(task.id);
  }
  async planned(id: string) {
    return poll(async () => {
      const task = await this.call(`/tasks/${id}`);
      if (task.status === 'ERROR') throw new Error(`Planning: ${task.error}`);
      return task.status === 'AWAITING_APPROVAL' ? task : null;
    }, 150000);
  }
  async submit(task: any, extra: Record<string, unknown> = {}) {
    return this.call(`/tasks/${task.id}/runs`, 'POST', {
      revision: task.revision,
      idempotencyKey: randomUUID(),
      ...extra,
    });
  }
  async finished(id: string) {
    return poll(async () => {
      const run = await this.call(`/runs/${id}`);
      return ['COMPLETED', 'ERROR', 'CANCELLED'].includes(run.status) ? run : null;
    }, 600000);
  }
  async run(goal: string, extra: Record<string, unknown> = {}) {
    return this.finished((await this.submit(await this.plan(goal, extra))).id);
  }
  async environment(fault: string, delayMs = 0) {
    return this.call('/admin/environments', 'POST', {
      projectId: 'sample-project',
      name: `验证-${fault}-${randomUUID().slice(0, 6)}`,
      baseUrl: config.SAMPLE_ORIGIN,
      fault,
      delayMs,
    });
  }
}
export async function poll<T>(fn: () => Promise<T | null | false>, timeout = 30000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Polling exceeded ${timeout}ms`);
}
