/**
 * Đọc biến môi trường của plugin: ưu tiên `ASK_JEV_<name>` (tên hiện tại), rồi
 * tới `JEV_<name>` (tên cũ, vẫn được đọc để tương thích ngược), cuối cùng mới
 * dùng fallback.
 */
export function env(name, fallback) {
  const value = process.env[`ASK_JEV_${name}`];
  if (value !== undefined) return value;
  const legacy = process.env[`JEV_${name}`];
  if (legacy !== undefined) return legacy;
  return fallback;
}
