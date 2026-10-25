import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
import {authenticate} from '../src/auth.js';

const {publicKey,privateKey}=await generateKeyPair('RS256');
const jwks=createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'test',alg:'RS256'}]});
const issuer='https://test.cloudflareaccess.com';
async function token(claims={},options={}){return new SignJWT({email:'admin@example.test',sub:'verified-subject',...claims}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(options.issuer??issuer).setAudience(options.aud??'application-aud').setIssuedAt().setExpirationTime(options.exp??'5m').sign(privateKey);}
function env(operator={id:'admin',email:'admin@example.test',access_subject:'verified-subject',role:'admin',active:1}){
  return {ENVIRONMENT:'production',ACCESS_TEAM_DOMAIN:'test.cloudflareaccess.com',ACCESS_AUD:'application-aud',DB:{prepare(){return {bind(){return this;},async first(){return operator?.active?operator:null;}};}}};
}
const request=jwt=>new Request('https://example.test/api/admin/me',{headers:jwt?{'Cf-Access-Jwt-Assertion':jwt}:{}});
test('Accessの署名・issuer・audience・期限を検証する',async()=>{
  const operator=await authenticate(request(await token()),env(),jwks);assert.equal(operator.id,'admin');
  for(const jwt of ['not-a-jwt',await token({}, {issuer:'https://other.example'}),await token({}, {aud:'other-app'}),await token({}, {exp:'0s'})]){
    await assert.rejects(()=>authenticate(request(jwt),env(),jwks),error=>error.status===401);
  }
  await assert.rejects(()=>authenticate(request(),env(),jwks),error=>error.status===401);
});
test('有効なJWTでも停止済み・未招待・異なるsubjectを拒否する',async()=>{
  const jwt=await token();
  for(const operator of [null,{active:0},{active:1,access_subject:'someone-else'}])await assert.rejects(()=>authenticate(request(jwt),env(operator),jwks),error=>error.status===403);
});
test('サービス認証は設定済みの検証環境だけに限定する',async()=>{
  const jwt=await token({email:'',sub:'',common_name:'test-client.access'});
  const operator={id:'service',email:'e2e@invalid.test',access_subject:'service:test-client.access',role:'editor',active:1};
  const staging={...env(operator),ENVIRONMENT:'staging',E2E_SERVICE_CLIENT_ID:'test-client.access'};
  assert.equal((await authenticate(request(jwt),staging,jwks)).id,'service');
  await assert.rejects(()=>authenticate(request(jwt),{...staging,ENVIRONMENT:'production'},jwks),error=>error.status===403);
  await assert.rejects(()=>authenticate(request(jwt),{...staging,E2E_SERVICE_CLIENT_ID:'other'},jwks),error=>error.status===403);
});
