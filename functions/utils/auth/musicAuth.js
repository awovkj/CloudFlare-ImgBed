import { fetchOthersConfig } from '../sysConfig.js';
import { validateSession } from './sessionManager.js';

const denied = (state) => ({ state, authorized: false, authType: null });
const authorized = (authType) => ({ state: 'authorized', authorized: true, authType });

export async function getMusicAccessState(env, request) {
    try {
        const othersConfig = await fetchOthersConfig(env);
        if (othersConfig?.__configSource === 'fallback') {
            return denied('config_unavailable');
        }

        const musicConfig = othersConfig?.musicPlayer || {};
        if (!musicConfig.enabled) {
            return denied('disabled');
        }
        if (!musicConfig.passwordHash) {
            return denied('password_missing');
        }

        const adminSession = await validateSession(env, request, 'admin');
        if (adminSession.valid) {
            return authorized('admin');
        }

        const musicSession = await validateSession(env, request, 'music');
        if (musicSession.valid) {
            return authorized('music');
        }

        return denied('unauthorized');
    } catch (error) {
        console.error('Failed to determine Music access state:', error);
        return denied('config_unavailable');
    }
}
