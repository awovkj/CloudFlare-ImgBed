/**
 * Hugging Face Hub API 封装类
 * 手动实现 LFS 上传协议（Cloudflare Workers 兼容）
 * 
 * HuggingFace 要求二进制文件通过 LFS 协议上传
 * 流程：preupload -> LFS batch -> upload to LFS storage -> commit
 * 
 * 优化方案：
 * 1. 小文件（<20MB）：前端 → CF Workers → HuggingFace S3
 * 2. 大文件（>=20MB）：前端直接上传到 HuggingFace S3，CF Workers 只负责获取签名 URL 和提交
 * 
 * SHA256 由前端预计算传入，避免后端 CPU 超时
 */

export class HuggingFaceAPI {
    constructor(token, repo, isPrivate = false) {
        this.token = token;
        this.repo = repo;  // 格式: username/repo-name
        this.isPrivate = isPrivate;
        this.baseURL = 'https://huggingface.co';
    }

    /**
     * 计算文件的 SHA256 哈希（仅在未提供预计算哈希时使用）
     * @param {Blob} blob 
     * @returns {Promise<string>} hex string
     */
    async sha256(blob) {
        const buffer = await blob.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * 检查仓库是否存在
     */
    async repoExists() {
        try {
            const response = await fetch(`${this.baseURL}/api/datasets/${this.repo}`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            return response.ok;
        } catch (error) {
            console.error('Error checking repo:', error.message);
            return false;
        }
    }

    /**
     * 创建仓库（如果不存在）
     */
    async createRepoIfNotExists() {
        try {
            if (await this.repoExists()) {
                return true;
            }

            const response = await fetch(`${this.baseURL}/api/repos/create`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: this.repo.split('/')[1],
                    type: 'dataset',
                    private: this.isPrivate
                })
            });

            if (response.ok || response.status === 409) {
                return true;
            }
            
            const errorText = await response.text();
            throw new Error(`Failed to create repo: ${response.status} - ${errorText}`);
        } catch (error) {
            console.error('Error creating repo:', error.message);
            return false;
        }
    }

    /**
     * 步骤1: Preupload - 检查文件是否需要 LFS
     */
    async preupload(filePath, fileSize, fileSample) {
        const url = `${this.baseURL}/api/datasets/${this.repo}/preupload/main`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                files: [{
                    path: filePath,
                    size: fileSize,
                    sample: fileSample
                }]
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Preupload failed: ${response.status} - ${error}`);
        }

        return await response.json();
    }

    /**
     * 步骤2: LFS Batch - 获取上传 URL
     */
    async lfsBatch(oid, fileSize) {
        const url = `${this.baseURL}/datasets/${this.repo}.git/info/lfs/objects/batch`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Accept': 'application/vnd.git-lfs+json',
                'Content-Type': 'application/vnd.git-lfs+json'
            },
            body: JSON.stringify({
                operation: 'upload',
                transfers: ['basic', 'multipart'],
                hash_algo: 'sha_256',
                ref: { name: 'main' },
                objects: [{ oid, size: fileSize }]
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`LFS batch failed: ${response.status} - ${error}`);
        }

        return await response.json();
    }

    /**
     * 步骤3: 上传文件到 LFS 存储
     * @param {object} uploadAction - 上传动作信息
     * @param {File|Blob} file - 文件
     * @param {string} oid - 文件的 SHA256 哈希
     */
    async uploadToLFS(uploadAction, file, oid) {
        const { href, header } = uploadAction;

        // 检查是否是分片上传
        if (header?.chunk_size) {
            return await this.uploadMultipart(uploadAction, file, oid);
        }

        // 基本上传
        const response = await fetch(href, {
            method: 'PUT',
            headers: header || {},
            body: file
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`LFS upload failed: ${response.status} - ${error}`);
        }

        return true;
    }

    /**
     * 分片上传（大文件）
     * @param {object} uploadAction - 上传动作信息
     * @param {File|Blob} file - 文件
     * @param {string} oid - 文件的 SHA256 哈希
     */
    async uploadMultipart(uploadAction, file, oid) {
        const { header } = uploadAction;
        const chunkSize = parseInt(header.chunk_size);
        const partUrls = this.getMultipartPartUrls(uploadAction);

        const partNumbers = Object.keys(partUrls)
            .map(part => Number(part))
            .filter(part => Number.isInteger(part) && part > 0)
            .sort((a, b) => a - b);

        const concurrency = Math.min(4, partNumbers.length);
        const completeParts = [];
        let currentIndex = 0;

        const uploadPart = async (partNumber) => {
            const start = (partNumber - 1) * chunkSize;
            const end = Math.min(start + chunkSize, file.size);
            const chunk = file.slice(start, end);

            const response = await fetch(partUrls[String(partNumber)], {
                method: 'PUT',
                body: chunk
            });

            if (!response.ok) {
                throw new Error(`Failed to upload part ${partNumber}: ${response.status}`);
            }

            const etag = response.headers.get('ETag');
            if (!etag) {
                throw new Error(`No ETag for part ${partNumber}`);
            }

            completeParts.push({ partNumber, etag });
        };

        const workers = Array.from({ length: concurrency }, async () => {
            while (currentIndex < partNumbers.length) {
                const partNumber = partNumbers[currentIndex];
                currentIndex += 1;
                await uploadPart(partNumber);
            }
        });

        await Promise.all(workers);
        completeParts.sort((a, b) => a.partNumber - b.partNumber);

        return await this.completeMultipartUpload(uploadAction, oid, completeParts);
    }

    getMultipartPartUrls(uploadAction) {
        const header = uploadAction?.header || {};
        return Object.fromEntries(
            Object.entries(header).filter(([key, value]) => /^[0-9]+$/.test(key) && typeof value === 'string' && value)
        );
    }

    getMultipartCompletionMetadata(uploadAction) {
        const header = uploadAction?.header || {};
        return Object.fromEntries(
            Object.entries(header).filter(([key, value]) => !/^[0-9]+$/.test(key) && key !== 'chunk_size' && typeof value === 'string' && value)
        );
    }

    normalizeMultipartParts(multipartParts) {
        if (!Array.isArray(multipartParts) || multipartParts.length === 0) {
            throw new Error('Missing multipart parts');
        }

        return multipartParts.map((part, index) => {
            const rawPartNumber = part?.partNumber ?? part?.PartNumber ?? part?.number;
            const rawEtag = part?.etag ?? part?.ETag ?? part?.eTag;
            const partNumber = Number(rawPartNumber);

            if (!Number.isInteger(partNumber) || partNumber <= 0) {
                throw new Error(`Invalid multipart part number at index ${index}`);
            }

            if (typeof rawEtag !== 'string' || rawEtag.trim() === '') {
                throw new Error(`Missing multipart ETag for part ${partNumber}`);
            }

            return {
                partNumber,
                etag: rawEtag
            };
        }).sort((a, b) => a.partNumber - b.partNumber);
    }

    async getMultipartUploadAction(oid, fileSize) {
        const batchResult = await this.lfsBatch(oid, fileSize);
        const obj = batchResult.objects?.[0];

        if (obj?.error) {
            throw new Error(`LFS error: ${obj.error.message}`);
        }

        if (!obj?.actions?.upload) {
            throw new Error('Multipart upload action not found');
        }

        if (!obj.actions.upload?.header?.chunk_size) {
            throw new Error('Upload action is not multipart');
        }

        return obj.actions.upload;
    }

    async completeMultipartUpload(uploadAction, oid, multipartParts) {
        const completionUrl = uploadAction?.href;
        if (!completionUrl) {
            throw new Error('Missing multipart completion URL');
        }

        const normalizedParts = this.normalizeMultipartParts(multipartParts);
        const completionMetadata = this.getMultipartCompletionMetadata(uploadAction);

        const completeResponse = await fetch(completionUrl, {
            method: 'POST',
            headers: {
                'Accept': 'application/vnd.git-lfs+json',
                'Content-Type': 'application/vnd.git-lfs+json'
            },
            body: JSON.stringify({
                oid,
                parts: normalizedParts,
                ...completionMetadata
            })
        });

        if (!completeResponse.ok) {
            const error = await completeResponse.text();
            throw new Error(`Multipart complete failed: ${completeResponse.status} - ${error}`);
        }

        return true;
    }

    /**
     * 步骤4: 提交 LFS 文件引用
     */
    async commitLfsFile(filePath, oid, fileSize, commitMessage) {
        const url = `${this.baseURL}/api/datasets/${this.repo}/commit/main`;
        
        // NDJSON 格式
        const body = [
            JSON.stringify({
                key: 'header',
                value: { summary: commitMessage }
            }),
            JSON.stringify({
                key: 'lfsFile',
                value: {
                    path: filePath,
                    algo: 'sha256',
                    size: fileSize,
                    oid: oid
                }
            })
        ].join('\n');

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/x-ndjson'
            },
            body
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Commit failed: ${response.status} - ${error}`);
        }

        return await response.json();
    }

    /**
     * 获取 LFS 上传信息（用于前端直传大文件）
     * 返回上传 URL 和必要的信息，让前端直接上传到 S3
     * @param {number} fileSize - 文件大小
     * @param {string} filePath - 存储路径
     * @param {string} sha256 - 文件的 SHA256 哈希
     * @param {string} fileSample - 文件前512字节的 base64
     */
    async getLfsUploadInfo(fileSize, filePath, sha256, fileSample) {
        // 确保仓库存在
        if (!await this.createRepoIfNotExists()) {
            throw new Error('Failed to create or access repository');
        }

        // 1. Preupload 检查
        const preuploadResult = await this.preupload(filePath, fileSize, fileSample);

        const fileInfo = preuploadResult.files?.[0];
        const needsLfs = fileInfo?.uploadMode === 'lfs';

        if (!needsLfs) {
            // 小文件不需要 LFS，返回 null 让后端处理
            return { needsLfs: false };
        }

        // 2. LFS Batch - 获取上传 URL
        const batchResult = await this.lfsBatch(sha256, fileSize);

        const obj = batchResult.objects?.[0];
        if (obj?.error) {
            throw new Error(`LFS error: ${obj.error.message}`);
        }

        // 检查文件是否已存在
        if (!obj?.actions?.upload) {
            return {
                needsLfs: true,
                alreadyExists: true,
                oid: sha256,
                filePath
            };
        }

        // 返回上传信息
        return {
            needsLfs: true,
            alreadyExists: false,
            oid: sha256,
            filePath,
            uploadAction: obj.actions.upload,
            isMultipart: Boolean(obj.actions.upload?.header?.chunk_size),
            multipartChunkSize: obj.actions.upload?.header?.chunk_size
        };
    }

    /**
     * 上传文件（完整流程）- 用于小文件或后端代理上传
     * @param {File|Blob} file - 要上传的文件
     * @param {string} filePath - 存储路径
     * @param {string} commitMessage - 提交信息
     * @param {string} precomputedSha256 - 前端预计算的 SHA256（可选，传入可避免后端计算）
     */
    async uploadFile(file, filePath, commitMessage = 'Upload file', precomputedSha256 = null) {
        try {
            // 确保仓库存在
            if (!await this.createRepoIfNotExists()) {
                throw new Error('Failed to create or access repository');
            }

            // 1. 使用预计算的 SHA256 或在后端计算
            const oid = precomputedSha256 ?? await this.sha256(file);

            // 2. 获取文件样本（前512字节的base64）
            const sampleBytes = new Uint8Array(await file.slice(0, 512).arrayBuffer());
            const sample = btoa(String.fromCharCode(...sampleBytes));

            // 3. Preupload 检查
            const preuploadResult = await this.preupload(filePath, file.size, sample);

            const fileInfo = preuploadResult.files?.[0];
            const needsLfs = fileInfo?.uploadMode === 'lfs';

            if (needsLfs) {
                // 4. LFS Batch - 获取上传 URL
                const batchResult = await this.lfsBatch(oid, file.size);

                const obj = batchResult.objects?.[0];
                if (obj?.error) {
                    throw new Error(`LFS error: ${obj.error.message}`);
                }

                // 5. 上传到 LFS 存储（如果需要）
                if (obj?.actions?.upload) {
                    await this.uploadToLFS(obj.actions.upload, file, oid);
                }

                // 6. 提交 LFS 文件引用
                await this.commitLfsFile(filePath, oid, file.size, commitMessage);
            } else {
                // 非 LFS 文件：直接 base64 提交（小文本文件）
                await this.commitDirectFile(filePath, file, commitMessage);
            }

            const fileUrl = `${this.baseURL}/datasets/${this.repo}/resolve/main/${filePath}`;
            return {
                success: true,
                filePath,
                fileUrl,
                fileSize: file.size,
                oid
            };

        } catch (error) {
            console.error('HuggingFace upload error:', error.message);
            throw error;
        }
    }

    /**
     * 直接提交文件（非 LFS，用于小文本文件）
     */
    async commitDirectFile(filePath, file, commitMessage) {
        const url = `${this.baseURL}/api/datasets/${this.repo}/commit/main`;
        
        const content = btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
        
        const body = [
            JSON.stringify({
                key: 'header',
                value: { summary: commitMessage }
            }),
            JSON.stringify({
                key: 'file',
                value: {
                    path: filePath,
                    content: content,
                    encoding: 'base64'
                }
            })
        ].join('\n');

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/x-ndjson'
            },
            body
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Direct commit failed: ${response.status} - ${error}`);
        }

        return await response.json();
    }

    /**
     * 删除文件
     */
    async deleteFile(filePath, commitMessage = 'Delete file') {
        const url = `${this.baseURL}/api/datasets/${this.repo}/commit/main`;
        
        const body = [
            JSON.stringify({
                key: 'header',
                value: { summary: commitMessage }
            }),
            JSON.stringify({
                key: 'deletedFile',
                value: { path: filePath }
            })
        ].join('\n');

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/x-ndjson'
            },
            body
        });

        return response.ok;
    }

    /**
     * 获取文件内容（用于私有仓库代理）
     */
    async getFileContent(filePath) {
        const fileUrl = `${this.baseURL}/datasets/${this.repo}/resolve/main/${filePath}`;
        return await fetch(fileUrl, {
            headers: this.isPrivate ? { 'Authorization': `Bearer ${this.token}` } : {}
        });
    }

    /**
     * 获取文件 URL
     */
    getFileURL(filePath) {
        return `${this.baseURL}/datasets/${this.repo}/resolve/main/${filePath}`;
    }
}
