import { fetchSecurityConfig } from "../../utils/sysConfig";
import { checkDatabaseConfig } from "../../utils/middleware";
import { validateApiToken } from "../../utils/auth/tokenValidator.js";
import { getDatabase } from "../../utils/databaseAdapter.js";
import { validateSession } from '../../utils/auth/sessionManager.js';
import { verifyPassword } from '../../utils/auth/passwordHash.js';
import { createJsonResponse, createNoStoreTextResponse, createTextResponse } from "../../utils/response.js";
import { verifyTempLinkReceipt } from "../../upload/tempLinkReceipt.js";

let securityConfig = {}
let basicUser = ""
let basicPass = ""
let securityConfigLoadedAt = 0
const SECURITY_CONFIG_TTL_MS = 5000

async function errorHandling(context) {
  try {
    return await context.next();
  } catch (err) {
    console.error('Manage API unhandled error:', err);
    return createJsonResponse({
      error: 'Internal server error'
    }, {
      status: 500,
      headers: {
        ...corsHeaders,
        'Cache-Control': 'no-store'
      }
    });
  }
}

function basicAuthentication(request) {
  const Authorization = request.headers.get('Authorization');
  if (!Authorization) {
    return BadRequestException('Missing authorization header.');
  }

  const [scheme, encoded] = Authorization.split(' ');

  // The Authorization header must start with Basic, followed by a space.
  if (!encoded || scheme !== 'Basic') {
    return BadRequestException('Malformed authorization header.');
  }

  // Decodes the base64 value and performs unicode normalization.
  // @see https://datatracker.ietf.org/doc/html/rfc7613#section-3.3.2 (and #section-4.2.2)
  // @see https://dev.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/String/normalize
  const buffer = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  const decoded = new TextDecoder().decode(buffer).normalize();

  // The username & password are split by the first colon.
  //=> example: "username:password"
  const index = decoded.indexOf(':');

  // The user & password are split by the first colon and MUST NOT contain control characters.
  // @see https://tools.ietf.org/html/rfc5234#appendix-B.1 (=> "CTL = %x00-1F / %x7F")
  if (index === -1 || /[\0-\x1F\x7F]/.test(decoded)) {
    return BadRequestException('Invalid authorization value.');
  }

  return {
    user: decoded.substring(0, index),
    pass: decoded.substring(index + 1),
  };
}

function UnauthorizedException(reason) {
  return createNoStoreTextResponse(reason, 401, 'Unauthorized');
}

function BadRequestException(reason) {
  return createNoStoreTextResponse(reason, 400, 'Bad Request');
}

function isSecurityConfigExpired(now) {
  return now - securityConfigLoadedAt > SECURITY_CONFIG_TTL_MS;
}

async function refreshSecurityConfigIfNeeded(env, now = Date.now()) {
  if (!isSecurityConfigExpired(now)) {
    return securityConfig;
  }

  securityConfig = await fetchSecurityConfig(env);
  basicUser = securityConfig?.auth?.admin?.adminUsername || "";
  basicPass = securityConfig?.auth?.admin?.adminPassword || "";
  securityConfigLoadedAt = now;
  return securityConfig;
}


/**
 * 根据请求路径提取所需权限
 * API Token 仅授予 upload/list/delete 三种细粒度权限，用于程序化的文件读写。
 * 其余管理端点（rename/move/metadata/block/white/sysConfig/apiTokens 等）属于
 * 管理员专属操作，必须 fail-closed：默认要求 token 不具备的 'admin' 权限，
 * 从而拒绝任何 API Token，只允许 session/basic 管理员认证通过，防止权限提升。
 * @param {string} pathname - 请求路径
 * @returns {string} 需要的权限类型
 */
function extractRequiredPermission(pathname) {
  // 提取路径中的关键部分
  const pathParts = pathname.toLowerCase().split('/');

  // 检查是否包含delete路径
  if (pathParts.includes('delete')) {
    return 'delete';
  }

  // 检查是否包含list路径
  if (pathParts.includes('list')) {
    return 'list';
  }

  // 其余管理端点默认要求管理员权限（token 无此权限，等同拒绝 token 访问）
  return 'admin';
}

/**
 * 临时链接端点的上传凭证放行
 * 仅当请求路径为 /api/manage/temp-link/{fileId} 且携带有效的 X-Upload-Receipt 头
 * （凭证与 fileId 匹配、未过期）时返回 true，绕过管理员鉴权。
 *
 * 这使得刚上传完成的文件可以在不登录管理员的情况下生成临时链接——凭证仅在上传成功时
 * 签发给上传者，绑定 fileId 且短 TTL，无法跨文件或长期滥用。
 */
async function tryTempLinkReceiptAccess(context, pathname) {
  if (!pathname.startsWith('/api/manage/temp-link/')) return false;

  const receipt = context.request.headers.get('X-Upload-Receipt');
  if (!receipt) return false;

  const pathPart = pathname.slice('/api/manage/temp-link/'.length);
  if (!pathPart) return false;

  let fileId;
  try {
    fileId = decodeURIComponent(pathPart).split(',').join('/');
  } catch (e) {
    return false;
  }

  return await verifyTempLinkReceipt(context.env, receipt, fileId);
}

// CORS 跨域响应头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, PUT, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

async function authentication(context) {
  // OPTIONS 预检请求不需要鉴权，直接返回 CORS 响应
  // 这是安全的，因为 OPTIONS 请求只是预检请求，不会执行任何实际操作
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  const pathname = new URL(context.request.url).pathname;
  if (pathname === '/api/manage/sysConfig/showStats') {
    return context.next();
  }

  // 临时链接端点：允许凭"上传凭证"访问，使刚上传完成的文件无需管理员登录即可生成临时链接。
  // 仅对 /api/manage/temp-link/{fileId} 生效，且凭证必须与路径中的 fileId 匹配。
  if (await tryTempLinkReceiptAccess(context, pathname)) {
    context.data.auth = { authType: 'user', method: 'upload-receipt' };
    return context.next();
  }

  await refreshSecurityConfigIfNeeded(context.env);

  const usernameConfigured = typeof basicUser !== 'undefined' && basicUser !== null && basicUser !== "";
  const passwordConfigured = typeof basicPass !== 'undefined' && basicPass !== null && basicPass !== "";
  const adminConfigured = usernameConfigured || passwordConfigured;

  if (!adminConfigured) {
    // 无需身份验证
    context.data.auth = { authType: 'admin', method: 'none' };
    return context.next();
  } else {
    const adminSession = await validateSession(context.env, context.request, 'admin');
    if (adminSession.valid) {
      context.data.auth = { authType: 'admin', method: 'session' };
      return context.next();
    }

    if (context.request.headers.has('Authorization')) {
      // 首先尝试使用API Token验证

      // 根据请求的 url 判断所需权限
      const requiredPermission = extractRequiredPermission(pathname);

      const db = getDatabase(context.env);
      const tokenValidation = await validateApiToken(context.request, db, requiredPermission);
      if (tokenValidation.valid) {
        // Token验证通过，继续处理请求
        context.data.auth = { authType: 'admin', method: 'api-token' };
        return context.next();
      }

      // 回退到使用传统身份认证方式
      const basicAuthResult = basicAuthentication(context.request);
      if (basicAuthResult instanceof Response) {
        return basicAuthResult;
      }

      const { user, pass } = basicAuthResult;
      const usernameValid = usernameConfigured ? basicUser === user : true;
      const passwordValid = passwordConfigured ? await verifyPassword(pass, basicPass) : true;
      if (!usernameValid || !passwordValid) {
        return UnauthorizedException('Invalid credentials.');
      } else {
        context.data.auth = { authType: 'admin', method: 'basic' };
        return context.next();
      }

    } else {
      // 要求客户端进行基本认证
        return createTextResponse('You need to login.', {
          status: 401,
          headers: {
            // Prompts the user for credentials.
            'WWW-Authenticate': 'Basic realm="my scope", charset="UTF-8"',
            // 'WWW-Authenticate': 'None',
          },
        });
     }

  }

}

export const onRequest = [checkDatabaseConfig, errorHandling, authentication];
