/**
 * Tag Management Helper Functions
 * Provides utilities for validating, normalizing, and managing tags
 */

/**
 * Validate tag format
 * Tags must contain only alphanumeric characters, underscores, and hyphens
 * @param {string} tag - The tag to validate
 * @returns {boolean} - Whether the tag is valid
 */
export function validateTag(tag) {
    if (!tag || typeof tag !== 'string') {
        return false;
    }

    // Allow alphanumeric, underscore, hyphen, and Chinese/Japanese/Korean characters
    return /^[\w\u4e00-\u9fa5\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af-]+$/.test(tag);
}

/**
 * Normalize tags
 * - Convert to lowercase
 * - Trim whitespace
 * - Remove duplicates
 * - Filter out invalid tags
 * @param {string[]} tags - Array of tags to normalize
 * @returns {string[]} - Normalized array of unique tags
 */
export function normalizeTags(tags) {
    if (!Array.isArray(tags)) {
        return [];
    }

    const normalized = tags
        .filter(tag => tag && typeof tag === 'string')
        .map(tag => tag.toLowerCase().trim())
        .filter(tag => validateTag(tag));

    // Remove duplicates while preserving order
    return [...new Set(normalized)];
}

/**
 * Merge tags based on action
 * @param {string[]} existingTags - Current tags on the file
 * @param {string[]} newTags - Tags to add/remove/set
 * @param {string} action - 'set', 'add', or 'remove'
 * @returns {string[]} - Merged tags array
 */
export function mergeTags(existingTags, newTags, action) {
    const existing = Array.isArray(existingTags) ? existingTags : [];
    const normalized = normalizeTags(newTags);

    switch (action) {
        case 'set':
            // Replace all tags with new tags
            return normalized;

        case 'add':
            // Add new tags to existing, remove duplicates
            return normalizeTags([...existing, ...normalized]);

        case 'remove':
            // Remove specified tags from existing
            const toRemove = new Set(normalized);
            return existing.filter(tag => !toRemove.has(tag.toLowerCase()));

        default:
            throw new Error(`Invalid action: ${action}. Must be 'set', 'add', or 'remove'`);
    }
}

/**
 * Filter tags by prefix (for autocomplete)
 * @param {string[]} tags - Array of all available tags
 * @param {string} prefix - Prefix to filter by
 * @param {number} limit - Maximum number of results
 * @returns {string[]} - Filtered tags
 */
export function filterTagsByPrefix(tags, prefix, limit = 20) {
    if (!Array.isArray(tags) || !prefix || typeof prefix !== 'string') {
        return [];
    }

    const prefixLower = prefix.toLowerCase().trim();

    return tags
        .filter(tag => tag.toLowerCase().startsWith(prefixLower))
        .slice(0, limit);
}
