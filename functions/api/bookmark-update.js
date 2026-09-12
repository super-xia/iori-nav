// functions/api/bookmark-update.js
// 通过 API 远程修改已有书签（site）的所有字段：名称、URL、logo、描述、分类、排序、私有状态。
// 认证使用 KV 中的 `admin_api`（API Key）与 `admin_username`（用户名）：
//   - KV key `admin_api`      -> 存 API Key 值
//   - KV key `admin_username` -> 存关联用户名（二者必须在同一 KV namespace，即 NAV_AUTH）
// 请求需携带：Authorization: Bearer <admin_api 的值>
import { errorResponse, jsonResponse, markHomeCacheDirty, timingSafeEqual } from '../_middleware';
import { normalizeUrlForStorage, getUrlMatchCandidates, buildFaviconUrl, normalizeSortOrder } from '../lib/utils';
import {
  normalizeBookmarkName,
  normalizeOptionalBookmarkUrl,
  normalizeBookmarkLogo,
  normalizeBookmarkDesc
} from '../lib/validators';

/**
 * 校验 API Key：请求头 `Authorization: Bearer <key>` 需与 KV `admin_api` 值一致，
 * 且 KV `admin_username` 必须已存在（二者配套使用）。
 */
async function isApiKeyAuthenticated(request, env) {
  const expectedKey = await env.NAV_AUTH.get('admin_api');
  if (!expectedKey) return false;

  // admin_username 必须在同一 KV namespace 中已配置
  const configuredUsername = await env.NAV_AUTH.get('admin_username');
  if (!configuredUsername) return false;

  const authHeader = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) return false;

  const providedKey = match[1].trim();
  if (!providedKey) return false;

  return timingSafeEqual(providedKey, expectedKey);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!(await isApiKeyAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  try {
    const body = await request.json();
    const { id, name, url, logo, desc, catelog_id, sort_order, is_private } = body;

    if (!id) {
      return errorResponse('书签 ID 是必填的', 400);
    }

    const site = await env.NAV_DB.prepare(
      'SELECT * FROM sites WHERE id = ?'
    ).bind(id).first();

    if (!site) {
      return errorResponse('书签不存在', 404);
    }

    const iconAPI = env.ICON_API || 'https://faviconsnap.com/api/favicon?url=';
    const updates = {};
    const hasUpdate = [
      name, url, logo, desc, catelog_id, sort_order, is_private
    ].some(v => v !== undefined);

    if (!hasUpdate) {
      return errorResponse('至少需要提供一个要修改的字段', 400);
    }

    // 1. 书名 / 名称
    if (name !== undefined) {
      const result = normalizeBookmarkName(name);
      if (!result.ok) return errorResponse(result.message, 400);
      updates.name = result.value;
    }

    // 2. URL
    if (url !== undefined) {
      const result = normalizeOptionalBookmarkUrl(url);
      if (!result.ok) return errorResponse(result.message, 400);
      const sanitized = normalizeUrlForStorage(result.value || site.url);
      if (!sanitized) {
        return errorResponse('URL 必须是合法的 http 或 https 地址', 400);
      }
      // 检查 URL 是否与其他书签冲突（排除自身）
      const rawUrl = result.value || site.url;
      const candidates = getUrlMatchCandidates(rawUrl);
      const placeholders = candidates.map(() => '?').join(',');
      const conflict = await env.NAV_DB.prepare(
        `SELECT id FROM sites WHERE url IN (${placeholders}) AND id != ?`
      ).bind(...candidates, id).first();
      if (conflict) {
        return errorResponse('该 URL 已被其他书签使用', 409);
      }
      updates.url = sanitized;
    }

    // 3. Logo —— 仅当显式传 logo 或 url 变更时重建 favicon（未传则保持原 logo 不变）
    if (logo !== undefined || url !== undefined) {
      const logoValue = logo !== undefined ? logo : site.logo;
      const urlValue = url !== undefined ? (updates.url || site.url) : site.url;
      const logoResult = normalizeBookmarkLogo(logoValue, { nullIfEmpty: true });
      if (!logoResult.ok) return errorResponse(logoResult.message, 400);
      updates.logo = buildFaviconUrl(urlValue, logoResult.value, iconAPI);
    }

    // 4. 描述 —— 仅当传入时才修改
    if (desc !== undefined) {
      const result = normalizeBookmarkDesc(desc, { nullIfEmpty: true });
      if (!result.ok) return errorResponse(result.message, 400);
      updates.desc = result.value;
    }

    // 5. 分类
    let newCatelogName = site.catelog_name;
    if (catelog_id !== undefined) {
      const targetCategory = await env.NAV_DB.prepare(
        'SELECT catelog, is_private FROM category WHERE id = ?'
      ).bind(catelog_id).first();
      if (!targetCategory) {
        return errorResponse('分类不存在', 400);
      }
      updates.catelog_id = parseInt(catelog_id, 10);
      newCatelogName = targetCategory.catelog;
      updates.catelog_name = newCatelogName;

      // 目标分类是私有时，强制该书签也为私有
      if (targetCategory.is_private === 1) {
        updates.is_private = 1;
      }
    }

    // 6. 排序
    if (sort_order !== undefined) {
      updates.sort_order = normalizeSortOrder(sort_order);
    }

    // 7. 私有状态（仅当明确传且未因分类被强制私有）
    if (is_private !== undefined && updates.is_private === undefined) {
      updates.is_private = is_private ? 1 : 0;
    }

    // 组装 UPDATE
    const setClauses = [];
    const bindValues = [];
    const allowedCols = ['name', 'url', 'logo', 'desc', 'catelog_id', 'catelog_name', 'sort_order', 'is_private'];
    for (const col of allowedCols) {
      if (col in updates) {
        setClauses.push(`${col} = ?`);
        bindValues.push(updates[col]);
      }
    }
    setClauses.push('update_time = CURRENT_TIMESTAMP');
    bindValues.push(id);

    await env.NAV_DB.prepare(
      `UPDATE sites SET ${setClauses.join(', ')} WHERE id = ?`
    ).bind(...bindValues).run();

    // 判定缓存失效范围
    const finalPrivate = updates.is_private !== undefined ? updates.is_private : site.is_private;
    await markHomeCacheDirty(env, finalPrivate === 1 ? 'private' : 'all');

    return jsonResponse({
      code: 200,
      message: '书签更新成功',
      data: { id, ...updates }
    });
  } catch (e) {
    console.error('Error updating bookmark:', e);
    return errorResponse(`更新书签失败：${e.message}`, 500);
  }
}