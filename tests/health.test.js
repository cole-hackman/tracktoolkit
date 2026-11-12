import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import request from 'supertest';

const { createHealthHandler, readBuildCommit } = await import('../server/lib/build-info.js');

const SHA = 'a'.repeat(40);

function appWith(commit) {
  const app = express();
  app.get('/health', createHealthHandler(commit));
  return app;
}

function buildInfoFile(contents) {
  const path = join(mkdtempSync(join(tmpdir(), 'build-info-')), 'build-info.json');
  writeFileSync(path, contents);
  return path;
}

describe('GET /health', () => {
  test('answers 200 with status, an ISO timestamp and the deployed commit', async () => {
    const res = await request(appWith(SHA)).get('/health');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['commit', 'status', 'timestamp']);
    expect(res.body.status).toBe('ok');
    expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
    expect(res.body.commit).toBe(SHA);
  });

  test('reports commit null when the build did not record one', async () => {
    const res = await request(appWith(null)).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.commit).toBeNull();
  });
});

describe('readBuildCommit', () => {
  test('reads the commit the workflow wrote', () => {
    expect(readBuildCommit(buildInfoFile(JSON.stringify({ commit: SHA })))).toBe(SHA);
  });

  test('is null for a missing file, bad JSON or something that is not a full SHA', () => {
    expect(readBuildCommit(join(tmpdir(), 'no-such-build-info.json'))).toBeNull();
    expect(readBuildCommit(buildInfoFile('not json'))).toBeNull();
    expect(readBuildCommit(buildInfoFile(JSON.stringify({ commit: 'abc123' })))).toBeNull();
    expect(readBuildCommit(buildInfoFile(JSON.stringify({})))).toBeNull();
  });
});
