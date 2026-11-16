-- 文件表按 storagePath 反查引用：彻底删除 / 清空回收站 / 覆盖上传时要确认
-- 同一份内容寻址文件是否还被其它资源引用。此前无索引，每次都是全表扫描。
--
-- 带上 resourceId、sizeBytes 组成覆盖索引：反查引用只取这两列，仪表盘的存储
-- 占用统计按 storagePath 分组求和也取这两列。单列索引会让该分组查询改为沿
-- 索引逐行回表（实测 34ms -> 190ms），三列后重新变成覆盖扫描。
CREATE INDEX "resource_files_storagePath_resourceId_sizeBytes_idx"
  ON "resource_files"("storagePath", "resourceId", "sizeBytes");
