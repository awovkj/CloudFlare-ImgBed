import { authenticate, AUTH_SCOPE } from './auth/authCore.js';

export async function dualAuthCheck(env, url, request) {
    return authenticate({
        env,
        request,
        url,
        requiredPermission: null,
        authScope: AUTH_SCOPE.EITHER,
    });
}
