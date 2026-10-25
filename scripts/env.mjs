import {existsSync} from 'node:fs';

export function loadEnv() {
  if (existsSync('.env')) process.loadEnvFile('.env');
}

export async function cloudflare(path, options = {}) {
  loadEnv();
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error('.envにCLOUDFLARE_ACCOUNT_IDとCLOUDFLARE_API_TOKENを設定してください');
  }
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    headers: {Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json', ...options.headers},
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json();
  if (!response.ok || !data.success) {
    const error=new Error(`Cloudflare API ${response.status} (${(data.errors ?? []).map(x => x.code).join(',')})`);
    error.status=response.status;
    error.codes=(data.errors??[]).map(x=>x.code);
    error.accessNotEnabled=(data.errors??[]).some(x=>String(x.message).includes('access.api.error.not_enabled'));
    throw error;
  }
  return data.result;
}
