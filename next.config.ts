import os from 'node:os';
import type { NextConfig } from 'next';

// プライベートIPv4アドレスかどうかを判定
function isPrivateIPv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number);

  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

// PCが使用しているプライベートIPv4アドレスを取得
const allowedDevOrigins = Object.values(os.networkInterfaces())
  .flatMap((interfaces) => interfaces ?? [])
  .filter(
    (network) =>
      network.family === 'IPv4' &&
      !network.internal &&
      isPrivateIPv4(network.address)
  )
  .map((network) => network.address);

const nextConfig: NextConfig = {
  allowedDevOrigins,
};

export default nextConfig;