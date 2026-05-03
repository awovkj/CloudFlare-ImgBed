import { fetchSecurityConfig } from '../../utils/sysConfig.js';
import { verifyPassword } from '../../utils/auth/passwordHash.js';
import { createSession } from '../../utils/auth/sessionManager.js';

export async function onRequestPost(context) {
    const { request, env } = context;
    const jsonRequest = await request.json();
    const authCode = jsonRequest.authCode;

    const securityConfig = await fetchSecurityConfig(env);
    const rightAuthCode = securityConfig.auth.user.authCode;

    if (rightAuthCode !== undefined && rightAuthCode !== '') {
        const isValid = await verifyPassword(authCode, rightAuthCode);
        if (!isValid) {
            return new Response('Unauthorized', { status: 401 });
        }
    }

    const { cookie } = await createSession(env, 'user');
    return new Response('Login success', {
        status: 200,
        headers: {
            'Set-Cookie': cookie,
        },
    });
}
