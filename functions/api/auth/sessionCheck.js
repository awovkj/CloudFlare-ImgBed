import { validateAnySession } from '../../utils/auth/sessionManager.js';
import { fetchSecurityConfig } from '../../utils/sysConfig.js';

export async function onRequestGet(context) {
    const { request, env } = context;
    const securityConfig = await fetchSecurityConfig(env);
    const adminUsername = securityConfig.auth.admin.adminUsername;
    const adminPassword = securityConfig.auth.admin.adminPassword;
    const userAuthCode = securityConfig.auth.user.authCode;

    const adminRequired = !!(adminUsername && adminUsername.trim()) || !!(adminPassword && adminPassword.trim());
    const userRequired = !!(userAuthCode && userAuthCode.trim());

    const sessionResult = await validateAnySession(env, request);
    if (sessionResult.valid) {
        return new Response(JSON.stringify({
            valid: true,
            authType: sessionResult.session.authType,
            adminRequired,
            userRequired,
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    return new Response(JSON.stringify({
        valid: false,
        adminRequired,
        userRequired,
    }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}
