import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
process.env.NODE_ENV = 'test';
const { createApp, createDb } = await import('../server.js');
const app = createApp(createDb(':memory:'));
describe('Pulsewatch API', () => {
  it('returns service overview', async () => {
    const r = await request(app).get('/api/overview');
    assert.equal(r.status, 200);
    assert.equal(r.body.monitors.length, 4);
    assert.equal(r.body.overall, 'unknown');
  });
  it('adds monitor', async () => {
    const r = await request(app)
      .post('/api/monitors')
      .send({ name: 'Payments', url: 'https://memorim.github.io/health-owned-test' });
    assert.equal(r.status, 201);
  });
  it('updates health state', async () => {
    const r = await request(app).patch('/api/monitors/1').send({ status: 'down', responseMs: 0 });
    assert.equal(r.status, 200);
  });
});

describe('Input validation and missing records', () => {
  it('rejects invalid input', async () => {
    assert.equal((await request(app).post('/api/monitors').send({})).status, 400);
  });
  it('returns 404 for a missing record', async () => {
    assert.equal(
      (await request(app).patch('/api/monitors/999').send({ status: 'down', responseMs: 0 }))
        .status,
      404,
    );
  });
});
