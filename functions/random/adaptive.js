const MOBILE_UA_REGEX = /Mobile|Android|iPhone|iPad|iPod|webOS|BlackBerry|Opera Mini|IEMobile/i;

export function detectDevice(request) {
    const viewportWidth = request.headers.get('Sec-CH-Viewport-Width');
    const viewportHeight = request.headers.get('Sec-CH-Viewport-Height');

    if (viewportWidth !== null && viewportHeight !== null) {
        const width = Number(viewportWidth);
        const height = Number(viewportHeight);

        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
            return {
                source: 'client-hints',
                viewportRatio: width / height,
            };
        }
    }

    const userAgent = request.headers.get('User-Agent');
    if (userAgent) {
        const isMobile = MOBILE_UA_REGEX.test(userAgent);
        return {
            source: 'user-agent',
            deviceType: isMobile ? 'mobile' : 'desktop',
        };
    }

    return { source: null };
}

export function resolveOrientation(deviceInfo) {
    if (deviceInfo.source === 'client-hints') {
        const ratio = deviceInfo.viewportRatio;
        if (ratio > 1.1) {
            return 'landscape';
        }
        if (ratio < 0.9) {
            return 'portrait';
        }
        return 'square';
    }

    if (deviceInfo.source === 'user-agent') {
        if (deviceInfo.deviceType === 'mobile') {
            return 'portrait';
        }
        if (deviceInfo.deviceType === 'desktop') {
            return 'landscape';
        }
    }

    return '';
}

export function addClientHintsHeaders(headers) {
    headers.set('Accept-CH', 'Sec-CH-Viewport-Width, Sec-CH-Viewport-Height');

    const varyValues = ['Sec-CH-Viewport-Width', 'Sec-CH-Viewport-Height', 'User-Agent'];
    const existingVary = headers.get('Vary');

    if (existingVary) {
        const existingValues = existingVary.split(',').map((value) => value.trim().toLowerCase());
        const newValues = varyValues.filter((value) => !existingValues.includes(value.toLowerCase()));
        if (newValues.length > 0) {
            headers.set('Vary', `${existingVary}, ${newValues.join(', ')}`);
        }
    } else {
        headers.set('Vary', varyValues.join(', '));
    }

    return headers;
}
