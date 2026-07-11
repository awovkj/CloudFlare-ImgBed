-- 添加 tags 字段到 files 表（仅用于 v2.2.1 之前创建、尚无 tags 字段的旧数据库）
--
-- ⚠️ 重要：请勿在由当前 database/init.sql 初始化的新数据库上执行本迁移。
-- 新库的 init.sql 基线已包含 tags 字段与 idx_files_tags 索引，重复执行
-- 下面的 ADD COLUMN 会因“duplicate column name: tags”报错。
--
-- 判断是否需要执行：
--   wrangler d1 execute <DB> --command "PRAGMA table_info(files);"
-- 输出中若已存在 tags 列，则跳过本迁移。

-- 仅在旧库（无 tags 列）上执行以下语句：
ALTER TABLE files ADD COLUMN tags TEXT;

-- 为 tags 字段创建索引（幂等）
CREATE INDEX IF NOT EXISTS idx_files_tags ON files(tags);

-- 说明：
-- tags 字段用于存储文件标签，格式为 JSON 数组
-- 例如：["风景", "旅行", "2024"]
