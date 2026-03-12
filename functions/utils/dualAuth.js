import { userAuthCheck } from './userAuth';
import { fetchSecurityConfig } from './sysConfig';
import { validateApiToken } from './tokenValidator';
import { getDatabase } from './databaseAdapter.js';

export async function dualAuthCheck(env, url, request) {
    const adminAuthPassed = await adminAuthCheck(env, request);
    if (adminAuthPassed) {
        return { authorized: true, authType: 'admin' };
    }

    const userAuthPassed = await userAuthCheck(env, url, request, null);
    if (userAuthPassed) {
        return { authorized: true, authType: 'user' };
    }

    return { authorized: false, authType: null };
}

async function adminAuthCheck(env, request) {
    const securityConfig = await fetchSecurityConfig(env);
    const basicUser = securityConfig.auth.admin.adminUsername;
    const basicPass = securityConfig.auth.admin.adminPassword;

    if (typeof basicUser === 'undefined' || basicUser === null || basicUser === '') {
        return true;
    }

    if (!request.headers.has('Authorization')) {
        return false;
    }

    const db = getDatabase(env);
    const tokenValidation = await validateApiToken(request, db, null);
    if (tokenValidation.valid) {
        return true;
    }

    try {
        const { user, pass } = parseBasicAuth(request);
        return user === basicUser && pass === basicPass;
    } catch {
        return false;
    }
}

function parseBasicAuth(request) {
    const auth = request.headers.get('Authorization');
    if (!auth) {
        throw new Error('No Authorization header');
    }

    const [scheme, encoded] = auth.split(' ');
    if (scheme !== 'Basic' || !encoded) {
        throw new Error('Invalid auth scheme');
    }

    const buffer = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(buffer).normalize();

    const index = decoded.indexOf(':');
    if (index === -1) {
        throw new Error('Invalid auth format');
    }

    return {
        user: decoded.substring(0, index),
        pass: decoded.substring(index + 1)
    };
}
