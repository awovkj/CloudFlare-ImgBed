/**
 * 密码哈希工具
 * 使用 Web Crypto API 的 PBKDF2 (100,000 iterations) + 盐值进行密码哈希
 * 向后兼容旧版 SHA-256 哈希和明文密码存储
 */

const HASH_PREFIX_SHA256 = '$sha256$';
const HASH_PREFIX_PBKDF2 = '$pbkdf2$';
const PBKDF2_ITERATIONS = 100000;

function generateSalt() {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
}

function bufferToHex(buffer) {
    return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(password, salt = null) {
    if (!salt) {
        salt = generateSalt();
    }

    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        'PBKDF2',
        false,
        ['deriveBits']
    );

    const derivedBits = await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            salt: hexToBytes(salt),
            iterations: PBKDF2_ITERATIONS,
            hash: 'SHA-256',
        },
        keyMaterial,
        256
    );

    return `${HASH_PREFIX_PBKDF2}${salt}$${bufferToHex(derivedBits)}`;
}

async function hashPasswordSHA256(password, salt) {
    const encoder = new TextEncoder();
    const data = encoder.encode(salt + password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return `${HASH_PREFIX_SHA256}${salt}$${bufferToHex(hashBuffer)}`;
}

export function isHashed(password) {
    return typeof password === 'string' && (
        password.startsWith(HASH_PREFIX_PBKDF2) ||
        password.startsWith(HASH_PREFIX_SHA256)
    );
}

export function needsRehash(password) {
    return typeof password === 'string' && password.startsWith(HASH_PREFIX_SHA256);
}

export async function verifyPassword(inputPassword, storedPassword) {
    if (!storedPassword || !inputPassword) {
        return false;
    }

    if (storedPassword.startsWith(HASH_PREFIX_PBKDF2)) {
        const parts = storedPassword.split('$');
        if (parts.length !== 4) {
            return false;
        }

        const expectedHash = await hashPassword(inputPassword, parts[2]);
        return timingSafeEqual(expectedHash, storedPassword);
    }

    if (storedPassword.startsWith(HASH_PREFIX_SHA256)) {
        const parts = storedPassword.split('$');
        if (parts.length !== 4) {
            return false;
        }

        const expectedHash = await hashPasswordSHA256(inputPassword, parts[2]);
        return timingSafeEqual(expectedHash, storedPassword);
    }

    return inputPassword === storedPassword;
}

function timingSafeEqual(a, b) {
    if (a.length !== b.length) {
        return false;
    }

    const encoder = new TextEncoder();
    const bufA = encoder.encode(a);
    const bufB = encoder.encode(b);
    let result = 0;

    for (let i = 0; i < bufA.length; i++) {
        result |= bufA[i] ^ bufB[i];
    }

    return result === 0;
}

export function generateSessionToken() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function rehashIfNeeded(db, plainPassword, storedPassword, configPath) {
    if (!storedPassword || (storedPassword.startsWith(HASH_PREFIX_PBKDF2) && !needsRehash(storedPassword))) {
        return;
    }

    try {
        const settingsStr = await db.get('manage@sysConfig@security');
        if (!settingsStr) {
            return;
        }

        const settings = JSON.parse(settingsStr);
        const keys = configPath.split('.');
        let target = settings;

        for (let i = 0; i < keys.length - 1; i++) {
            target = target?.[keys[i]];
        }

        if (!target) {
            return;
        }

        target[keys[keys.length - 1]] = await hashPassword(plainPassword);
        await db.put('manage@sysConfig@security', JSON.stringify(settings));
    } catch (error) {
        console.error(`Failed to rehash password at ${configPath}:`, error);
    }
}
