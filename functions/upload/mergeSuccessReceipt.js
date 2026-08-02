export const MERGE_SUCCESS_RECEIPT_TTL_SECONDS = 60 * 60;

export function getMergeSuccessReceiptKey(uploadId) {
    return `upload_merge_result_${uploadId}`;
}

export async function getMergeSuccessReceipt(db, uploadId) {
    const receiptData = await db.get(getMergeSuccessReceiptKey(uploadId));
    return receiptData ? JSON.parse(receiptData) : null;
}

export async function persistMergeSuccessReceipt(db, uploadId, mergeResult, mergeJobId, now = Date.now) {
    const receipt = {
        uploadId,
        mergeJobId,
        mergeResult,
        completedAt: now()
    };
    await db.put(getMergeSuccessReceiptKey(uploadId), JSON.stringify(receipt), {
        expirationTtl: MERGE_SUCCESS_RECEIPT_TTL_SECONDS
    });
    return receipt;
}
