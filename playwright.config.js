import {defineConfig,devices} from '@playwright/test';
import {existsSync,readFileSync} from 'node:fs';

const remote=process.env.E2E_BASE_URL;
let extraHTTPHeaders={};
if(remote&&existsSync('.artifacts/access-staging.json')){
  const credentials=JSON.parse(readFileSync('.artifacts/access-staging.json','utf8'));
  extraHTTPHeaders={'CF-Access-Client-Id':credentials.clientId,'CF-Access-Client-Secret':credentials.clientSecret};
}
export default defineConfig({
  testDir:'./test/e2e',timeout:120_000,expect:{timeout:20_000},fullyParallel:false,workers:1,
  reporter:[['list'],['json',{outputFile:'.artifacts/e2e-results.json'}]],
  use:{baseURL:remote??'http://127.0.0.1:8787',extraHTTPHeaders,acceptDownloads:true,trace:'off',screenshot:'only-on-failure',actionTimeout:20_000,navigationTimeout:30_000},
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
  webServer:remote?undefined:{command:'npm run dev',url:'http://127.0.0.1:8787/api/health',reuseExistingServer:false,timeout:60_000},
});
