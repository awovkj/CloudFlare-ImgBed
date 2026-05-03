import { fetchSecurityConfig } from '../../utils/sysConfig.js';
import { verifyPassword } from '../../utils/auth/passwordHash.js';
import { createSession } from '../../utils/auth/sessionManager.js';

export async function onRequestPost(context) {
    const { request, env } = context;
    const { username, password } = await request.json();

    const securityConfig = await fetchSecurityConfig(env);
    const adminUsername = securityConfig.auth.admin.adminUsername;
    const adminPassword = securityConfig.auth.admin.adminPassword;

    const usernameConfigured = !!(adminUsername && adminUsername.trim());
    const passwordConfigured = !!(adminPassword && adminPassword.trim());

    if (!usernameConfigured && !passwordConfigured) {
        const { cookie } = await createSession(env, 'admin');
        return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Set-Cookie': cookie,
            },
        });
    }

    if (usernameConfigured && username !== adminUsername) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    if (passwordConfigured) {
        const passwordMatch = await verifyPassword(password, adminPassword);
        if (!passwordMatch) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
            });
        }
    }

    const { cookie } = await createSession(env, 'admin', usernameConfigured ? adminUsername : '');
    return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': cookie,
        },
    });
}
