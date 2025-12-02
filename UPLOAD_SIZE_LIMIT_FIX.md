# 文件上传大小限制修改说明 / Upload Size Limit Modification

## 问题描述 / Problem Description
上传2GB文件时提示"文件过大" / When uploading 2GB files, error message shows "file too large"

## 解决方案 / Solution
修改前端JavaScript代码中的文件大小限制，从1GB (1024MB) 提升到2GB (2048MB) / Modified the file size limit in frontend JavaScript code from 1GB (1024MB) to 2GB (2048MB)

## 修改的文件 / Modified Files
- `js/386.8ffc8be2.js` - 前端上传组件文件 / Frontend upload component file

## 具体修改 / Specific Changes

### 1. 文件大小检查 / File Size Check
- 修改前 / Before: `e.size/1024/1024<=1024` (1GB)
- 修改后 / After: `e.size/1024/1024<=2048` (2GB)

### 2. 压缩后文件大小检查 / Compressed File Size Check
- 修改前 / Before: `t.size/1024/1024>1024` (1GB)
- 修改后 / After: `t.size/1024/1024>2048` (2GB)

### 3. 提示信息 / Tooltip Message
- 修改前 / Before: "Telegram 渠道上传的文件大小不支持超过1GB"
- 修改后 / After: "Telegram 渠道上传的文件大小不支持超过2GB"

## 注意事项 / Important Notes

1. **分块上传**: 系统支持分块上传，对于超过20MB的文件会自动使用分块上传 / **Chunked Upload**: System supports chunked uploads. Files larger than 20MB will automatically use chunked upload.

2. **Telegram 渠道**: 修改只影响前端验证，Telegram API本身的限制仍然存在 / **Telegram Channel**: This change only affects frontend validation. Telegram API's own limits still apply.

3. **其他渠道**: CloudFlare R2 和 S3 渠道不受1GB限制影响，现在所有渠道统一支持2GB / **Other Channels**: CloudFlare R2 and S3 channels are not affected by the 1GB limit. Now all channels uniformly support 2GB.

4. **后端支持**: 后端代码已经支持通过分块上传处理大文件，无需修改 / **Backend Support**: Backend code already supports large file uploads through chunked upload, no modification needed.

## 测试建议 / Testing Recommendations

1. 测试上传1.5GB - 2GB之间的文件 / Test uploading files between 1.5GB - 2GB
2. 测试不同上传渠道 (Telegram, R2, S3) / Test different upload channels (Telegram, R2, S3)
3. 验证分块上传功能正常工作 / Verify chunked upload functionality works properly
4. 检查上传进度显示是否正确 / Check if upload progress display is correct

