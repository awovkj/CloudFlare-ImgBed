import { fetchSecurityConfig } from '../sysConfig.js';
import { validateApiToken } from '../tokenValidator.js';
import { getDatabase } from '../databaseAdapter.js';
import { verifyPassword } from './passwordHash.js';
import { validateSession } from './sessionManager.js';

export const AUTH_SCOPE = {
    ADMIN: 'admin',
    USER: 'user',
    EITHER: 'either',
};

const AUTHORIZED = (authType) => ({ authorized: true, authType });
const UNAUTHORIZED = { authorized: false, authType: null };

async function checkAdmin({ env, request, adminConfigured }) {
    if (!adminConfigured) {
        return AUTHORIZED('admin');
    }

    const session = await validateSession(env, request, 'admin');
    if (session.valid) {
        return AUTHORIZED('admin');
    }

    return null;
}

async function checkUser({ env, request, url, authCodeConfigured, userAuthCode }) {
    const adminSession = await validateSession(env, request, 'admin');
    if (adminSession.valid) {
        return AUTHORIZED('admin');
    }

    const userSession = await validateSession(env, request, 'user');
    if (userSession.valid) {
        return AUTHORIZED('user');
    }

    if (!authCodeConfigured) {
        return AUTHORIZED('user');
    }

    if (url) {
        const authCode = extractAuthCode(url, request);
        if (authCode && await verifyPassword(authCode, userAuthCode)) {
            return AUTHORIZED('user');
        }
    }

    return UNAUTHORIZED;
}

export async function authenticate({
    env,
    request,
    url = null,
    requiredPermission = null,
    authScope = AUTH_SCOPE.EITHER,
}) {
    const securityConfig = await fetchSecurityConfig(env);
    const adminUsername = securityConfig.auth.admin.adminUsername;
    const adminPassword = securityConfig.auth.admin.adminPassword;
    const userAuthCode = securityConfig.auth.user.authCode;

    const adminConfigured = !!(adminUsername && adminUsername.trim()) || !!(adminPassword && adminPassword.trim());
    const authCodeConfigured = !!(userAuthCode && userAuthCode.trim());

    const tokenResult = await validateApiToken(request, getDatabase(env), requiredPermission);
    if (tokenResult.valid) {
        return AUTHORIZED('admin');
    }

    const adminCtx = { env, request, adminConfigured };
    const userCtx = { env, request, url, authCodeConfigured, userAuthCode };

    if (authScope === AUTH_SCOPE.ADMIN) {
        return (await checkAdmin(adminCtx)) || UNAUTHORIZED;
    }

    if (authScope === AUTH_SCOPE.USER) {
        return checkUser(userCtx);
    }

    const adminResult = await checkAdmin(adminCtx);
    if (adminResult?.authorized) {
        return adminResult;
    }

    return checkUser(userCtx);
}

function extractAuthCode(url, request) {
    let authCode = url.searchParams.get('authCode');

    if (!authCode) {
        const referer = request.headers.get('Referer');
        if (referer) {
            try {
                const refererUrl = new URL(referer);
                authCode = new URLSearchParams(refererUrl.search).get('authCode');
            } catch (error) {
                console.error('Invalid referer URL:', error);
            }
        }
    }

    if (!authCode) {
        authCode = request.headers.get('authCode');
    }

    if (!authCode) {
        const cookies = request.headers.get('Cookie');
        if (cookies) {
            const match = cookies.match(new RegExp('(^| )authCode=([^;]+)'));
            authCode = match ? decodeURIComponent(match[2]) : null;
        }
    }

    return authCode;
}
