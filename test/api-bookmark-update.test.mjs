import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestPost } from '../functions/api/bookmark-update.js';

// Node 自带 WebCrypto 缺 timingSafeEqual，此处补一个与 Cloudflare 等价的实现（接收 Uint8Array）
if (!globalThis.crypto.subtle.timingSafeEqual) {
  globalThis.crypto.subtle.timingSafeEqual = (left, right) => {
    if (left.byteLength !== right.byteLength) return false;
    let diff = 0;
    for (let i = 0; i < left.byteLength; i += 1) {
      diff |= left[i] ^ right[i];
    }
    return diff === 0;
  };
}

const API_KEY = 'test-secret-key';
const USERNAME = 'admin';
const SITE = {
  id: 1,
  name: '旧名称',
  url: 'https://example.com',
  logo: 'https://example.com/favicon.ico',
  desc: '旧描述',
  catelog_id: 1,
  catelog_name: '工具',
  sort_order: 5,
  is_private: 0,
};

/**
 * 构造 mock env：NAV_AUTH 提供 admin_api / admin_username；NAV_DB 提供 prepare/bind/first/run/all。
 * 记录每一次 prepare 的 SQL 与其 bind 参数，便于断言。
 */
function createEnv({ siteRow = SITE, siteExists = true, categoryRow = null } = {}) {
  const dbCalls = [];
  const fakeStatement = (sql) => {
    const stmt = {
      bind(...params) {
        return {
          async first() {
            dbCalls.push({ sql, kind: 'first', params });
            // URL 冲突检查（SELECT id FROM sites WHERE url IN）应返回空，表示无冲突
            if (/WHERE url IN/.test(sql)) return null;
            // 书签存在性检查
            if (/SELECT \* FROM sites WHERE id/.test(sql)) return siteExists ? siteRow : null;
            return siteRow;
          },
          async run() {
            dbCalls.push({ sql, kind: 'run', params });
            return { changes: 1 };
          },
          async all() {
            dbCalls.push({ sql, kind: 'all', params });
            return { results: [siteRow] };
          },
        };
      },
    };
    return stmt;
  };

  // SELECT 返回分类行，其余（SELECT 书签、UPDATE）可由调用方指定
  const env = {
    NAV_AUTH: {
      async get(key) {
        if (key === 'admin_api') return API_KEY;
        if (key === 'admin_username') return USERNAME;
        return null;
      },
    },
    NAV_DB: {
      prepare(sql) {
        if (/FROM category WHERE id/.test(sql)) {
          return {
            bind(...params) {
              dbCalls.push({ sql, kind: 'category', params });
              return {
                async first() {
                  return categoryRow;
                },
              };
            },
          };
        }
        return fakeStatement(sql);
      },
    },
    ICON_API: 'https://faviconsnap.com/api/favicon?url=',
  };
  return { env, dbCalls };
}

function post(env, { key = API_KEY, body = {} } = {}) {
  const headers = {};
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  const request = new Request('https://example.com/api/bookmark-update', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return onRequestPost({ request, env });
}

test('无 Authorization 头返回 401', async () => {
  const { env } = createEnv();
  const res = await post(env, { key: null, body: { id: 1 } });
  assert.equal(res.status, 401);
});

test('错误的 API Key 返回 401', async () => {
  const { env } = createEnv();
  const res = await post(env, { key: 'wrong-key', body: { id: 1 } });
  assert.equal(res.status, 401);
});

test('缺少 id 返回 400', async () => {
  const { env } = createEnv();
  const res = await post(env, { body: { name: '新名称' } });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.message, /书签 ID 是必填的/);
});

test('至少一个字段未提供返回 400', async () => {
  const { env } = createEnv();
  const res = await post(env, { body: { id: 1 } });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.message, /至少需要提供一个/);
});

test('书签不存在返回 404', async () => {
  const { env } = createEnv({ siteExists: false });
  const res = await post(env, { body: { id: 999, name: '新名称' } });
  assert.equal(res.status, 404);
});

test('修改全部字段：名称、URL、描述、排序、私有 → 200 且 UPDATE 包含对应列', async () => {
  const { env, dbCalls } = createEnv({ categoryRow: { catelog: '新分类', is_private: 0 } });
  const res = await post(env, {
    body: {
      id: 1,
      name: '新名称',
      url: 'https://new.example.com',
      desc: '新描述',
      catelog_id: 2,
      sort_order: 1,
      is_private: 1,
    },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.code, 200);
  assert.equal(body.data.name, '新名称');
  assert.equal(body.data.catelog_name, '新分类');

  const update = dbCalls.find(c => c.kind === 'run');
  assert.ok(update, '应执行一次 UPDATE');
  const sql = update.sql;
  for (const col of ['name', 'url', 'logo', 'desc', 'catelog_id', 'catelog_name', 'sort_order', 'is_private']) {
    assert.ok(sql.includes(`${col} = ?`), `UPDATE 应包含列 ${col}`);
  }
  // 最后一个绑定值是 id
  assert.equal(update.params.at(-1), 1);
});

test('目标分类为私有时，强制书签私有', async () => {
  const { env } = createEnv({ categoryRow: { catelog: '私密分类', is_private: 1 } });
  const res = await post(env, { body: { id: 1, catelog_id: 2 } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.is_private, 1);
});

// 仅修改一个字段时，返回的 data 只包含被修改的字段（url/desc/logo 未改，故不在 data 中）
test('仅修改单个字段时 data 只含改动字段', async () => {
  const { env, dbCalls } = createEnv();
  const res = await post(env, { body: { id: 1, name: '只改名' } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.name, '只改名');
  assert.equal(body.data.url, undefined);
  assert.equal(body.data.desc, undefined);
});